"""Record real footage of the Spiral app over the Chrome DevTools Protocol.

Usage: .venv/bin/python video/capture.py <footage_dir>
Launches its own headless Chrome on port 9444, drives the flow, saves screencast
frames per segment with timestamps, then encodes each segment to a 30 fps MP4.
"""
import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

import websockets

PORT = 9444
URL = "http://localhost:8000/"
W, H = 1600, 900
DSF = float(os.environ.get("CAP_DSF", "1"))
PW, PH = int(round(W * DSF)), int(round(H * DSF))
CLIP_DIR = os.environ.get("CLIP_DIR")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "public/footage")
PROFILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-1000/-home-lain-halloween-hack/368a1e00-3cea-4b3f-a8a2-3675d5278d53/scratchpad/chrome-profile"
PROMPT = ("Four-seat tourer, London to New York non-stop, 5,570 km range, "
          "45 min reserve, cruise 115 kt, stall under 55 kt.")

CURSOR_JS = r"""
(() => {
  if (document.getElementById('__demo_cursor')) return;
  const c = document.createElement('div');
  c.id = '__demo_cursor';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-8.1L21 10z" fill="#fff" stroke="#0b1220" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.22,.8,.26,1);transform:translate(1180px,760px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))';
  document.documentElement.appendChild(c);
  const r = document.createElement('div');
  r.id = '__demo_ripple';
  r.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #38bdf8;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.3)';
  document.documentElement.appendChild(r);
  window.__demoMove = (x, y) => { c.style.transform = `translate(${x - 4}px, ${y - 3}px)`; };
  window.__demoRipple = (x, y) => {
    r.style.left = x + 'px'; r.style.top = y + 'px';
    r.animate([{opacity: .9, transform: 'scale(.3)'}, {opacity: 0, transform: 'scale(1.6)'}], {duration: 550, easing: 'ease-out'});
  };
})()
"""


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending = {}
        self.handlers = []

    async def send(self, method, params=None, timeout=60):
        self.n += 1
        i = self.n
        fut = asyncio.get_running_loop().create_future()
        self.pending[i] = fut
        await self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        return await asyncio.wait_for(fut, timeout)

    async def reader(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if "id" in m:
                    fut = self.pending.pop(m["id"], None)
                    if fut and not fut.done():
                        if "error" in m:
                            fut.set_exception(RuntimeError(str(m["error"])))
                        else:
                            fut.set_result(m.get("result", {}))
                else:
                    for h in self.handlers:
                        h(m)
        except Exception as e:  # noqa
            print("reader stopped:", e, flush=True)


class Recorder:
    def __init__(self, cdp):
        self.cdp = cdp
        self.seg = None
        self.frames = {}
        self.marks = {}
        self.last_frame_t = time.time()
        self.last_cast_t = time.time()
        self.last_restart = 0.0
        self.busy = False
        self.restarts = 0
        cdp.handlers.append(self.on_event)

    def on_event(self, m):
        if m.get("method") != "Page.screencastFrame":
            return
        p = m["params"]
        asyncio.ensure_future(self.cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]}))
        self.last_cast_t = time.time()
        self.save(base64.b64decode(p["data"]), time.time())

    def save(self, data, ts):
        if not self.seg:
            return
        self.last_frame_t = time.time()
        lst = self.frames.setdefault(self.seg, [])
        d = os.path.join(OUT, self.seg)
        os.makedirs(d, exist_ok=True)
        fn = os.path.join(d, f"{len(lst):05d}.jpg")
        with open(fn, "wb") as f:
            f.write(data)
        lst.append((fn, ts))

    async def keepalive(self):
        """Screencast stalls on some pages: fill gaps with screenshots and restart the cast."""
        while True:
            await asyncio.sleep(0.12)
            if not self.seg or self.busy:
                continue
            now = time.time()
            if now - self.last_frame_t < 0.45:
                continue
            self.busy = True
            try:
                t0 = time.time()
                r = await self.cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 88}, timeout=10)
                self.save(base64.b64decode(r["data"]), (t0 + time.time()) / 2)
                if time.time() - self.last_cast_t > 1.2 and time.time() - self.last_restart > 2.5:
                    self.last_restart = time.time()
                    await self.cdp.send("Page.stopScreencast", timeout=10)
                    await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 88, "maxWidth": PW, "maxHeight": PH, "everyNthFrame": 1}, timeout=10)
                    self.restarts += 1
            except Exception as e:  # noqa
                print("   keepalive error:", e, flush=True)
            finally:
                self.busy = False

    def start(self, seg):
        now = time.time()
        if self.seg:
            self.marks[self.seg]["end"] = now
        self.seg = seg
        self.marks[seg] = {"start": now}
        d = os.path.join(OUT, seg)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
        print(f"[{time.strftime('%H:%M:%S')}] segment {seg}", flush=True)

    def stop(self):
        if self.seg:
            self.marks[self.seg]["end"] = time.time()
        self.seg = None


