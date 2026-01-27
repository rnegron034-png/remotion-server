import React from 'react';
import { Composition } from 'remotion';
import { VideoSequence } from './VideoSequence.js';

export const VideoComposition = () => {
  return (
    <Composition
      id="VideoComposition"
      component={VideoSequence}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{}}
    />
  );
};
