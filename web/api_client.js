/**
 * Typed HTTP & SSE client matching Section 8.6 of DESIGN_SPEC.md (Owner: Tharm).
 *
 * Implements POST-based Server-Sent Events (SSE) streaming via fetch() + ReadableStream
 * since browser EventSource only supports GET requests.
 */

export const API_BASE = window.location.port === "8000" ? "" : "http://localhost:8000";

/**
 * Helper to extract error details from a failed HTTP response.
 */
async function readErrorMessage(res, prefix) {
  try {
    const text = await res.text();
    if (!text) return `${prefix}: HTTP ${res.status} ${res.statusText}`;
    try {
      const json = JSON.parse(text);
      const detail = json.detail || json.message || text;
      return `${prefix}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    } catch {
      return `${prefix}: ${text}`;
    }
  } catch {
    return `${prefix}: HTTP ${res.status} ${res.statusText}`;
  }
}

/**
 * Parse a single SSE frame (`event: <name>\ndata: <json>`) and dispatch to handlers.
 */
function dispatchSseFrame(rawFrame, dispatchEvent) {
  const frame = rawFrame.trim();
  if (!frame) return;

  let eventType = "message";
  const dataLines = [];

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue; // ignore comments / heartbeats
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) return;
  const rawData = dataLines.join("\n");
  let parsedData;
  try {
    parsedData = JSON.parse(rawData);
  } catch (err) {
    console.warn("Failed to parse SSE JSON payload:", rawData, err);
    return;
  }

  dispatchEvent(eventType, parsedData);
}

/**
 * Core POST SSE reader using fetch() + ReadableStream + TextDecoder.
 *
 * @param {string} path - API endpoint path (e.g. "/api/spiral/stream")
 * @param {object} payload - Request JSON body
 * @param {function(string, object): void} onFrame - Callback invoked for each (eventType, data)
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel streaming
 */
export async function streamSsePost(path, payload, onFrame, signal) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, `SSE stream ${path} failed`);
    throw new Error(msg);
  }

  if (!res.body) {
    throw new Error(`SSE stream ${path} returned no readable body`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF if present so frame delimiter is always "\n\n"
      if (buffer.includes("\r")) {
        buffer = buffer.replace(/\r\n/g, "\n");
      }

      let boundaryIdx;
      while ((boundaryIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, boundaryIdx);
        buffer = buffer.slice(boundaryIdx + 2);
        dispatchSseFrame(rawFrame, onFrame);
      }
    }

    // Flush any remaining complete frame in the buffer
    if (buffer.trim().length > 0) {
      const trailingFrames = buffer.replace(/\r\n/g, "\n").split("\n\n");
      for (const frame of trailingFrames) {
        dispatchSseFrame(frame, onFrame);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore lock release errors
    }
  }
}

/**
 * POST /api/intake
 * Gemini parses plain-English prompt into MissionSpec and records defaulted fields.
 *
 * @param {string} description
 * @returns {Promise<{spec: object, sources: string[], assumptions: string[], warnings: string[]}>}
 */
export async function parseIntake(description) {
  const res = await fetch(`${API_BASE}/api/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Intake failed"));
  }
  return res.json();
}

/**
 * POST /api/spiral/run-sync
 * Runs the full conceptual + preliminary spar spiral loop and returns final DesignState.
 *
 * @param {object} spec - MissionSpec
 * @returns {Promise<object>} DesignState
 */
export async function runSpiralSync(spec) {
  const res = await fetch(`${API_BASE}/api/spiral/run-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Spiral run failed"));
  }
  return res.json();
}

/**
 * POST /api/spiral/stream
 * Streams live SSE events (`lap`, `log`, `converged`, `infeasible`, `error`) during the spiral loop.
 *
 * @param {object} spec - MissionSpec
 * @param {object} [handlers]
 * @param {function(string, object): void} [handlers.onEvent]
 * @param {function(object): void} [handlers.onLog] - receives data.entry (AgentLogEntry)
 * @param {function(object): void} [handlers.onLap] - receives { lap_record, sizing, loads, spar, geometry }
 * @param {function(object): void} [handlers.onConverged] - receives data.state (DesignState)
 * @param {function(object): void} [handlers.onInfeasible] - receives { reason, proposed_relaxation, state }
 * @param {function(object): void} [handlers.onError] - receives { message, tool_error }
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} Final DesignState if received
 */
export async function streamSpiral(spec, handlers = {}, signal) {
  let finalState = null;

  await streamSsePost(
    "/api/spiral/stream",
    { spec },
    (eventType, data) => {
      handlers.onEvent?.(eventType, data);
      switch (eventType) {
        case "log":
          handlers.onLog?.(data?.entry ?? data);
          break;
        case "lap":
          handlers.onLap?.(data);
          break;
        case "converged":
          finalState = data?.state ?? data;
          handlers.onConverged?.(finalState);
          break;
        case "infeasible":
          finalState = data?.state ?? null;
          handlers.onInfeasible?.(data);
          break;
        case "error":
          handlers.onError?.(data);
          break;
        default:
          break;
      }
    },
    signal
  );

  return finalState;
}

/**
 * POST /api/components/spar
 * Runs synchronous build_spar_cad + run_fea on the converged spar and returns updated DesignState.
 *
 * @param {object} state - DesignState
 * @returns {Promise<object>} Updated DesignState
 */
export async function runSparDetailed(state) {
  const res = await fetch(`${API_BASE}/api/components/spar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Detailed spar failed"));
  }
  return res.json();
}

/**
 * POST /api/components/spar/stream
 * Streams `component_step`, `log`, `component_done`, and `error` events during CAD + FEA execution.
 *
 * @param {object} state - DesignState
 * @param {object} [handlers]
 * @param {function(string, object): void} [handlers.onEvent]
 * @param {function(object): void} [handlers.onStep] - receives { component_id, step, status }
 * @param {function(object): void} [handlers.onLog] - receives data.entry (AgentLogEntry)
 * @param {function(object): void} [handlers.onDone] - receives { component_id, component, state }
 * @param {function(object): void} [handlers.onError] - receives { message, tool_error }
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} Updated DesignState if received
 */
export async function streamSparDetailed(state, handlers = {}, signal) {
  let finalState = null;

  await streamSsePost(
    "/api/components/spar/stream",
    { state },
    (eventType, data) => {
      handlers.onEvent?.(eventType, data);
      switch (eventType) {
        case "component_step":
          handlers.onStep?.(data);
          break;
        case "log":
          handlers.onLog?.(data?.entry ?? data);
          break;
        case "component_done":
          finalState = data?.state ?? null;
          handlers.onDone?.(data);
          break;
        case "error":
          handlers.onError?.(data);
          break;
        default:
          break;
      }
    },
    signal
  );

  return finalState;
}

/**
 * POST /api/report
 * Generates the source-cited markdown design report from the posted DesignState.
 *
 * @param {object} state - DesignState
 * @returns {Promise<{report_markdown: string, state: object}>}
 */
export async function generateReport(state) {
  const res = await fetch(`${API_BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Report generation failed"));
  }
  return res.json();
}

/**
 * GET /artifacts/spar_stress_mesh.json (or URL from ComponentStatus.artifact_urls.stress_mesh)
 * Fetches the 3D FEA stress mesh JSON for Three.js vertex-coloured rendering.
 *
 * @param {string} [artifactUrl="/artifacts/spar_stress_mesh.json"]
 * @returns {Promise<object>} Stress mesh JSON
 */
export async function fetchStressMesh(artifactUrl = "/artifacts/spar_stress_mesh.json") {
  const url = artifactUrl.startsWith("http")
    ? artifactUrl
    : `${API_BASE}${artifactUrl.startsWith("/") ? artifactUrl : `/${artifactUrl}`}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to fetch stress mesh (${url})`));
  }
  return res.json();
}

/**
 * Resolve an artifact URL against API_BASE for download links.
 *
 * @param {string} artifactPath
 * @returns {string}
 */
export function resolveArtifactUrl(artifactPath) {
  if (!artifactPath) return "#";
  if (artifactPath.startsWith("http")) return artifactPath;
  return `${API_BASE}${artifactPath.startsWith("/") ? artifactPath : `/${artifactPath}`}`;
}
