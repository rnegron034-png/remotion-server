import React from 'react';
import { Composition, staticFile } from 'remotion';
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
      calculateMetadata={async ({ props }) => {
        // Props from CLI are now available here
        const scenes = props?.scenes || [];
        const totalDuration = scenes.length * 150; // 150 frames per scene
        
        return {
          durationInFrames: totalDuration > 0 ? totalDuration : 300,
          props: props || { scenes: [], audio: null }
        };
      }}
    />
  );
};
