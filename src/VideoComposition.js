import React from 'react';
import { Composition } from 'remotion';
import { VideoSequence } from './VideoSequence.js';

export const VideoComposition = () => (
  <Composition
    id="VideoComposition"
    component={VideoSequence}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={150}
  />
);
