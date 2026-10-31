#!/usr/bin/env python3
"""Capture real README footage of the running Spiral app over the Chrome DevTools Protocol.

Drives headless Chrome (SwiftShader WebGL) through the full demo flow:
landing -> "ask Raymer" cited answer -> Gemini intake reply -> design spiral (infeasible)
-> accept relaxation (converged) -> detailed spar CAD/FEA -> traceability report.

Outputs:
  docs/screens/00-ask-raymer.png                  (cited textbook answer, if /api/ask answers in 15 s)
  docs/screens/01-landing.png ... 06-report.png   (1440x900 PNG stills via Page.captureScreenshot)
  docs/demo.gif                                   (960 px wide, looping, adaptive palette, < 8 MB)

Motion frames come from Page.startScreencast (~5 fps under SwiftShader; a captureScreenshot
polling loop only manages ~2 fps there), falling back to polling if no screencast frames arrive.

Usage (app must already be running):
  .venv/bin/python scripts/capture_demo.py [--url http://localhost:8000] [--scratch DIR]

Selectors are discovered at runtime with fallbacks, so it tolerates both the chat-style
landing (#chat-input / #chat-send / .chat-run) and the older form (#prompt-input / #btn-parse).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import pickle
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parent.parent
SCREENS = ROOT / "docs" / "screens"
GIF_PATH = ROOT / "docs" / "demo.gif"
PROMPT = ("Four-seat tourer, London to New York non-stop, 5,570 km range, 45 min reserve, "
          "cruise 115 kt, stall under 55 kt.")
ASK_Q = "What tail volume coefficients suit a GA single?"
PORT = 9333
W, H = 1440, 900
GIF_WIDTH = 960
GIF_H = round(H * GIF_WIDTH / W)
MAX_FPS = 6          # GIF frames are thinned to at most this rate
HOLD_MS = 2600       # key-moment hold
GIF_MAX_BYTES = int(float(os.environ.get("CAPTURE_GIF_MAX_MB", "7.9")) * 1_000_000)
PALETTE_GROUP = {"landing": "chat", "ask": "chat", "reply": "chat", "spiral": "workspace", "converged": "workspace"}
NOISE = 20           # per-pixel change (max over RGB) below which the GIF keeps the previous pixel

T0 = time.monotonic()
REPORT: dict[str, str] = {}


def log(msg: str) -> None:
    print(f"[{time.monotonic() - T0:6.1f}s] {msg}", flush=True)


# ----------------------------------------------------------------------------- CDP client
class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.listeners: list = []  # callables(msg) for CDP events
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" not in msg:
                    for cb in self.listeners:
                        try:
                            cb(msg)
                        except Exception as e:
                            log(f"  listener error: {e}")
                    continue
                fut = self.pending.pop(msg["id"], None)
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(f"CDP error: {msg['error']}"))
                    else:
                        fut.set_result(msg.get("result", {}))
        except Exception as e:  # connection dropped
            for f in self.pending.values():
                if not f.done():
                    f.set_exception(e)

    async def send(self, method: str, params: dict | None = None, timeout: float = 30):
        self.next_id += 1
        mid = self.next_id
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(mid, None)

    async def js(self, expr: str, await_promise: bool = False, timeout: float = 30):
        r = await self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
            "userGesture": True}, timeout)
        if "exceptionDetails" in r:
            desc = r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"].get("text")
            log(f"  JS exception: {str(desc)[:200]}")
            return None
        return r.get("result", {}).get("value")


# ----------------------------------------------------------------------------- frame recorder
class Recorder:
    """Screencast frames (fallback: captureScreenshot polling) plus the key PNG stills."""

    def __init__(self, cdp: CDP):
        self.cdp = cdp
        self.frames: list[dict] = []  # {t, data, kind: jpeg-b64|png, hold, seg, speed}
        self.seg = "landing"
        self.speed = 1.0              # >1 time-compresses boring waits in the GIF
        self.casting = False
        self.polling = False
        self.poll_task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.cast_frames = 0
        cdp.listeners.append(self._on_event)

    def _add(self, data, kind: str, hold: int = 0, t: float | None = None):
        self.frames.append({"t": t or time.monotonic(), "data": data, "kind": kind, "hold": hold,
                            "seg": self.seg, "speed": self.speed})

    def _on_event(self, msg):
        if msg.get("method") != "Page.screencastFrame":
            return
        p = msg["params"]
        asyncio.get_running_loop().create_task(self._ack(p["sessionId"]))
        if self.casting:
            self.cast_frames += 1
            self._add(p["data"], "jpeg-b64")

    async def _ack(self, sid):
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": sid}, timeout=10)
        except Exception:
            pass

    async def start(self):
        if self.casting or self.polling:
            return
        before = self.cast_frames
        self.casting = True
        try:
            await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": GIF_WIDTH,
                                                         "maxHeight": GIF_H, "everyNthFrame": 1}, timeout=10)
        except Exception as e:
            log(f"  screencast failed to start: {e}")
        await asyncio.sleep(1.5)
        if self.cast_frames == before:  # nothing arrived: poll captureScreenshot instead
            log("  no screencast frames: falling back to captureScreenshot polling")
            REPORT["frames"] = "captureScreenshot polling (screencast gave no frames)"
            self.casting = False
            self.polling = True
            self.poll_task = asyncio.create_task(self._poll())
        else:
            REPORT.setdefault("frames", "Page.startScreencast (jpeg q92, 960x600)")

    async def _poll(self):
        while self.polling:
            t = time.monotonic()
            try:
                async with self.lock:
                    r = await self.cdp.send("Page.captureScreenshot",
                                            {"format": "jpeg", "quality": 92, "optimizeForSpeed": True}, timeout=8)
                self._add(r["data"], "jpeg-b64", t=t)
            except Exception as e:
                log(f"  frame grab failed: {type(e).__name__} {e}")
            await asyncio.sleep(max(0.0, 0.2 - (time.monotonic() - t)))

    async def stop(self):
        if self.casting:
            self.casting = False
            try:
                await self.cdp.send("Page.stopScreencast", timeout=10)
            except Exception as e:
                log(f"  stopScreencast: {e}")
        if self.polling:
            self.polling = False
            if self.poll_task:
                await self.poll_task

    async def still(self, name: str, hold_ms: int = HOLD_MS) -> None:
        t = time.monotonic()
        png = None
        for attempt in range(2):
            try:
                async with self.lock:
                    r = await self.cdp.send("Page.captureScreenshot", {"format": "png"}, timeout=20)
                png = base64.b64decode(r["data"])
                break
            except Exception as e:
                log(f"  still {name} attempt {attempt + 1} failed: {type(e).__name__} {e}")
        if png is None:
            REPORT[f"still:{name}"] = "FAILED"
            return
        path = SCREENS / name
        path.write_bytes(png)
        self._add(png, "png", hold=hold_ms, t=t)
        im = Image.open(io.BytesIO(png))
        blank = all(lo == hi for lo, hi in im.convert("RGB").getextrema())
        kb = path.stat().st_size // 1024
        REPORT[f"still:{name}"] = f"{im.size[0]}x{im.size[1]} {kb} KB" + (" BLANK!" if blank else "")
        log(f"  saved {path.relative_to(ROOT)} ({kb} KB){' BLANK!' if blank else ''}")


# ----------------------------------------------------------------------------- page helpers
VIS = "const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';"
BUSY_JS = "(() => { const p = document.getElementById('status-pill'); return !!p && p.textContent.trim().startsWith('◌'); })()"
STATUS_JS = "(() => { const p = document.getElementById('status-pill'); return p ? p.textContent.trim() : ''; })()"


async def wait_for(cdp: CDP, expr: str, timeout: float, poll: float = 0.25):
    """Poll a JS expression until truthy; returns the value or None on timeout."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = await cdp.js(expr)
        if v:
            return v
        await asyncio.sleep(poll)
    return None


