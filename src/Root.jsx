import React from 'react';
import { Composition } from 'remotion';
import { Video } from './Video';

export const Root = () => {
  return (
    <Composition
      id="VideoComposition"
      component={Video}
      fps={30}
      width={720}     // 🚨 DO NOT CHANGE (Railway-safe)
      height={1280}   // 🚨 DO NOT CHANGE (Railway-safe)
      durationInFrames={1} // overridden per scene
    />
  );
};
