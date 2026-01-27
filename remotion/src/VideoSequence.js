import React from 'react';
import { Series, Video, Audio, getInputProps } from 'remotion';

export const VideoSequence = () => {
  // CRITICAL FIX: Use getInputProps() to retrieve props from CLI
  const inputProps = getInputProps();
  const scenes = inputProps?.scenes || [];
  const audio = inputProps?.audio || null;

  console.log('VideoSequence received props:', inputProps);

  if (scenes.length === 0) {
    console.warn('No scenes provided to VideoSequence');
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          if (!scene || !scene.src) {
            console.warn(`Scene ${index} is missing src`);
            return null;
          }

          return (
            <Series.Sequence key={index} durationInFrames={150}>
              <Video src={scene.src} />
            </Series.Sequence>
          );
        })}
      </Series>

      {audio && audio.src && (
        <Audio src={audio.src} />
      )}
    </>
  );
};