async def wait_idle(cdp: CDP, min_s: float, max_s: float, since: float) -> float:
    """Wait at least min_s (from `since`), then until the status pill stops showing busy; max max_s."""
    await asyncio.sleep(max(0.0, min_s - (time.monotonic() - since)))
    await wait_for(cdp, f"!{BUSY_JS}", max(0.0, max_s - (time.monotonic() - since)))
    return time.monotonic() - since


async def click_first(cdp: CDP, finder_js: str) -> str | None:
    """finder_js: JS body that returns an element or null (VIS helper available)."""
    return await cdp.js(f"""(() => {{ {VIS}
        const el = (() => {{ {finder_js} }})();
        if (!el) return null;
        el.scrollIntoView({{block: 'center', inline: 'nearest'}});
        el.click();
        const id = el.id ? '#' + el.id : (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : el.tagName);
        return id + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + '"';
    }})()""")


def btn_text_finder(pattern: str, scope: str = "document", exclude_nav: bool = True) -> str:
    nav = " && !b.closest('[data-screen]') && !b.hasAttribute('data-screen')" if exclude_nav else ""
    return (f"const root = {scope} || document; return [...root.querySelectorAll('button')]"
            f".filter((b) => vis(b) && !b.disabled{nav}).find((b) => /{pattern}/i.test(b.textContent)) || null;")


