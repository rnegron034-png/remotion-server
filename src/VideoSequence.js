import React from 'react';
import { Series, Video, Audio } from 'remotion';

export const VideoSequence = ({ scenes = [], audio = null }) => {
  console.log('VideoSequence received scenes:', scenes);
  console.log('VideoSequence received audio:', audio);

  if (!Array.isArray(scenes) || scenes.length === 0) {
    console.error('No valid scenes provided');
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#fff',
        fontSize: 48
      }}>
        No scenes provided
      </div>
    );
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          if (!scene || !scene.src) {
            console.warn(`Scene ${index} missing src`);
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
