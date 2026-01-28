import React from 'react';
import { Video as RemotionVideo, AbsoluteFill } from 'remotion';

export default function Video({ scene, subtitles }) {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <RemotionVideo
        src={scene.src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',   // 🔥 This forces 9:16 crop
        }}
      />
    </AbsoluteFill>
  );
}