async def type_into(cdp: CDP, target: str, text: str, step: int = 3, delay: float = 0.03) -> None:
    """Type progressively (so the GIF shows typing), firing input events like a real keyboard."""
    await cdp.js(f"""(() => {{ const t = document.querySelector({json.dumps(target)}); if (t) {{ t.focus(); t.value = '';
        t.dispatchEvent(new Event('input', {{bubbles: true}})); }} }})()""")
    for i in range(0, len(text), step):
        await cdp.js(f"""(() => {{ const t = document.querySelector({json.dumps(target)}); if (!t) return;
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            set.call(t, {json.dumps(text[: i + step])}); t.dispatchEvent(new Event('input', {{bubbles: true}})); }})()""")
        await asyncio.sleep(delay)


async def press_send(cdp: CDP, target: str) -> str | None:
    how = await click_first(cdp, """
        return document.querySelector('#chat-send')
          || document.querySelector('#screen-intake form button[type=submit]')
          || document.querySelector('#screen-intake button[aria-label="Send"]')
          || document.querySelector('#btn-parse');""")
    if not how:
        how = await cdp.js(f"""(() => {{ const t = document.querySelector({json.dumps(target)}); if (!t) return null;
            t.dispatchEvent(new KeyboardEvent('keydown', {{key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}}));
            return 'Enter keydown on ' + {json.dumps(target)}; }})()""")
    return how


COMPOSER_JS = f"""(() => {{ {VIS}
    if (vis(document.querySelector('#chat-input'))) return '#chat-input';
    const t = document.querySelector('#screen-intake textarea');
    if (vis(t)) return t.id ? '#' + t.id : '#screen-intake textarea';
    if (vis(document.querySelector('#prompt-input'))) return '#prompt-input';
    return null; }})()"""

# Show the latest user bubble + reply together; if they don't fit, put the question at the top.
FIT_EXCHANGE_JS = """(() => { const u = [...document.querySelectorAll('.chat-msg.chat-user')].pop();
    const a = [...document.querySelectorAll('.chat-msg.chat-assistant')].pop(); if (!u || !a) return;
    const span = a.getBoundingClientRect().bottom - u.getBoundingClientRect().top;
    const box = document.querySelector('#chat-thread');
    const room = box ? Math.min(box.clientHeight, innerHeight - 140) : innerHeight - 140;
    if (span > room) u.scrollIntoView({block: 'start'}); })()"""


async def load_app(cdp: CDP, url: str) -> str | None:
    await cdp.send("Page.navigate", {"url": url})
    ok = await wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('#screen-intake')", 20)
    log(f"page loaded: {bool(ok)}")
    return await wait_for(cdp, COMPOSER_JS, 10)  # let the chat UI build itself


