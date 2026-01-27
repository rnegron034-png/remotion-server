import React from 'react';
import { Series, Video, Audio, useVideoConfig } from 'remotion';

export const VideoSequence = (props) => {
  const { fps } = useVideoConfig();

  // CRITICAL FIX: Extract props with default values
  const scenes = props?.scenes || [];
  const audio = props?.audio || null;

  // Early return if no scenes
  if (scenes.length === 0) {
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          // Guard against invalid scene objects
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
