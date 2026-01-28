import { Composition } from 'remotion';
import { VideoComposition } from './Video';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="VideoComposition"
        component={VideoComposition}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
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
