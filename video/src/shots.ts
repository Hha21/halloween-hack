/*
 * Footage edit list, computed from the capture marks (seconds from each clip's first frame).
 * Re-running capture.py rewrites public/clips/*.mp4 + marks.json, and the edit adapts.
 */
import marksJson from "../public/clips/marks.json";

type Marks = Record<string, Record<string, number>>;
const M = marksJson as unknown as Marks;
const FPS = 30;
const XF = 8; // crossfade overlap between shots, frames

export type ShotT = {
  clip: string;
  from: number;
  rate: number;
  dur: number;
  at: number;
  zoom?: [number, number];
  origin?: [[number, number], [number, number]];
  first?: boolean;
};
export type CaptionT = { at: number; dur: number; text: string; tag: string; color: string };

const SKY = "#38bdf8";
const VIOLET = "#a78bfa";
const GREEN = "#34d399";
const RED = "#f87171";

const shots: ShotT[] = [];
let t = 0;

const end = (clip: string) => (M[clip]?.end ?? 5) - 0.12;
const mk = (clip: string, k: string, dflt: number) => {
  const v = M[clip]?.[k];
  return typeof v === "number" && isFinite(v) ? v : dflt;
};

function add(
  clip: string,
  from: number,
  to: number,
  o: { rate?: number; maxSec?: number; zoom?: [number, number]; origin?: [[number, number], [number, number]] } = {}
): number {
  from = Math.max(0, from);
  to = Math.min(to, end(clip));
  const len = Math.max(0.6, to - from);
  let rate = o.rate ?? 1;
  if (o.maxSec && len / rate > o.maxSec) rate = len / o.maxSec;
  const dur = Math.max(12, Math.round((len / rate) * FPS));
  const at = shots.length ? t - XF : 0;
  shots.push({ clip, from, rate, dur, at, zoom: o.zoom, origin: o.origin, first: shots.length === 0 });
  t = at + dur;
  return at;
}

/* s1: landing, logo animates in */
const aLanding = add("s1_landing", 0, Math.min(end("s1_landing"), 3.6), { rate: 1, zoom: [1.0, 1.06], origin: [[50, 30], [50, 30]] });

/* s2: typing (sped up) then Gemini's reply types out */
const sent = mk("s2_compose", "sent", 6);
const reply = mk("s2_compose", "reply_done", sent + 4);
const aType = add("s2_compose", 0.5, sent + 0.2, { rate: 1.7, maxSec: 3.6, zoom: [1.0, 1.1], origin: [[50, 75], [50, 80]] });
const aReply = add("s2_compose", sent + 0.2, end("s2_compose"), {
  rate: 1.0,
  maxSec: 7.5,
  zoom: [1.0, 1.16],
  origin: [[50, 30], [50, 34]],
});

/* s3: run the spiral, laps stream, infeasible banner */
const banner = mk("s3_spiral", "banner", 4);
const aLaps = add("s3_spiral", 0, banner + 0.2, { rate: 1.0, maxSec: 6, zoom: [1.0, 1.04], origin: [[50, 50], [50, 50]] });
const aBanner = add("s3_spiral", banner + 0.2, end("s3_spiral"), { rate: 1.0, maxSec: 6, zoom: [1.06, 1.22], origin: [[44, 18], [46, 44]] });

/* s4: accept the relaxation, re-run, converge */
const conv = mk("s4_relax", "converged", 3);
const aRelax = add("s4_relax", 0, end("s4_relax"), { rate: 1.0, maxSec: 7, zoom: [1.14, 1.16], origin: [[56, 48], [48, 32]] });

/* s5: detailed CAD + FEA */
const fea = mk("s5_detailed", "fea_done", 4);
const aFea = add("s5_detailed", 0, end("s5_detailed"), { rate: 1.2, maxSec: 7, zoom: [1.0, 1.2], origin: [[50, 50], [56, 56]] });

/* s6: report, scroll to the textbook items table */
const ready = mk("s6_report", "ready", 4);
const cover = mk("s6_report", "cover", ready + 2.4);
const aRep1 = add("s6_report", 0, ready + 0.1, { rate: 1.6, maxSec: 3.0, zoom: [1.0, 1.0], origin: [[50, 50], [50, 50]] });
const aRepCover = add("s6_report", ready + 0.1, cover, { rate: 1.0, maxSec: 3.0, zoom: [1.0, 1.08], origin: [[35, 12], [35, 12]] });
const aRep2 = add("s6_report", cover, end("s6_report"), { rate: 1.0, maxSec: 6.5, zoom: [1.0, 1.2], origin: [[30, 60], [30, 66]] });
void aRepCover;

export const SHOTS = shots;
export const FOOTAGE_FRAMES = t + 10;

const shotEnd = (at: number) => {
  const s = shots.find((x) => x.at === at);
  return s ? s.at + s.dur : at + 90;
};
const cap = (from: number, to: number, text: string, tag: string, color: string): CaptionT => ({
  at: Math.round(from),
  dur: Math.max(45, Math.round(to - from)),
  text,
  tag,
  color,
});

void aLanding;
void aType;
void conv;
void fea;
void aRep1;

const shotAt = (at: number) => shots.find((x) => x.at === at) as ShotT;
const tIn = (at: number, sec: number) => {
  const sh = shotAt(at);
  return sh ? at + Math.round(((sec - sh.from) / sh.rate) * FPS) : at;
};
const bannerMid = aBanner + Math.round((shotEnd(aBanner) - aBanner) * 0.5);
const relaxClick = Math.max(tIn(aRelax, 2.4), aRelax + 30);
void relaxClick;

const relaxConv = Math.max(tIn(aRelax, 2.4), aRelax + 30);
const feaStart = aFea + 10;

export const CAPTIONS: CaptionT[] = [
  cap(aReply + 12, shotEnd(aReply) - 4, "Gemini reads your mission and quotes your words", "INTAKE AGENT", VIOLET),
  cap(aLaps + 10, shotEnd(aLaps) - 2, "4 laps, no human in the loop", "AUTONOMOUS DESIGN LOOP", SKY),
  cap(aBanner + 4, bannerMid, "MTOW 3,467 kg breaks the 2,722 kg class limit", "VERIFICATION", RED),
  cap(bannerMid + 2, relaxClick, "multi-step reasoning: keep the route, fly with 1 passenger", "DESIGN LEAD AGENT", VIOLET),
  cap(relaxConv + 2, feaStart, "the spiral re-runs and converges at 2,422 kg", "VERIFICATION LOOP", GREEN),
  cap(feaStart + 2, shotEnd(aFea) - 4, "CAD + 3D FEA re-check the spar against beam theory", "VERIFICATION", GREEN),
  cap(aRep1 + 6, shotEnd(aRep2) - 2, "every number checked before it's shown", "REPORT AGENT", VIOLET),
];
