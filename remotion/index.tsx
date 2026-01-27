import { registerRoot, Composition } from 'remotion';
import { CreateVideo } from './Video';

registerRoot(() => {
  return (
    <>
      <Composition
        id="Video"  // ← Change this from "CreateVideo" to "Video"
        component={CreateVideo}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          scenes: [],
          audio: ''
        }}
      />
    </>
  );
});
