import React from 'react';
import { Video as RemotionVideo, AbsoluteFill, useCurrentFrame } from 'remotion';

export default function Video({ scene, subtitles = [] }) {
  const frame = useCurrentFrame();
  const time = frame / 30;

  const current = subtitles.find(
    s => time >= s.start && time <= s.end
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <RemotionVideo
        src={scene.src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />

      {current && (
        <div
          style={{
            position: 'absolute',
            bottom: '8%',
            width: '100%',
            textAlign: 'center',
            color: 'white',
            fontSize: 48,
            fontWeight: 'bold',
            textShadow: '0 0 10px black',
            padding: '0 40px',
          }}
        >
          {current.text}
        </div>
      )}
    </AbsoluteFill>
  );
}