# ----------------------------------------------------------------------------- the flow
async def run_flow(cdp: CDP, rec: Recorder, url: str):
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Emulation.setDeviceMetricsOverride",
                   {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
    sel = await load_app(cdp, url)
    REPORT["step1:composer"] = str(sel)
    log(f"composer: {sel}")
    target = sel or "#screen-intake textarea"

    # ---- Step 1: empty landing
    rec.seg = "landing"
    await rec.start()
    await asyncio.sleep(1.0)
    await rec.still("01-landing.png")

    # ---- Step 0: ask the textbook a question; keep the cited answer if /api/ask replies in 15 s
    if target != "#prompt-input":
        rec.seg = "ask"
        await type_into(cdp, target, ASK_Q)
        await asyncio.sleep(0.5)
        how = await press_send(cdp, target)
        REPORT["step0:send"] = str(how)
        log(f"ask sent via: {how}")
        ans = await wait_for(cdp, """(() => {
            const msgs = [...document.querySelectorAll('.chat-msg.chat-assistant')];
            const last = msgs[msgs.length - 1]; if (!last || last.querySelector('.typing')) return null;
            const txt = last.textContent.trim().replace(/\\s+/g, ' ');
            const chips = last.querySelectorAll('.cite-item').length || last.querySelectorAll('.cite-pill').length;
            const md = last.querySelector('.answer-md, .cite-list');
            if (md && txt.length > 20) return 'answer, ' + chips + ' citation chips';
            if (/here's the mission|offline|couldn.t|could not|failed|error/i.test(txt) || last.querySelector('.chat-run'))
                return 'error: ' + txt.slice(0, 90);
            return txt.length > 80 ? 'answer (unrecognised markup), ' + chips + ' citation chips' : null; })()""", 15)
        REPORT["step0:answer"] = str(ans)
        log(f"ask answer: {ans}")
        if ans and ans.startswith("answer"):
            await asyncio.sleep(1.3)  # reveal animations
            await cdp.js(FIT_EXCHANGE_JS)
            await asyncio.sleep(0.4)
            await rec.still("00-ask-raymer.png", HOLD_MS + 600)
        else:
            REPORT["step0:skipped"] = "no cited answer within 15 s; reloaded for a clean chat"
            log("  no cited answer: reloading for a clean landing")
            # drop the failed exchange from the GIF and keep the recorder off during navigation
            await rec.stop()
            rec.frames = [f for f in rec.frames if f["seg"] != "ask"]
            sel = await load_app(cdp, url)
            target = sel or target
            rec.seg = "landing"
            await rec.start()

    # ---- Step 1b: the London mission
    rec.seg = "landing"
    await type_into(cdp, target, PROMPT)
    await asyncio.sleep(0.6)
    rec.seg = "reply"
    how = await press_send(cdp, target)
    REPORT["step1:send"] = str(how)
    log(f"sent via: {how}")
    reply = await wait_for(cdp, f"""(() => {{ {VIS}
        const btns = [...document.querySelectorAll('#screen-intake button')].filter(vis);
        if (btns.some((b) => /run the design spiral|run with the baseline/i.test(b.textContent))) return 'run-button';
        const c = document.querySelector('.chat-run'); if (vis(c)) return '.chat-run';
        const k = document.querySelector('.kv-chips'); if (vis(k)) return '.kv-chips';
        return null; }})()""", 15)
    if not reply and "#prompt-input" in str(sel):
        await asyncio.sleep(4)  # old UI: no reply bubble, just give Gemini time
        reply = "old-ui timed wait"
    REPORT["step1:reply"] = str(reply)
    log(f"reply detected: {reply}")
    await asyncio.sleep(1.3)  # reveal animations
    await cdp.js(FIT_EXCHANGE_JS)
    await asyncio.sleep(0.2)
    await rec.still("02-intake-reply.png")

    # ---- Step 2: run the spiral -> infeasible
    rec.seg = "spiral"
    how = await click_first(cdp, btn_text_finder("run the design spiral", "document.querySelector('#screen-intake')"))
    if not how:
        how = await click_first(cdp, btn_text_finder("confirm"))
    if not how:
        how = await click_first(cdp, "return document.querySelector('#btn-run-spiral') || document.querySelector('.chat-run');")
    if not how:
        how = await click_first(cdp, "return [...document.querySelectorAll('button')].find((b) => /spiral/i.test(b.textContent)) || null;")
    REPORT["step2:run"] = str(how)
    log(f"run spiral via: {how}")
    t_run = time.monotonic()
    ws_ok = await wait_for(cdp, "!!document.querySelector('#screen-workspace.active')", 10)
    log(f"workspace active: {bool(ws_ok)}")
    banner = await wait_for(cdp, f"""(() => {{ {VIS} const b = document.getElementById('infeasible-banner');
        return !!b && !b.classList.contains('hidden') && vis(b); }})()""", 25)
    REPORT["step2:infeasible-banner"] = (f"visible after {time.monotonic() - t_run:.1f} s" if banner
                                         else "NOT visible after 25 s")
    log(f"infeasible banner: {bool(banner)}")
    await asyncio.sleep(1.2)
    await rec.still("03-infeasible.png", HOLD_MS + 600)

    # ---- Step 3: accept relaxation -> converged
    rec.seg = "converged"
    how = await click_first(cdp, f"""const b = document.getElementById('btn-accept-relaxation'); if (vis(b)) return b;
        {btn_text_finder('accept')}""")
    REPORT["step3:accept"] = str(how)
    log(f"accept via: {how}")
    t_click = time.monotonic()
    await wait_for(cdp, """(() => { const b = document.getElementById('infeasible-banner');
        return !b || b.classList.contains('hidden') || b.getClientRects().length === 0; })()""", 10)
    took = await wait_idle(cdp, 3.0, 15.0, t_click)
    await asyncio.sleep(1.2)
    status = await cdp.js(STATUS_JS)
    banner_again = await cdp.js("""(() => { const b = document.getElementById('infeasible-banner');
        return !!b && !b.classList.contains('hidden') && b.getClientRects().length > 0; })()""")
    REPORT["step3:converged"] = f"status '{status}' after {took:.1f} s" + ("; banner STILL visible" if banner_again else "")
    log(f"converged: {REPORT['step3:converged']}")
    await rec.still("04-converged.png")

    # ---- Step 4: detailed spar CAD + FEA
    rec.seg = "detailed"
    how = await click_first(cdp, """return [...document.querySelectorAll('[data-screen="detailed"]')].find(vis) || null;""")
    if not how:
        how = await click_first(cdp, "const b = document.getElementById('btn-goto-detailed'); return vis(b) ? b : null;")
    REPORT["step4:tab"] = str(how)
    log(f"detailed tab via: {how}")
    await wait_for(cdp, "!!document.querySelector('#screen-detailed.active')", 4)
    await asyncio.sleep(0.8)
    how = await click_first(cdp, f"""const b = document.getElementById('btn-run-fea'); if (vis(b) && !b.disabled) return b;
        {btn_text_finder('run|cad|fea', "document.querySelector('.screen.active')")}""")
    REPORT["step4:run-fea"] = str(how)
    log(f"FEA run via: {how}")
    t_fea = time.monotonic()
    took = await wait_idle(cdp, 3.0, 25.0, t_fea)
    await asyncio.sleep(1.5)
    REPORT["step4:done"] = f"status '{await cdp.js(STATUS_JS)}' after {took:.1f} s"
    log(f"FEA: {REPORT['step4:done']}")
    await rec.still("05-fea.png")

    # ---- Step 5: report
    rec.seg = "report"
    how = await click_first(cdp, """return [...document.querySelectorAll('[data-screen="report"]')].find(vis) || null;""")
    REPORT["step5:tab"] = str(how)
    log(f"report tab via: {how}")
    await wait_for(cdp, "!!document.querySelector('#screen-report.active')", 4)
    await asyncio.sleep(0.6)
    how = await click_first(cdp, f"""const b = document.getElementById('btn-generate-report'); if (vis(b) && !b.disabled) return b;
        {btn_text_finder('generate', "document.querySelector('.screen.active')")}""")
    REPORT["step5:generate"] = str(how)
    log(f"generate via: {how}")
    t_rep = time.monotonic()
    await asyncio.sleep(1.5)
    rec.speed = 4.0  # the generation wait plays 4x faster in the GIF
    done = await wait_for(cdp, f"""(() => {{ const st = {STATUS_JS}; const busy = {BUSY_JS};
        const md = document.getElementById('report-markdown');
        const txt = md ? md.textContent.trim() : '';
        return !busy && txt.length > 300 && !/click .generate/i.test(txt) ? st || 'ready' : null; }})()""", 75)
    rec.speed = 1.0
    REPORT["step5:report"] = (f"'{done}' after {time.monotonic() - t_rep:.1f} s" if done
                              else f"NOT ready after {time.monotonic() - t_rep:.1f} s (status '{await cdp.js(STATUS_JS)}')")
    log(f"report: {REPORT['step5:report']}")
    await asyncio.sleep(1.8)
    await rec.still("06-report.png", HOLD_MS + 1400)
    await rec.stop()


# ----------------------------------------------------------------------------- GIF
def _decode(f: dict) -> Image.Image:
    raw = base64.b64decode(f["data"]) if f["kind"] == "jpeg-b64" else f["data"]
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.size != (GIF_WIDTH, GIF_H):
        im = im.resize((GIF_WIDTH, GIF_H), Image.Resampling.LANCZOS)
    return im


def _thin(quant: list[tuple], ratio: float) -> list[tuple]:
    """Keep ~ratio of the motion frames (holds always kept); dropped frames' time folds into the previous one."""
    if ratio >= 1.0:
        return list(quant)
    out, acc = [], 0.0
    for img, d, hold in quant:
        if hold or not out:
            out.append((img, d, hold))
            continue
        acc += ratio
        if acc >= 1.0:
            acc -= 1.0
            out.append((img, d, hold))
        else:
            pimg, pd, ph = out[-1]
            out[-1] = (pimg, pd + d, ph)
    return out


def build_gif(frames: list[dict], out: Path) -> None:
    frames = sorted(frames, key=lambda f: f["t"])
    # thin to <= MAX_FPS (holds are always kept)
    kept, last_t = [], -1e9
    for f in frames:
        if f["hold"] or f["t"] - last_t >= 1.0 / MAX_FPS:
            kept.append(f)
            last_t = f["t"]
    items = []
    for i, f in enumerate(kept):
        if f["hold"]:
            d = f["hold"]
        else:
            nxt = kept[i + 1]["t"] if i + 1 < len(kept) else f["t"] + 0.2
            d = int(round((nxt - f["t"]) * 1000 / f["speed"]))
            d = max(60, min(d, 1200))
        items.append({**f, "dur": d})

    # one adaptive palette per screen (255 colours, leaving Pillow a free index for transparency)
    group = lambda f: PALETTE_GROUP.get(f["seg"], f["seg"])  # noqa: E731
    palettes: dict[str, Image.Image] = {}
    for g in dict.fromkeys(group(f) for f in items):
        g_items = [f for f in items if group(f) == g]
        step = max(1, len(g_items) // 10)
        sample = g_items[::step][:10] + [f for f in g_items if f["hold"]]
        tw, th = GIF_WIDTH // 2, GIF_H // 2
        mosaic = Image.new("RGB", (tw, th * len(sample)))
        for k, f in enumerate(sample):
            mosaic.paste(_decode(f).resize((tw, th)), (0, k * th))
        palettes[g] = mosaic.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

    # temporal denoise in RGB, before quantizing: a pixel only updates when it moved more than NOISE
    # from its last committed value, so static UI stays byte-identical and Pillow (optimize=True)
    # writes it as transparent runs inside each delta frame
    quant, ref, prev_g = [], None, None
    for f in items:
        a = np.asarray(_decode(f), dtype=np.int16)
        if ref is not None and group(f) == prev_g:
            changed = np.abs(a - ref).max(axis=2) > NOISE
            grown = Image.fromarray(changed.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))
            a = np.where((np.asarray(grown) > 0)[..., None], a, ref)
        ref, prev_g = a, group(f)
        q = Image.fromarray(a.astype(np.uint8)).quantize(palette=palettes[group(f)], dither=Image.Dither.NONE)
        quant.append((q, f["dur"], bool(f["hold"])))

    full = quant
    for attempt, ratio in enumerate((1.0, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2)):
        quant = _thin(full, ratio)
        imgs = [q[0] for q in quant]
        durs = [q[1] for q in quant]
        imgs[0].save(out, save_all=True, append_images=imgs[1:], duration=durs, loop=0, optimize=True)
        size = out.stat().st_size
        log(f"GIF attempt {attempt + 1} (keep {ratio:.0%}): {len(imgs)} frames, {size / 1e6:.2f} MB, {sum(durs) / 1000:.1f} s")
        if size <= GIF_MAX_BYTES:
            break
    REPORT["gif"] = f"{len(quant)} frames, {out.stat().st_size / 1e6:.2f} MB, {sum(q[1] for q in quant) / 1000:.1f} s"


# ----------------------------------------------------------------------------- main
def get_ws_url(timeout: float = 20) -> str:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=2) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError("Chrome DevTools endpoint did not come up")


