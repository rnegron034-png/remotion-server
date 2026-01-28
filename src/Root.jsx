import { Composition } from 'remotion';
import { VideoComposition } from './Video';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
  id="VideoComposition"
  component={VideoSequence}
  durationInFrames={scene.durationInFrames}
  fps={30}
  width={720}
  height={1280}
/>
        defaultProps={{
          scene: {
            src: '',
            durationInFrames: 300,
          },
          subtitles: [],
        }}
      />
    </>
  );
};
