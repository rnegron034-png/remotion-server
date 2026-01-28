import React from 'react';
import {
  AbsoluteFill,
  Video,
  useCurrentFrame,
  interpolate,
} from 'remotion';

export const VideoSequence = ({ scenes }) => {
  // 🛡️ HARD GUARD (CRITICAL)
  if (!Array.isArray(scenes) || scenes.length === 0 || !scenes[0]?.src) {
    return (
      <AbsoluteFill style={{ backgroundColor: 'black' }}>
        {/* empty frame – prevents crash */}
      </AbsoluteFill>
    );
  }

  const scene = scenes[0];
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(frame, [0, 10], [1.05, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Video
        src={scene.src}
        startFrom={0}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity,
          transform: `scale(${scale})`,
        }}
      />

      {scene.subtitle && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            paddingBottom: 260,
          }}
        >
          <div
            style={{
              fontSize: 76,
              fontWeight: 900,
              color: '#fff',
              textAlign: 'center',
              background: 'rgba(0,0,0,0.55)',
              padding: '22px 36px',
              borderRadius: 22,
              width: '85%',
              margin: '0 auto',
              textShadow: '0 4px 14px rgba(0,0,0,0.9)',
            }}
          >
            {scene.subtitle}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
