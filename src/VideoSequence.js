import React from 'react';
import {
  Series,
  Video,
  Audio,
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from 'remotion';

const Scene = ({ src, subtitle }) => {
  const frame = useCurrentFrame();

  // 🔥 first-frame hook
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const scale = interpolate(frame, [0, 10], [1.06, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Video
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity,
          transform: `scale(${scale})`,
        }}
      />

      {subtitle && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            paddingBottom: 260,
          }}
        >
          <div
            style={{
              fontSize: 78,
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
            {subtitle}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export const VideoSequence = ({ scenes = [], audio = null }) => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => (
          <Series.Sequence key={index} durationInFrames={150}>
            <Scene
              src={scene.src}
              subtitle={scene.subtitle}
            />
          </Series.Sequence>
        ))}
      </Series>

      {audio?.src && <Audio src={audio.src} />}
    </>
  );
};
