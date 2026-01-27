import { Composition } from 'remotion';
import { CreateVideo } from './Video';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CreateVideo"
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
};
