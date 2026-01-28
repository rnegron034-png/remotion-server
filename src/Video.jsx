import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export default function Video({ subtitles = [] }) {
  const frame = useCurrentFrame();
  const time = frame / 30;

  const active = subtitles.find(s => time >= s.start && time <= s.end);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'transparent',
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: 80,
      }}
    >
      {active && (
        <div
          style={{
            color: 'white',
            fontSize: 48,
            fontWeight: 'bold',
            textShadow: '0 0 10px black',
          }}
        >
          {active.text}
        </div>
      )}
    </AbsoluteFill>
  );
}
