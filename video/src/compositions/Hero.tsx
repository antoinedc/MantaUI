import { AbsoluteFill } from "remotion";

export const HERO_WIDTH = 1920;
export const HERO_HEIGHT = 1080;
export const HERO_FPS = 30;
export const HERO_DURATION_SECONDS = 1;

export const Hero: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0d1530",
        backgroundImage: "linear-gradient(160deg,#0d1530,#1a1240 60%,#0a0f22)",
      }}
    />
  );
};
