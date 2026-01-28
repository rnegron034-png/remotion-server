import React from 'react';
import { Composition } from 'remotion';
import Video from './Video.jsx';

export default function Root() {
  return (
    <Composition
      id="VideoComposition"
      component={Video}
      fps={30}
      width={720}
      height={1280}
      durationInFrames={300} // ← placeholder, will be overridden
      defaultProps={{
        scene: {
          src: '',
          durationInFrames: 300,
        },
      }}
    />
  );
}
