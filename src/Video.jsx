import React from 'react';
import { Video as RemotionVideo, AbsoluteFill } from 'remotion';

export default function Video({ scene }) {
  if (!scene?.src) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: 'black',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 48,
        }}
      >
        Missing scene source
      </AbsoluteFill>
    );
  }

  return (
    <RemotionVideo
      src={scene.src}
      startFrom={0}
      endAt={scene.durationInFrames}
    />
  );
}
