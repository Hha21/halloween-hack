/**
 * Typed HTTP & SSE client matching Section 8.6 of DESIGN_SPEC.md (Owner: Tharm).
 */

const API_BASE = window.location.port === "8000" ? "" : "http://localhost:8000";

export async function parseIntake(description) {
  const res = await fetch(`${API_BASE}/api/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(`Intake failed: ${res.statusText}`);
  return res.json();
}

export async function runSpiralSync(spec) {
  const res = await fetch(`${API_BASE}/api/spiral/run-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!res.ok) throw new Error(`Spiral run failed: ${res.statusText}`);
  return res.json();
}

export async function runSparDetailed(state) {
  const res = await fetch(`${API_BASE}/api/components/spar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`Detailed spar failed: ${res.statusText}`);
  return res.json();
}

export async function generateReport(state) {
  const res = await fetch(`${API_BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) throw new Error(`Report failed: ${res.statusText}`);
  return res.json();
}
