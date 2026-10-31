import React from "react";
import { AbsoluteFill, Composition } from "remotion";
import { Demo, TOTAL_FRAMES } from "./Demo";

/* 1280x720 variant: same 1920x1080 layout, scaled down (faster to render). */
const Demo720: React.FC = () => (
  <AbsoluteFill style={{ background: "#070b14" }}>
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transform: "scale(0.6666667)", transformOrigin: "0 0" }}>
      <Demo />
    </div>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="SpiralDemo" component={Demo} durationInFrames={TOTAL_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="SpiralDemo720" component={Demo720} durationInFrames={TOTAL_FRAMES} fps={30} width={1280} height={720} />
  </>
);
