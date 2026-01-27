import React from 'react';
import { Series, Video, Audio } from 'remotion';

export const VideoSequence = ({ scenes = [], audio = null }) => {
  // Log received props for debugging
  console.log('VideoSequence scenes:', scenes);
  console.log('VideoSequence audio:', audio);

  // Validate scenes
  if (!Array.isArray(scenes)) {
    console.error('scenes is not an array:', typeof scenes);
    return null;
  }

  if (scenes.length === 0) {
    console.warn('No scenes provided');
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          if (!scene || typeof scene !== 'object' || !scene.src) {
            console.warn(`Scene ${index} invalid:`, scene);
            return null;
          }

          return (
            <Series.Sequence key={index} durationInFrames={150}>
              <Video src={scene.src} startFrom={0} />
            </Series.Sequence>
          );
        })}
      </Series>

      {audio && typeof audio === 'object' && audio.src && (
        <Audio src={audio.src} />
      )}
    </>
  );
};
