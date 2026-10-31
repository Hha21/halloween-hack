import React from "react";
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CAPTIONS, SHOTS, FOOTAGE_FRAMES } from "./shots";

export const C = {
  bg: "#070b14",
  panel: "#0d1424",
  line: "#1c2740",
  sky: "#38bdf8",
  violet: "#a78bfa",
  green: "#34d399",
  red: "#f87171",
  amber: "#fbbf24",
  text: "#e7edf4",
  muted: "#8b98ab",
};
const DISPLAY = '"Inter Display", "Inter", sans-serif';
const SANS = '"Inter", sans-serif';
const MONO = '"Noto Sans Mono", "DejaVu Sans Mono", monospace';

const FADE = 15;
const COLD = 165;
const PROBLEM = 165;
const LOOP = 300;
const AGENTS = 210;
const PROOF = 225;
const OUTRO = 180;

const S_COLD = 0;
const S_PROBLEM = S_COLD + COLD - FADE;
const S_LOOP = S_PROBLEM + PROBLEM - FADE;
const S_FOOT = S_LOOP + LOOP - FADE;
const S_AGENTS = S_FOOT + FOOTAGE_FRAMES - FADE;
const S_PROOF = S_AGENTS + AGENTS - FADE;
const S_OUTRO = S_PROOF + PROOF - FADE;
export const TOTAL_FRAMES = S_OUTRO + OUTRO;

const ease = Easing.bezier(0.22, 0.8, 0.26, 1);

/* ---------- shared bits ---------- */

