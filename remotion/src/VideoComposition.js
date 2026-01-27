import React from 'react';
import { Composition } from 'remotion';
import { VideoSequence } from './VideoSequence';

export const VideoComposition = () => {
  return (
    <Composition
      id="VideoComposition"
      component={VideoSequence}
      durationInFrames={300} // 10 seconds at 30fps (will be overridden by actual video length)
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
