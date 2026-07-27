import { Composition } from "remotion";
import { Hero, HERO_DURATION_SECONDS, HERO_FPS, HERO_HEIGHT, HERO_WIDTH } from "./compositions/Hero";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Hero"
        component={Hero}
        durationInFrames={HERO_DURATION_SECONDS * HERO_FPS}
        fps={HERO_FPS}
        width={HERO_WIDTH}
        height={HERO_HEIGHT}
      />
    </>
  );
};