async def ev(cdp, expr, await_promise=True):
    r = await cdp.send("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
    if "exceptionDetails" in r:
        print("JS exception:", r["exceptionDetails"].get("text"), r["exceptionDetails"].get("exception", {}).get("description", "")[:300], flush=True)
        return None
    return r.get("result", {}).get("value")


async def wait_for(cdp, expr, timeout=60, poll=0.25, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = await ev(cdp, expr)
        if v:
            print(f"   ok {label or expr[:60]} after {time.time() - t0:.1f}s", flush=True)
            return v
        await asyncio.sleep(poll)
    print(f"   TIMEOUT {label or expr[:60]} after {timeout}s", flush=True)
    return None


FIND_BTN = r"""
((sels, texts) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  for (const s of sels) { for (const e of document.querySelectorAll(s)) { if (vis(e)) return e; } }
  const all = [...document.querySelectorAll('button, a, [role=button]')].filter(vis);
  for (const t of texts) { const e = all.find(b => (b.textContent || '').toLowerCase().includes(t.toLowerCase())); if (e) return e; }
  return null;
})
"""


async def locate(cdp, sels, texts, scroll=True):
    expr = f"""(() => {{ const e = {FIND_BTN}({json.dumps(sels)}, {json.dumps(texts)}); if (!e) return null;
      {'e.scrollIntoView({block: "center", behavior: "smooth"});' if scroll else ''}
      return true; }})()"""
    ok = await ev(cdp, expr)
    if not ok:
        return None
    await asyncio.sleep(0.6)
    expr2 = f"""(() => {{ const e = {FIND_BTN}({json.dumps(sels)}, {json.dumps(texts)}); if (!e) return null;
      const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()"""
    return await ev(cdp, expr2)


async def click(cdp, sels, texts, label="", move_time=0.8):
    pos = await locate(cdp, sels, texts)
    if not pos:
        print(f"   !! could not find {label or sels or texts}", flush=True)
        return False
    x, y = pos
    await ev(cdp, CURSOR_JS)
    await ev(cdp, f"window.__demoMove && window.__demoMove({x}, {y})")
    await asyncio.sleep(move_time)
    await cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    await asyncio.sleep(0.15)
    await ev(cdp, f"window.__demoRipple && window.__demoRipple({x}, {y})")
    await cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    await asyncio.sleep(0.08)
    await cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
    print(f"   clicked {label} at {x:.0f},{y:.0f}", flush=True)
    return True


async def hold(sec):
    await asyncio.sleep(sec)


async def flow(cdp, rec):
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": DSF, "mobile": False})
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {"color": {"r": 7, "g": 11, "b": 20, "a": 1}})
    await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 88, "maxWidth": PW, "maxHeight": PH, "everyNthFrame": 1})

    for attempt in range(3):
        # 1. Landing
        rec.start("s1_landing")
        await cdp.send("Page.navigate", {"url": URL})
        await wait_for(cdp, "!!document.getElementById('chat-input')", 30, label="chat input")
        await ev(cdp, CURSOR_JS)
        await ev(cdp, "document.querySelectorAll('textarea,input').forEach(e => e.spellcheck = false)")
        await hold(4.0)

        # 2. Type the mission and send
        rec.start("s2_compose")
        sel_input = "document.querySelector('#chat-input') || document.querySelector('#screen-intake textarea')"
        await ev(cdp, f"({sel_input}).spellcheck = false")
        pos = await ev(cdp, f"(() => {{ const e = {sel_input}; const r = e.getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2]; }})()")
        if pos:
            await ev(cdp, f"window.__demoMove && window.__demoMove({pos[0]}, {pos[1]})")
            await hold(0.8)
            await cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": pos[0], "y": pos[1], "button": "left", "clickCount": 1})
            await cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": pos[0], "y": pos[1], "button": "left", "clickCount": 1})
        await ev(cdp, f"({sel_input}).focus()")
        await hold(0.3)
        for ch in PROMPT:
            await cdp.send("Input.insertText", {"text": ch})
            await asyncio.sleep(0.022 if ch != " " else 0.04)
        await hold(0.6)
        await cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
        await cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
        rec.marks["s2_compose"]["sent"] = time.time()
        # 3. Reply types out
        res = await wait_for(cdp, "(() => { if ([...document.querySelectorAll('.reply-text')].some(e => /couldn.t read/i.test(e.textContent))) return 'fail'; const b=[...document.querySelectorAll('.chat-run')].find(b => /run the design spiral/i.test(b.textContent) && b.getBoundingClientRect().width>0); return b ? 'ok' : null; })()", 90, label="run button")
        rec.marks["s2_compose"]["reply_done"] = time.time()
        if res == "ok":
            break
        print("   intake failed, retrying", flush=True)
        await hold(3)
    await hold(2.5)

    # 4. Run the design spiral -> laps -> infeasible banner
    rec.start("s3_spiral")
    await click(cdp, [".chat-run"], ["Run the design spiral", "Stream Design Spiral"], label="run spiral")
    await wait_for(cdp, "(() => { const b = document.getElementById('infeasible-banner'); const s = (document.getElementById('status-pill')||{}).textContent || ''; return (b && !b.classList.contains('hidden') && b.getBoundingClientRect().height > 0) || /converged on lap/i.test(s); })()", 120, label="infeasible banner")
    rec.marks["s3_spiral"]["banner"] = time.time()
    await hold(1.0)
    await ev(cdp, "(() => { const b = document.getElementById('infeasible-banner'); if (b) b.scrollIntoView({block: 'center', behavior: 'smooth'}); })()")
    await hold(3.5)

    # 5. Accept relaxation -> re-run -> converge
    rec.start("s4_relax")
    await click(cdp, ["#btn-accept-relaxation"], ["Accept", "Relaxation"], label="accept relaxation")
    await hold(1.5)
    await wait_for(cdp, "(() => { const s = (document.getElementById('status-pill')||{}).textContent || ''; const b = document.getElementById('infeasible-banner'); return /converged on lap/i.test(s) && (!b || b.classList.contains('hidden') || b.getBoundingClientRect().height === 0); })()", 120, label="converged")
    rec.marks["s4_relax"]["converged"] = time.time()
    await hold(3.0)

    # 6. Detailed: CAD + FEA
    rec.start("s5_detailed")
    await click(cdp, ['[data-screen="detailed"]'], ["Detailed"], label="detailed tab")
    await hold(1.5)
    await click(cdp, ["#btn-run-fea"], ["CAD + 3D FEA", "FEA"], label="run fea")
    await wait_for(cdp, "(() => { const s = (document.getElementById('status-pill')||{}).textContent || ''; return /CAD & FEA (Verified|Complete)/i.test(s) && !/stream/i.test(s); })()", 150, label="fea done")
    rec.marks["s5_detailed"]["fea_done"] = time.time()
    await hold(1.0)
    await ev(cdp, "(() => { const v = document.getElementById('viewport-spar-fea'); if (v) v.scrollIntoView({block: 'center', behavior: 'smooth'}); })()")
    await hold(4.5)

    # 7. Report: generate, then scroll to the textbook items table
    rec.start("s6_report")
    await click(cdp, ['[data-screen="report"]'], ["Report"], label="report tab")
    await hold(1.5)
    await click(cdp, ["#btn-generate-report"], ["Generate"], label="generate report")
    await wait_for(cdp, "(() => { const s = (document.getElementById('status-pill')||{}).textContent || ''; return /report ready/i.test(s); })()", 150, label="report ready")
    rec.marks["s6_report"]["ready"] = time.time()
    await ev(cdp, "window.scrollTo({top: 0}); document.querySelectorAll('.screen.active, #screen-report, .report-body').forEach(e => { try { e.scrollTop = 0; } catch (_) {} })")
    await hold(2.4)
    rec.marks["s6_report"]["cover"] = time.time()
    found = await ev(cdp, r"""(() => {
      const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,strong,p,caption,th,summary')];
      const h = hs.find(e => /textbook items behind the numbers/i.test(e.textContent || ''));
      if (!h) return false;
      const y = h.getBoundingClientRect().top + window.scrollY - 90;
      // find scroll container
      let el = h.parentElement;
      while (el && el !== document.body) { const cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) break; el = el.parentElement; }
      if (el && el !== document.body) {
        const top = h.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 30;
        el.scrollTo({top, behavior: 'smooth'});
      } else { window.scrollTo({top: y, behavior: 'smooth'}); }
      return true; })()""")
    print("   textbook table found:", found, flush=True)
    await hold(5.0)
    rec.stop()
    await cdp.send("Page.stopScreencast")
    await asyncio.sleep(0.5)


