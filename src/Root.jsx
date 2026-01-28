import { Composition } from 'remotion';
import { VideoComposition } from './Video';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="VideoComposition"
        component={VideoComposition}
        durationInFrames={300} // Default, overridden by inputProps
        fps={30}
        width={1080}
        height={1920} // 9:16 vertical
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
