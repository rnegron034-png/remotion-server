import React from 'react';
import { Series, Video, Audio } from 'remotion';

export const VideoSequence = (props) => {
  const scenes = props?.scenes || [];
  const audio = props?.audio || null;

  if (scenes.length === 0) {
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          if (!scene || !scene.src) {
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
