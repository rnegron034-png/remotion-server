import React from 'react';
import { Video as RemotionVideo } from 'remotion';

export const Video = ({ scene }) => {
  if (!scene?.src) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: 'black',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 48,
        }}
      >
        No scene source
      </div>
    );
  }

  return (
    <RemotionVideo
      src={scene.src}
      startFrom={0}
      endAt={scene.durationInFrames}
    />
  );
};