def encode(rec):
    os.makedirs((CLIP_DIR or os.path.join(OUT, "..", "clips")), exist_ok=True)
    meta = {}
    for seg, frames in rec.frames.items():
        if not frames:
            continue
        frames = sorted(frames, key=lambda x: x[1])
        mk = rec.marks.get(seg, {})
        end = mk.get("end", frames[-1][1] + 0.5)
        lst = os.path.join(OUT, seg + ".txt")
        with open(lst, "w") as f:
            for i, (fn, ts) in enumerate(frames):
                nxt = frames[i + 1][1] if i + 1 < len(frames) else end
                dur = max(nxt - ts, 0.001)
                f.write(f"file '{fn}'\nduration {dur:.4f}\n")
            f.write(f"file '{frames[-1][0]}'\n")
        out = os.path.abspath(os.path.join(CLIP_DIR or os.path.join(OUT, "..", "clips"), seg + ".mp4"))
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
               "-vf", f"fps=30,scale={PW}:{PH}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "18", "-g", "30", out]
        subprocess.run(cmd, check=False)
        t0 = mk.get("start", frames[0][1])
        rel = {k: round(v - frames[0][1], 3) for k, v in mk.items()}
        rel["first_frame_offset"] = round(frames[0][1] - t0, 3)
        rel["frames"] = len(frames)
        meta[seg] = rel
        print(f"encoded {seg}: {len(frames)} frames, {end - frames[0][1]:.1f}s -> {out}", flush=True)
    with open(os.path.join(CLIP_DIR or os.path.join(OUT, "..", "clips"), "marks.json"), "w") as f:
        json.dump(meta, f, indent=2)


async def main():
    os.makedirs(OUT, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)
    proc = subprocess.Popen([
        "/usr/bin/google-chrome", "--headless=new", f"--remote-debugging-port={PORT}", f"--window-size={W},{H}",
        "--hide-scrollbars", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", f"--user-data-dir={PROFILE}",
        "--no-first-run", "--no-default-browser-check", "--mute-audio", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1) as r:
                    tabs = json.load(r)
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        if not ws_url:
            raise SystemExit("chrome did not come up")
        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            task = asyncio.create_task(cdp.reader())
            rec = Recorder(cdp)
            ka = asyncio.create_task(rec.keepalive())
            try:
                await flow(cdp, rec)
            finally:
                rec.stop()
                ka.cancel()
                print("screencast restarts:", rec.restarts, flush=True)
                encode(rec)
                task.cancel()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    asyncio.run(main())