def wait_for_app(url: str, timeout: float = 90) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1.0)
    return False


async def amain(url: str, scratch: Path, dump: Path | None = None) -> int:
    if not wait_for_app(url):
        log(f"app not reachable at {url}")
        REPORT["flow-error"] = f"app not reachable at {url}"
        print(json.dumps(REPORT, indent=2))
        return 2
    SCREENS.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="chrome-profile-", dir=scratch))
    cmd = ["/usr/bin/google-chrome", "--headless=new", f"--remote-debugging-port={PORT}",
           f"--window-size={W},{H}", "--hide-scrollbars", "--use-angle=swiftshader",
           "--enable-unsafe-swiftshader", f"--user-data-dir={profile}", "--no-first-run",
           "--no-default-browser-check", "about:blank"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    rec = None
    try:
        ws_url = get_ws_url()
        log(f"chrome up: {ws_url}")
        async with connect(ws_url, max_size=None, ping_interval=None, open_timeout=20) as ws:
            cdp = CDP(ws)
            rec = Recorder(cdp)
            try:
                await asyncio.wait_for(run_flow(cdp, rec, url), timeout=240)
            except Exception as e:
                REPORT["flow-error"] = f"{type(e).__name__}: {e}"
                log(f"FLOW ERROR: {type(e).__name__}: {e}")
            finally:
                try:
                    await asyncio.wait_for(rec.stop(), 15)
                except Exception:
                    pass
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass
        shutil.rmtree(profile, ignore_errors=True)
        log("chrome stopped")
    if rec and rec.frames:
        if dump:
            dump.write_bytes(pickle.dumps(rec.frames))
            log(f"frames dumped to {dump}")
        build_gif(rec.frames, GIF_PATH)
    print(json.dumps(REPORT, indent=2, ensure_ascii=False))
    return 0 if "flow-error" not in REPORT else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default="http://localhost:8000/")
    ap.add_argument("--scratch", default=os.environ.get("CAPTURE_SCRATCH", tempfile.gettempdir()),
                    help="where Chrome's throwaway --user-data-dir goes")
    ap.add_argument("--dump", type=Path, help="also pickle the raw frames here (for --gif-only)")
    ap.add_argument("--gif-only", type=Path, help="rebuild docs/demo.gif from a --dump file, no browser")
    a = ap.parse_args()
    if a.gif_only:
        build_gif(pickle.loads(a.gif_only.read_bytes()), GIF_PATH)
        print(json.dumps(REPORT, indent=2))
        return 0
    return asyncio.run(amain(a.url, Path(a.scratch), a.dump))


if __name__ == "__main__":
    raise SystemExit(main())