const Fader: React.FC<{ dur: number; children: React.ReactNode; fadeIn?: boolean; fadeOut?: boolean }> = ({
  dur,
  children,
  fadeIn = true,
  fadeOut = true,
}) => {
  const f = useCurrentFrame();
  const a = fadeIn ? interpolate(f, [0, FADE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const b = fadeOut ? interpolate(f, [dur - FADE, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return <AbsoluteFill style={{ opacity: Math.min(a, b) }}>{children}</AbsoluteFill>;
};

const Backdrop: React.FC = () => {
  const f = useCurrentFrame();
  const x = 50 + Math.sin(f / 90) * 8;
  const y = 40 + Math.cos(f / 110) * 6;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 800px at ${x}% ${y}%, rgba(56,189,248,0.10), transparent 60%),
          radial-gradient(900px 700px at ${100 - x}% ${100 - y}%, rgba(167,139,250,0.08), transparent 60%), ${C.bg}`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.045) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
    </AbsoluteFill>
  );
};

const useSpring = (delay: number, damping = 16, mass = 0.8) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping, mass, stiffness: 120 } });
};

const Rise: React.FC<{ delay: number; children: React.ReactNode; dist?: number; style?: React.CSSProperties }> = ({
  delay,
  children,
  dist = 26,
  style,
}) => {
  const s = useSpring(delay);
  return (
    <div style={{ opacity: s, transform: `translateY(${(1 - s) * dist}px)`, ...style }}>{children}</div>
  );
};

/* ---------- spiral logo ---------- */

const SPIRAL_D = "M24 139A104 104 0 0 1 232 139A82 82 0 0 1 68 139A60 60 0 0 1 188 139A38 38 0 0 1 112 139";
const SPIRAL_LEN = Math.PI * (104 + 82 + 60 + 38);

const SpiralMark: React.FC<{ size: number; draw: number; dot: number; glow?: number }> = ({ size, draw, dot, glow = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" style={{ overflow: "visible" }}>
    <defs>
      <filter id="glow" x="-200%" y="-200%" width="500%" height="500%">
        <feGaussianBlur stdDeviation={8 * glow} result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <path
      d={SPIRAL_D}
      fill="none"
      stroke={C.text}
      strokeWidth={20}
      strokeLinecap="round"
      strokeDasharray={SPIRAL_LEN}
      strokeDashoffset={SPIRAL_LEN * (1 - draw)}
    />
    <circle cx={150} cy={139} r={14 * dot} fill={C.sky} filter="url(#glow)" opacity={dot > 0.01 ? 1 : 0} />
  </svg>
);

/* ---------- 1. cold open ---------- */

const ColdOpen: React.FC = () => {
  const f = useCurrentFrame();
  const draw = interpolate(f, [4, 50], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const dot = useSpring(44, 9, 0.6);
  const pulse = 1 + 0.25 * Math.max(0, Math.sin((f - 48) / 9)) * (f > 48 ? 1 : 0);
  const lift = interpolate(f, [50, 80], [0, -40], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const halo = interpolate(f, [44, 58, 100], [0, 1, 0.55], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `translateY(${lift}px)` }}>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 520,
              height: 520,
              marginLeft: -260 + 22,
              marginTop: -260 + 6,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(56,189,248,0.35), rgba(56,189,248,0) 60%)",
              opacity: halo,
            }}
          />
          <SpiralMark size={300} draw={draw} dot={dot} glow={pulse} />
        </div>
        <Rise delay={54} style={{ marginTop: 18 }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 132, color: C.text, letterSpacing: -3 }}>Spiral</div>
        </Rise>
        <Rise delay={68}>
          <div style={{ fontFamily: SANS, fontSize: 40, color: C.muted, marginTop: 4 }}>
            Describe the aircraft. <span style={{ color: C.sky }}>Watch the design spiral close.</span>
          </div>
        </Rise>
        <Rise delay={78}>
          <div
            style={{
              marginTop: 34,
              fontFamily: MONO,
              fontSize: 26,
              letterSpacing: 1,
              color: C.text,
              padding: "12px 26px",
              borderRadius: 999,
              border: `1.5px solid ${C.violet}88`,
              background: "rgba(167,139,250,0.10)",
              boxShadow: `0 0 40px ${C.violet}22`,
            }}
          >
            <span style={{ color: C.violet, fontWeight: 700 }}>Track 1</span> · Frontier Agents with Gemini ·{" "}
            <span style={{ color: C.violet }}>built with Gemini 4 Argon</span>
          </div>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 2. problem ---------- */

const LoopDiagram: React.FC = () => {
  const f = useCurrentFrame();
  const R = 190;
  const cx = 260;
  const cy = 260;
  const nodes = [
    { label: "Weight", a: -90, color: C.sky },
    { label: "Wing", a: 30, color: C.violet },
    { label: "Structure", a: 150, color: C.green },
  ];
  const appear = useSpring(20);
  const t = Math.max(0, f - 40);
  const lapFrames = 54;
  const angle = -90 + ((t % lapFrames) / lapFrames) * 360;
  const lap = Math.floor(t / lapFrames) + 1;
  const dotX = cx + R * Math.cos((angle * Math.PI) / 180);
  const dotY = cy + R * Math.sin((angle * Math.PI) / 180);
  const arc = (a0: number, a1: number) => {
    const p0 = [cx + R * Math.cos((a0 * Math.PI) / 180), cy + R * Math.sin((a0 * Math.PI) / 180)];
    const p1 = [cx + R * Math.cos((a1 * Math.PI) / 180), cy + R * Math.sin((a1 * Math.PI) / 180)];
    return `M${p0[0]} ${p0[1]} A${R} ${R} 0 0 1 ${p1[0]} ${p1[1]}`;
  };
  return (
    <div style={{ position: "relative", width: 520, height: 560, opacity: appear, transform: `scale(${0.9 + 0.1 * appear})` }}>
      <svg width={520} height={520} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#475569" />
          </marker>
          <filter id="g2" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        {nodes.map((n, i) => {
          const a0 = n.a + 24;
          const a1 = nodes[(i + 1) % 3].a - 24 + (i === 2 ? 360 : 0);
          return <path key={i} d={arc(a0, a1)} stroke="#334155" strokeWidth={4} fill="none" markerEnd="url(#arr)" />;
        })}
        {f > 40 && (
          <>
            <circle cx={dotX} cy={dotY} r={16} fill={C.amber} filter="url(#g2)" opacity={0.9} />
            <circle cx={dotX} cy={dotY} r={8} fill="#fde68a" />
          </>
        )}
      </svg>
      {nodes.map((n, i) => {
        const x = cx + R * Math.cos((n.a * Math.PI) / 180);
        const y = cy + R * Math.sin((n.a * Math.PI) / 180);
        let d = Math.abs(((angle - n.a + 540) % 360) - 180);
        d = 180 - d;
        const hot = f > 40 ? Math.max(0, 1 - d / 40) : 0;
        return (
          <div
            key={n.label}
            style={{
              position: "absolute",
              left: x,
              top: y,
              transform: `translate(-50%, -50%) scale(${1 + 0.08 * hot})`,
              padding: "16px 26px",
              borderRadius: 18,
              background: C.panel,
              border: `2px solid ${n.color}`,
              boxShadow: `0 0 ${10 + 40 * hot}px ${n.color}${hot > 0.05 ? "aa" : "33"}`,
              fontFamily: SANS,
              fontWeight: 600,
              fontSize: 30,
              color: C.text,
              whiteSpace: "nowrap",
            }}
          >
            {n.label}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: cx,
          top: cy,
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          fontFamily: MONO,
          color: C.muted,
          fontSize: 24,
          lineHeight: 1.5,
        }}
      >
        <div style={{ color: C.amber, fontSize: 40, fontWeight: 700 }}>lap {f > 40 ? lap : 0}</div>
        <div>≈ {f > 40 ? lap * 3 : 0} weeks</div>
      </div>
    </div>
  );
};

const Problem: React.FC = () => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 110, width: 1660 }}>
      <div style={{ flex: 1 }}>
        <Rise delay={6}>
          <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, color: C.sky, marginBottom: 26 }}>THE PROBLEM</div>
        </Rise>
        <Rise delay={12}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 76, lineHeight: 1.08, color: C.text, letterSpacing: -1.5 }}>
            Aircraft design is a spiral.
          </div>
        </Rise>
        <Rise delay={34}>
          <div style={{ fontFamily: SANS, fontSize: 42, lineHeight: 1.35, color: C.muted, marginTop: 30 }}>
            Every lap of sizing changes the <span style={{ color: C.text }}>weight</span>,
            <br />
            and every lap takes <span style={{ color: C.amber }}>weeks</span>.
          </div>
        </Rise>
      </div>
      <LoopDiagram />
    </div>
  </AbsoluteFill>
);

/* ---------- 3. footage ---------- */

const WIN_W = 1664;
const WIN_H = 936;
const BAR = 38;

const Shot: React.FC<{ shot: (typeof SHOTS)[number] }> = ({ shot }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [0, shot.dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.sin) });
  const z0 = shot.zoom?.[0] ?? 1;
  const z1 = shot.zoom?.[1] ?? 1;
  const o0 = shot.origin?.[0] ?? [50, 50];
  const o1 = shot.origin?.[1] ?? o0;
  const scale = z0 + (z1 - z0) * p;
  const ox = o0[0] + (o1[0] - o0[0]) * p;
  const oy = o0[1] + (o1[1] - o0[1]) * p;
  const fade = interpolate(f, [0, 8, shot.dur - 8, shot.dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: shot.first ? Math.min(1, fade + (f < 8 ? 1 : 0)) : fade }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${ox}% ${oy}%` }}>
        <OffthreadVideo
          src={staticFile(`clips/${shot.clip}.mp4`)}
          trimBefore={Math.round(shot.from * 30)}
          playbackRate={shot.rate ?? 1}
          muted
          style={{ width: "100%", height: "100%" }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ cap: (typeof CAPTIONS)[number] }> = ({ cap }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 15, mass: 0.7 } });
  const out = interpolate(f, [cap.dur - 10, cap.dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 54,
        display: "flex",
        justifyContent: "center",
        opacity: s * out,
        transform: `translateY(${(1 - s) * 30}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "18px 34px 18px 22px",
          borderRadius: 20,
          background: "rgba(7,11,20,0.86)",
          border: `1.5px solid ${cap.color}66`,
          boxShadow: `0 18px 60px rgba(0,0,0,0.55), 0 0 40px ${cap.color}22`,
          maxWidth: 1800,
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: 2.5,
            color: C.bg,
            background: cap.color,
            borderRadius: 10,
            padding: "8px 14px",
            whiteSpace: "nowrap",
          }}
        >
          {cap.tag}
        </div>
        <div style={{ fontFamily: SANS, fontSize: cap.text.length > 56 ? 33 : 40, fontWeight: 600, color: C.text, letterSpacing: -0.3, whiteSpace: "nowrap" }}>
          {cap.text}
        </div>
      </div>
    </div>
  );
};

const Footage: React.FC = () => {
  const f = useCurrentFrame();
  const enter = spring({ frame: f, fps: 30, config: { damping: 18, mass: 0.9 } });
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: (1920 - WIN_W) / 2,
          top: 26,
          width: WIN_W,
          height: WIN_H + BAR,
          borderRadius: 18,
          overflow: "hidden",
          background: "#0b1120",
          border: "1px solid #24324d",
          boxShadow: "0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(56,189,248,0.06)",
          transform: `translateY(${(1 - enter) * 40}px) scale(${0.96 + 0.04 * enter})`,
        }}
      >
        <div style={{ height: BAR, display: "flex", alignItems: "center", gap: 9, padding: "0 16px", background: "#0f172a", borderBottom: "1px solid #1e293b" }}>
          {["#f87171", "#fbbf24", "#34d399"].map((c) => (
            <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c, opacity: 0.8 }} />
          ))}
          <div
            style={{
              marginLeft: 18,
              fontFamily: MONO,
              fontSize: 17,
              color: "#94a3b8",
              background: "#0b1120",
              border: "1px solid #1e293b",
              borderRadius: 8,
              padding: "4px 16px",
            }}
          >
            localhost:8000 · Spiral
          </div>
          <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 16, color: "#64748b" }}>recorded from the running app</div>
        </div>
        <div style={{ position: "relative", width: WIN_W, height: WIN_H, overflow: "hidden" }}>
          {SHOTS.map((s, i) => (
            <Sequence key={i} from={s.at} durationInFrames={s.dur} layout="none">
              <AbsoluteFill>
                <Shot shot={s} />
              </AbsoluteFill>
            </Sequence>
          ))}
        </div>
      </div>
      {CAPTIONS.map((c, i) => (
        <Sequence key={i} from={c.at} durationInFrames={c.dur} layout="none">
          <Caption cap={c} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

/* ---------- 4. proof ---------- */

const Counter: React.FC<{ to: number; delay: number; dur?: number }> = ({ to, delay, dur = 40 }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [delay, delay + dur], [0, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return <>{Math.round(v).toLocaleString("en-GB")}</>;
};

const Stat: React.FC<{ n: number; label: string; delay: number; color: string; suffix?: React.ReactNode }> = ({ n, label, delay, color, suffix }) => (
  <Rise delay={delay}>
    <div style={{ textAlign: "center", minWidth: 330 }}>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 132, color, letterSpacing: -3, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        <Counter to={n} delay={delay} />
        {suffix}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 36, color: C.muted, marginTop: 12 }}>{label}</div>
    </div>
  </Rise>
);

const Proof: React.FC = () => {
  const f = useCurrentFrame();
  const check = useSpring(150, 10);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Rise delay={4}>
        <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, color: C.sky, textAlign: "center" }}>GROUNDED IN THE TEXTBOOK</div>
      </Rise>
      <div style={{ display: "flex", gap: 70, marginTop: 34 }}>
        <Stat n={692} label="equations" delay={10} color={C.text} />
        <Stat n={118} label="tables" delay={18} color={C.text} />
        <Stat n={886} label="rules" delay={26} color={C.text} />
      </div>
      <Rise delay={44}>
        <div style={{ fontFamily: SANS, fontSize: 34, color: C.muted, marginTop: 26 }}>
          extracted from <span style={{ color: C.text, fontStyle: "italic" }}>Raymer, Aircraft Design</span>, 2nd ed.
        </div>
      </Rise>
      <div style={{ width: 1100, height: 1, background: C.line, margin: "48px 0 40px", opacity: interpolate(f, [70, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} />
      <div style={{ display: "flex", gap: 120, alignItems: "flex-start" }}>
        <Stat n={596} label="critic-confirmed" delay={90} color={C.green} />
        <Rise delay={120}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 132, color: C.green, letterSpacing: -3, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              <Counter to={101} delay={120} /> <span style={{ color: "#1f7a5a" }}>/</span> 101
              <span style={{ display: "inline-block", marginLeft: 26, transform: `scale(${check})`, fontSize: 96 }}>✓</span>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 36, color: C.muted, marginTop: 12 }}>numbers carry a source</div>
          </div>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 5. outro ---------- */

const Outro: React.FC = () => {
  const f = useCurrentFrame();
  const words: [string, string, number][] = [
    ["Gemini decides", C.violet, 14],
    ["Python computes", C.sky, 32],
    ["a critic verifies", C.green, 50],
  ];
  const draw = interpolate(f, [0, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const dot = useSpring(34, 10);
  const end = interpolate(f, [OUTRO - 24, OUTRO], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: end }}>
      <div style={{ display: "flex", alignItems: "center", gap: 26, marginBottom: 50 }}>
        <SpiralMark size={110} draw={draw} dot={dot} />
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 96, color: C.text, letterSpacing: -2, opacity: draw }}>Spiral</div>
      </div>
      <div style={{ display: "flex", gap: 28, alignItems: "baseline", fontFamily: SANS, fontWeight: 600, fontSize: 50 }}>
        {words.map(([w, c, d], i) => (
          <React.Fragment key={w}>
            {i > 0 && (
              <Rise delay={d - 4}>
                <span style={{ color: "#475569" }}>·</span>
              </Rise>
            )}
            <Rise delay={d}>
              <span style={{ color: c }}>{w}</span>
            </Rise>
          </React.Fragment>
        ))}
      </div>
      <Rise delay={80}>
        <div style={{ fontFamily: SANS, fontSize: 34, color: C.muted, marginTop: 64 }}>
          <span style={{ color: C.text }}>Harry &amp; Tharm</span> · Halloween at Imperial: Gemini Edition ·{" "}
          <span style={{ color: C.violet }}>Track 1 · Frontier Agents with Gemini</span>
        </div>
      </Rise>
    </AbsoluteFill>
  );
};


/* ---------- agent loop ---------- */

const STEPS: { name: string; who: string; color: string; detail: string }[] = [
  { name: "Read", who: "Intake agent · Gemini", color: C.violet, detail: "The intake agent (Gemini) reads the mission and quotes your words back." },
  { name: "Act", who: "Python tools", color: C.sky, detail: "Python tools size the aircraft from Raymer, lap by lap." },
  {
    name: "Verify",
    who: "Spiral · checks · critic",
    color: C.green,
    detail: "The spiral checks convergence. Every Gemini sentence is number-checked against the design state, with a retry. A critic model verified the textbook extraction.",
  },
  { name: "Decide", who: "Design lead · Gemini", color: C.violet, detail: "The design lead (Gemini) chooses between options Python verified, by your intent." },
  { name: "Loop", who: "Until it closes", color: C.amber, detail: "Re-run the spiral until the design closes." },
];

const AgentLoop: React.FC = () => {
  const f = useCurrentFrame();
  const STEP = 44;
  const T0 = 58;
  const active = f < T0 ? -1 : Math.min(STEPS.length - 1, Math.floor((f - T0) / STEP));
  const local = f - T0 - Math.max(0, active) * STEP;
  const allOn = f >= T0 + STEPS.length * STEP;
  const CW = 290;
  const GAP = 52;
  const total = STEPS.length * CW + (STEPS.length - 1) * GAP;
  const x0 = (1920 - total) / 2;
  const retDraw = interpolate(f, [T0 + 4 * STEP, T0 + 4 * STEP + 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const yCard = 420;
  const hCard = 170;
  const retPath = `M${x0 + 4 * (CW + GAP) + CW / 2} ${yCard + hCard} C ${x0 + 4 * (CW + GAP) + CW / 2} ${yCard + hCard + 120}, ${x0 + CW / 2} ${yCard + hCard + 120}, ${x0 + CW / 2} ${yCard + hCard + 6}`;
  const detailOpacity = active < 0 ? 0 : interpolate(local, [0, 8, STEP - 6, STEP], [0, 1, 1, active === STEPS.length - 1 ? 1 : 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const st = STEPS[Math.max(0, active)];
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 120, left: 0, right: 0, textAlign: "center" }}>
        <Rise delay={2}>
          <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, color: C.violet }}>TRACK 1 · FRONTIER AGENTS WITH GEMINI</div>
        </Rise>
        <Rise delay={8}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 72, color: C.text, letterSpacing: -1.5, marginTop: 18 }}>
            An autonomous agent loop, with verification built in
          </div>
        </Rise>
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <marker id="la" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="#64748b" />
          </marker>
          <marker id="lr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill={C.amber} />
          </marker>
        </defs>
        {STEPS.slice(0, -1).map((_, i) => {
          const xa = x0 + i * (CW + GAP) + CW + 8;
          const on = interpolate(f, [18 + i * 10, 30 + i * 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return <line key={i} x1={xa} y1={yCard + hCard / 2} x2={xa + (GAP - 16) * on} y2={yCard + hCard / 2} stroke="#64748b" strokeWidth={3} markerEnd={on > 0.9 ? "url(#la)" : undefined} />;
        })}
        <path d={retPath} fill="none" stroke={C.amber} strokeWidth={3} strokeDasharray="1400" strokeDashoffset={1400 * (1 - retDraw)} markerEnd={retDraw > 0.95 ? "url(#lr)" : undefined} opacity={0.85} />
      </svg>
      {STEPS.map((stp, i) => {
        const appear = spring({ frame: f - (12 + i * 8), fps: 30, config: { damping: 15, mass: 0.7 } });
        const isOn = i === active || allOn;
        const done = active > i || allOn;
        const glow = isOn ? 1 : done ? 0.35 : 0;
        return (
          <div
            key={stp.name}
            style={{
              position: "absolute",
              left: x0 + i * (CW + GAP),
              top: yCard,
              width: CW,
              height: hCard,
              borderRadius: 22,
              background: C.panel,
              border: `2px solid ${glow > 0 ? stp.color : "#26324a"}`,
              boxShadow: `0 0 ${12 + 50 * glow}px ${stp.color}${glow > 0.5 ? "88" : glow > 0 ? "33" : "00"}`,
              opacity: appear,
              transform: `translateY(${(1 - appear) * 30}px) scale(${i === active && !allOn ? 1.06 : 1})`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 20, color: C.muted }}>0{i + 1}</div>
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 54, color: glow > 0 ? stp.color : C.text, letterSpacing: -1 }}>{stp.name}</div>
            <div style={{ fontFamily: SANS, fontSize: 21, color: C.muted }}>{stp.who}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", top: yCard + hCard + 150, left: 160, right: 160, textAlign: "center", opacity: detailOpacity }}>
        <div style={{ fontFamily: SANS, fontSize: 38, lineHeight: 1.4, color: C.text }}>
          <span style={{ color: st.color, fontWeight: 700 }}>{st.name}.</span> {st.detail}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- agents roster ---------- */

const AGENT_CARDS: { role: string; model: string; what: string; color: string }[] = [
  { role: "Intake agent", model: "Gemini 3.5 Flash", what: "reads and quotes your words", color: C.violet },
  { role: "Design lead", model: "Gemini 4 Argon", what: "chooses between options Python verified, by your intent", color: C.violet },
  { role: "Research agent", model: "Gemini 4 Argon", what: "answers only from critic-verified textbook items", color: C.violet },
  { role: "Report agent", model: "Gemini 4 Argon", what: "number-checked narrative", color: C.violet },
  { role: "Critic", model: "Gemini 3.1 Pro", what: "verified 692 extracted equations against the scanned pages (596 confirmed)", color: C.green },
];

const Agents: React.FC = () => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
    <Rise delay={2}>
      <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, color: C.violet, textAlign: "center" }}>THE AGENTS</div>
    </Rise>
    <Rise delay={6}>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 64, color: C.text, letterSpacing: -1.2, marginTop: 14, marginBottom: 46, textAlign: "center" }}>
        Built with <span style={{ color: C.violet }}>Gemini 4 Argon</span>
      </div>
    </Rise>
    <div style={{ display: "flex", flexDirection: "column", gap: 18, width: 1500 }}>
      {AGENT_CARDS.map((a, i) => (
        <Rise key={a.role} delay={16 + i * 9} dist={20}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 30,
              padding: "20px 30px",
              borderRadius: 18,
              background: C.panel,
              border: `1.5px solid ${a.color}55`,
            }}
          >
            <div style={{ width: 300, fontFamily: SANS, fontWeight: 700, fontSize: 32, color: C.text }}>{a.role}</div>
            <div style={{ width: 300, fontFamily: MONO, fontSize: 26, color: a.color }}>{a.model}</div>
            <div style={{ flex: 1, fontFamily: SANS, fontSize: 28, color: C.muted }}>{a.what}</div>
          </div>
        </Rise>
      ))}
    </div>
  </AbsoluteFill>
);

/* ---------- composition ---------- */

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Backdrop />
    <Sequence from={S_COLD} durationInFrames={COLD}>
      <Fader dur={COLD} fadeIn={false}>
        <ColdOpen />
      </Fader>
    </Sequence>
    <Sequence from={S_PROBLEM} durationInFrames={PROBLEM}>
      <Fader dur={PROBLEM}>
        <Problem />
      </Fader>
    </Sequence>
    <Sequence from={S_LOOP} durationInFrames={LOOP}>
      <Fader dur={LOOP}>
        <AgentLoop />
      </Fader>
    </Sequence>
    <Sequence from={S_FOOT} durationInFrames={FOOTAGE_FRAMES}>
      <Fader dur={FOOTAGE_FRAMES}>
        <Footage />
      </Fader>
    </Sequence>
    <Sequence from={S_AGENTS} durationInFrames={AGENTS}>
      <Fader dur={AGENTS}>
        <Agents />
      </Fader>
    </Sequence>
    <Sequence from={S_PROOF} durationInFrames={PROOF}>
      <Fader dur={PROOF}>
        <Proof />
      </Fader>
    </Sequence>
    <Sequence from={S_OUTRO} durationInFrames={OUTRO}>
      <Fader dur={OUTRO} fadeOut={false}>
        <Outro />
      </Fader>
    </Sequence>
  </AbsoluteFill>
);
