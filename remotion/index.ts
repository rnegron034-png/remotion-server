import { registerRoot, Composition } from "remotion";
import { Video } from "./CreateVideo";

registerRoot(() => {
  return (
    <>
      <Composition
        id="Video"
        component={Video}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={900}
      />
    </>
  );
});
