/**
 * Static demo mode for Spiral: replays recorded Gemini runs with no Python backend.
 *
 * Classic (non-module) script, loaded in <head> BEFORE the app's ES modules. It wraps
 * window.fetch so that requests to /api/ (and, in demo mode, /artifacts/ and ./demo/
 * files) on this origin or on localhost (API_BASE) are answered from the recordings in
 * ./demo/ next to this file. Every other request goes straight to the real fetch.
 *
 * Demo mode turns on when:
 *   1. the page URL has ?demo (forced; ?live forces it off), or
 *   2. the page is on a public host but the API points at localhost (e.g. GitHub Pages):
 *      no probe, so no mixed-content / local-network prompt, or
 *   3. the first real /api/ call fails: network error, 404, 405, 501 (python -m
 *      http.server answers POST with 501), or an HTML page instead of JSON. That first
 *      call is the probe; its result is remembered for the life of the page.
 * With a reachable backend and no ?demo, every request goes to the real fetch untouched.
 *
 * Recordings: ./demo/manifest.json maps scenarios (touring, london, london_relaxed,
 * high_ar) to files. If the manifest or an entry is missing, the conventional names
 * (intake_<s>.json, spiral_<s>.sse, state_<s>.json, spar_<s>.sse,
 * state_detailed_<s>.json, report_<s>.json) are tried, then touring's.
 *
 * Optional: ?demo_speed=2 replays twice as fast (0.1 to 20).
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__spiralStaticDemo) return; // loaded twice: keep the first wrapper

  const realFetch = window.fetch.bind(window);

  // ---------------------------------------------------------------- configuration
  const SCRIPT_URL =
    (document.currentScript && document.currentScript.src) || document.baseURI || location.href;
  const DEMO_BASE = new URL("demo/", SCRIPT_URL).href;

  const params = new URLSearchParams(location.search || "");
  const demoParam = params.has("demo") ? String(params.get("demo") || "") : null;
  const FORCE_DEMO = demoParam !== null && !/^(0|false|off|no)$/i.test(demoParam);
  const FORCE_LIVE = !FORCE_DEMO && params.has("live");
  const SPEED = Math.min(20, Math.max(0.1, Number(params.get("demo_speed")) || 1));

  const DELAY_MS = {
    intake: 1200,
    spiral_sync: 500,
    spar_sync: 1000,
    report: 800,
    ask: 800,
  };
  const SSE_FIRST_FRAME_MS = 200;
  const SSE_GAP_MS = 350;
  const SSE_MAX_TOTAL_MS = 30000; // very long recordings are sped up to fit this
  const SSE_MIN_GAP_MS = 120;

  const SCENARIOS = ["touring", "london", "london_relaxed", "high_ar"];
  const CONVENTIONAL = {
    intake: (s) => `intake_${s}.json`,
    spiral: (s) => `spiral_${s}.sse`,
    spiral_sync: (s) => `state_${s}.json`,
    spar: (s) => `spar_${s}.sse`,
    spar_sync: (s) => `state_detailed_${s}.json`,
    report: (s) => `report_${s}.json`,
  };

  const state = {
    mode: FORCE_DEMO ? "demo" : FORCE_LIVE ? "live" : "unknown", // "unknown" until probed
    reason: FORCE_DEMO ? "?demo in the page URL" : FORCE_LIVE ? "?live in the page URL" : "",
    scenario: "touring", // last scenario served, used for /artifacts/ fallbacks
  };

  // ---------------------------------------------------------------- small helpers
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms / SPEED));
      function onAbort() {
        clearTimeout(t);
        reject(abortError());
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });

  function abortError() {
    try {
      return new DOMException("The operation was aborted.", "AbortError");
    } catch (_) {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      return e;
    }
  }

  const isRequest = (x) => !!x && typeof x === "object" && typeof x.url === "string" && typeof x.clone === "function";

  function resolveUrl(input) {
    const raw = typeof input === "string" ? input : isRequest(input) ? input.url : String(input);
    return new URL(raw, document.baseURI || location.href);
  }

  function isLoopbackHost(h) {
    h = String(h || "").toLowerCase();
    return h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h === "::1" || /^127\./.test(h);
  }

  function isLocalHost(h) {
    h = String(h || "").toLowerCase();
    return (
      isLoopbackHost(h) ||
      h === "" ||
      h.endsWith(".local") ||
      h.endsWith(".localhost") ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  }

  const pageOrigin = () => {
    try {
      return new URL(document.baseURI || location.href).origin;
    } catch (_) {
      return "";
    }
  };

  /** Which of our URL families is this? null means "not ours, pass through". */
  function classify(u) {
    if (u.href.startsWith(DEMO_BASE)) return null; // already a recording URL
    // Only our own hosts: same origin as the page, or the localhost:8000 API_BASE.
    if (u.origin !== pageOrigin() && !isLoopbackHost(u.hostname)) return null;
    const p = u.pathname;
    let i = p.indexOf("/api/");
    if (i !== -1) {
      const route = p.slice(i + 4).replace(/\/+$/, "") || "/";
      return { kind: "api", route };
    }
    i = p.indexOf("/demo/");
    if (i !== -1) return { kind: "demo", rest: p.slice(i + 6) + u.search };
    i = p.indexOf("/artifacts/");
    if (i !== -1) return { kind: "artifact", rest: p.slice(i + 11) + u.search };
    return null;
  }

  function cleanName(name) {
    return String(name || "")
      .replace(/^\.?\//, "")
      .replace(/^demo\//, "");
  }

  const demoUrl = (name) => new URL(cleanName(name), DEMO_BASE).href;

  async function readBodyText(input, init) {
    try {
      if (init && init.body != null) {
        if (typeof init.body === "string") return init.body;
        if (typeof init.body.text === "function") return await init.body.text(); // Blob
        return String(init.body);
      }
      if (isRequest(input)) return await input.clone().text();
    } catch (_) {
      /* unreadable body: scenario rules fall back to touring */
    }
    return "";
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "content-type": "application/json" },
    });
  }

  // ---------------------------------------------------------------- demo switch + banner
  function enableDemo(reason) {
    if (state.mode === "demo") return;
    state.mode = "demo";
    state.reason = reason;
    try {
      console.info(`[static-demo] Replaying recorded runs from ${DEMO_BASE} (${reason}).`);
    } catch (_) {}
    showBanner();
    try {
      window.dispatchEvent(new CustomEvent("spiral:static-demo", { detail: { reason } }));
    } catch (_) {}
  }

  function showBanner() {
    const insert = () => {
      if (!document.body || document.getElementById("spiral-static-demo-pill")) return;
      const pill = document.createElement("div");
      pill.id = "spiral-static-demo-pill";
      pill.setAttribute("role", "status");
      pill.title = `Answers come from recorded runs in ./demo/ (${state.reason}). Add ?live to the URL to skip the replay.`;
      pill.style.cssText = [
        "position:fixed",
        "left:16px",
        "bottom:16px",
        "z-index:2147483000",
        "display:inline-flex",
        "align-items:center",
        "gap:8px",
        "max-width:calc(100vw - 32px)",
        "padding:7px 13px 7px 11px",
        "border-radius:999px",
        "background:rgba(14,17,23,0.86)",
        "color:#f3f4f6",
        "border:1px solid rgba(255,255,255,0.14)",
        "box-shadow:0 4px 18px rgba(0,0,0,0.28)",
        "font:500 12px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "letter-spacing:0.01em",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "pointer-events:none",
        "user-select:none",
        "-webkit-backdrop-filter:blur(8px)",
        "backdrop-filter:blur(8px)",
      ].join(";");
      const dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      dot.style.cssText =
        "flex:none;width:7px;height:7px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,0.22)";
      const text = document.createElement("span");
      text.textContent = "Static demo · replaying recorded Gemini runs";
      text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
      pill.appendChild(dot);
      pill.appendChild(text);
      document.body.appendChild(pill);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", insert, { once: true });
    } else {
      insert();
    }
  }

  // ---------------------------------------------------------------- manifest + scenarios
  let manifestPromise = null;
  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = realFetch(demoUrl("manifest.json"), { cache: "no-cache" })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((m) => (m && typeof m === "object" ? m : {}))
        .catch((err) => {
          manifestPromise = null; // not cached: try again on the next request
          try {
            console.warn("[static-demo] demo/manifest.json unavailable, using conventional file names.", err);
          } catch (_) {}
          return {};
        });
    }
    return manifestPromise;
  }

  function scenarioForIntake(description) {
    const d = String(description || "");
    if (/london|new york/i.test(d)) return "london";
    if (d.includes("13.5") || /survey/i.test(d)) return "high_ar";
    return "touring";
  }

  function scenarioForSpec(spec) {
    if (!spec || typeof spec !== "object") return "touring";
    const range = Number(spec.range_m);
    const pax = spec.passenger_count == null ? NaN : Number(spec.passenger_count);
    const ar = Number(spec.aspect_ratio);
    if (range >= 5e6 && pax <= 1) return "london_relaxed";
    if (range >= 5e6) return "london";
    if (ar >= 13) return "high_ar";
    return "touring";
  }

  const specOf = (body) => (body && (body.spec || (body.state && body.state.spec))) || null;

  /** Recording file names to try, in order, for one scenario + manifest key. */
  function candidates(manifest, scenario, key) {
    const out = [];
    const add = (name) => {
      if (name && !out.includes(cleanName(name))) out.push(cleanName(name));
    };
    const scen = (manifest && manifest.scenarios) || {};
    const chain = scenario === "touring" ? ["touring"] : [scenario, "touring"];
    for (const s of chain) {
      add(scen[s] && scen[s][key]);
      add(CONVENTIONAL[key] && CONVENTIONAL[key](s));
    }
    return out;
  }

  /** First recording that exists, as text. */
  async function fetchRecording(names, signal) {
    for (const name of names) {
      try {
        const res = await realFetch(demoUrl(name), { cache: "no-cache", signal });
        if (res.ok) return { name, text: await res.text() };
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
      }
    }
    return null;
  }

  function missingRecording(what, names) {
    return jsonResponse(
      { detail: `Static demo: no recording for ${what} (looked for ${names.join(", ")} in demo/).` },
      503
    );
  }

  async function replayJson(manifest, scenario, key, signal) {
    const t0 = Date.now();
    const names = candidates(manifest, scenario, key);
    const rec = await fetchRecording(names, signal);
    if (!rec) return missingRecording(`${key} (${scenario})`, names);
    await sleep((DELAY_MS[key] || 600) - (Date.now() - t0) * SPEED, signal);
    return new Response(rec.text, { status: 200, headers: { "content-type": "application/json" } });
  }

  function splitSseFrames(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n[ \t]*\n/)
      .map((f) => f.replace(/^\n+|\s+$/g, ""))
      .filter((f) => /^data:/m.test(f));
  }

  function sseResponse(text, signal) {
    const frames = splitSseFrames(text);
    const gap = Math.max(
      SSE_MIN_GAP_MS,
      Math.min(SSE_GAP_MS, frames.length ? SSE_MAX_TOTAL_MS / frames.length : SSE_GAP_MS)
    );
    const encoder = new TextEncoder();
    let timer = null;
    let finished = false;
    let onAbort = null;

    const stream = new ReadableStream({
      start(controller) {
        let i = 0;
        const stop = () => {
          finished = true;
          clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        };
        onAbort = () => {
          if (finished) return;
          stop();
          try {
            controller.error(abortError());
          } catch (_) {}
        };
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        }
        const tick = () => {
          if (finished) return;
          if (i >= frames.length) {
            stop();
            try {
              controller.close();
            } catch (_) {}
            return;
          }
          try {
            controller.enqueue(encoder.encode(frames[i++] + "\n\n"));
          } catch (_) {
            return stop(); // reader went away
          }
          timer = setTimeout(tick, gap / SPEED);
        };
        timer = setTimeout(tick, SSE_FIRST_FRAME_MS / SPEED);
      },
      cancel() {
        finished = true;
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  async function replaySse(manifest, scenario, key, signal) {
    const names = candidates(manifest, scenario, key);
    const rec = await fetchRecording(names, signal);
    if (!rec) return missingRecording(`${key} stream (${scenario})`, names);
    return sseResponse(rec.text, signal);
  }

  async function replayAsk(manifest, question, signal) {
    const t0 = Date.now();
    const q = String(question || "").toLowerCase();
    const entries = Array.isArray(manifest && manifest.ask) ? manifest.ask : [];
    const hit = entries.find((e) => e && e.match && e.file && q.includes(String(e.match).toLowerCase()));
    if (hit) {
      const rec = await fetchRecording([cleanName(hit.file)], signal);
      if (rec) {
        await sleep(DELAY_MS.ask - (Date.now() - t0) * SPEED, signal);
        return new Response(rec.text, { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    await sleep(DELAY_MS.ask - (Date.now() - t0) * SPEED, signal);
    const topics = entries
      .map((e) => e && (e.question || e.match))
      .filter(Boolean)
      .map((t) => `- ${t}`)
      .join("\n");
    return jsonResponse({
      answer_markdown:
        "**Static demo.** Answering new questions from the textbook needs the full app " +
        "(the Python backend and a Gemini key). This page only replays recorded answers." +
        (topics ? `\n\nRecorded questions you can try:\n${topics}` : ""),
      citations: [],
    });
  }

  /** Answer one /api/ request from the recordings. */
  async function serveApi(route, bodyText, signal) {
    const body = parseJson(bodyText) || {};
    const manifest = await loadManifest();
    let scenario;
    switch (route) {
      case "/intake":
        scenario = scenarioForIntake(body.description);
        state.scenario = scenario;
        return replayJson(manifest, scenario, "intake", signal);
      case "/spiral/run-sync":
        scenario = state.scenario = scenarioForSpec(specOf(body));
        return replayJson(manifest, scenario, "spiral_sync", signal);
      case "/spiral/stream":
        scenario = state.scenario = scenarioForSpec(specOf(body));
        return replaySse(manifest, scenario, "spiral", signal);
      case "/components/spar":
        scenario = state.scenario = scenarioForSpec(specOf(body));
        return replayJson(manifest, scenario, "spar_sync", signal);
      case "/components/spar/stream":
        scenario = state.scenario = scenarioForSpec(specOf(body));
        return replaySse(manifest, scenario, "spar", signal);
      case "/report":
        scenario = state.scenario = scenarioForSpec(body.state && body.state.spec);
        return replayJson(manifest, scenario, "report", signal);
      case "/ask":
        return replayAsk(manifest, body.question, signal);
      default:
        return jsonResponse({ detail: `Static demo: /api${route} is not available without the backend.` }, 404);
    }
  }

  // ---------------------------------------------------------------- probe + dispatch
  function looksLikeNoBackend(res) {
    if (res.status === 404 || res.status === 405 || res.status === 501) return true;
    const type = (res.headers && res.headers.get("content-type")) || "";
    return res.ok && /text\/html/i.test(type); // a static host answering with a web page
  }

  /** A public page (e.g. GitHub Pages) calling a backend on localhost cannot be a live setup. */
  function backendUnreachableByDesign(u) {
    try {
      const page = new URL(document.baseURI || location.href);
      if (!/^https?:$/.test(page.protocol)) return false;
      return !isLocalHost(page.hostname) && isLoopbackHost(u.hostname) && u.origin !== page.origin;
    } catch (_) {
      return false;
    }
  }

  async function handleApi(input, init, u, route) {
    if (state.mode === "live") return realFetch(input, init);

    const signal = (init && init.signal) || (isRequest(input) ? input.signal : undefined) || undefined;
    const bodyText = await readBodyText(input, init);

    if (state.mode === "unknown" && backendUnreachableByDesign(u)) {
      enableDemo("page is on a public host and the API points at localhost");
    }
    if (state.mode === "demo") return serveApi(route, bodyText, signal);

    // Mode unknown: this real call is the probe. Calls made before the answer arrives
    // probe on their own (never queued behind a slow live run-sync); the first
    // conclusive answer is remembered for the rest of the page's life.
    let res;
    try {
      res = await realFetch(input, init);
    } catch (err) {
      if ((err && err.name === "AbortError") || (signal && signal.aborted)) throw err; // cancelled
      if (state.mode === "live") throw err; // backend is known to be up: a genuine error
      enableDemo(`no backend: could not reach ${u.origin}`);
      return serveApi(route, bodyText, signal);
    }
    if (state.mode !== "live" && looksLikeNoBackend(res)) {
      try {
        if (res.body) res.body.cancel().catch(() => {});
      } catch (_) {}
      enableDemo(`no backend: HTTP ${res.status} from ${u.origin}${u.pathname}`);
      return serveApi(route, bodyText, signal);
    }
    if (state.mode === "unknown") state.mode = "live";
    return res;
  }

  function assetInit(input, init) {
    if (init) return init;
    if (isRequest(input)) return { method: "GET", headers: input.headers, cache: input.cache, signal: input.signal };
    return undefined;
  }

  async function fetchArtifact(rest, input, init) {
    const opts = assetInit(input, init);
    const names = [`artifacts/${state.scenario}/${rest}`, `artifacts/${rest}`];
    let last = null;
    for (const name of names) {
      last = await realFetch(demoUrl(name), opts);
      if (last.ok) return last;
    }
    return last;
  }

  function staticDemoFetch(input, init) {
    let u;
    let c;
    try {
      u = resolveUrl(input);
      c = classify(u);
    } catch (_) {
      return realFetch(input, init);
    }
    if (!c) return realFetch(input, init);
    if (c.kind === "api") return handleApi(input, init, u, c.route);
    if (state.mode !== "demo") return realFetch(input, init);
    if (c.kind === "demo") return realFetch(demoUrl(c.rest), assetInit(input, init));
    if (c.kind === "artifact") return fetchArtifact(c.rest, input, init);
    return realFetch(input, init);
  }

  window.fetch = staticDemoFetch;

  // ---------------------------------------------------------------- download links
  // Download links are set as <a>.href (not fetched), and resolveArtifactUrl() prefixes
  // API_BASE onto the recordings' ./demo/... paths. In demo mode, point them at ./demo/.
  function rewriteLink(value) {
    if (state.mode !== "demo" || value == null) return value;
    try {
      const u = new URL(String(value), document.baseURI || location.href);
      const c = classify(u);
      if (c && c.kind === "demo") return demoUrl(c.rest);
      if (c && c.kind === "artifact") return demoUrl(`artifacts/${state.scenario}/${c.rest}`);
    } catch (_) {}
    return value;
  }

  try {
    const proto = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "href");
    if (desc && desc.set && desc.get && desc.configurable) {
      Object.defineProperty(proto, "href", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(value) {
          desc.set.call(this, rewriteLink(value));
        },
      });
    }
  } catch (_) {
    /* leave anchors alone */
  }

  if (typeof document.addEventListener === "function") {
    // Catch links set through setAttribute/innerHTML too, just before they are followed.
    const fixLink = (event) => {
      if (state.mode !== "demo") return;
      const a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!a) return;
      const raw = a.getAttribute("href");
      const next = rewriteLink(raw);
      if (next !== raw) a.setAttribute("href", next);
    };
    document.addEventListener("pointerdown", fixLink, true);
    document.addEventListener("click", fixLink, true);
  }

  if (state.mode === "demo") showBanner();

  window.__spiralStaticDemo = {
    get mode() {
      return state.mode;
    },
    get reason() {
      return state.reason;
    },
    get scenario() {
      return state.scenario;
    },
    demoBase: DEMO_BASE,
    scenarios: SCENARIOS.slice(),
    enable: (reason) => enableDemo(reason || "enabled from the console"),
    realFetch,
    // exposed for tests
    _scenarioForIntake: scenarioForIntake,
    _scenarioForSpec: scenarioForSpec,
    _splitSseFrames: splitSseFrames,
  };
})();
