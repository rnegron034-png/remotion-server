import { AbsoluteFill, Video, Audio, Sequence, useVideoConfig } from 'remotion';
import React from 'react';

export const CreateVideo: React.FC<{
  scenes: Array<{
    src: string;
    durationInFrames?: number;
  }>;
  audio?: string;
}> = ({ scenes, audio }) => {
  const { fps } = useVideoConfig();
  
  let currentFrame = 0;

  return (
    <AbsoluteFill>
      {scenes.map((scene, index) => {
        const duration = scene.durationInFrames || fps * 5;
        const from = currentFrame;
        currentFrame += duration;

        return (
          <Sequence key={index} from={from} durationInFrames={duration}>
            <AbsoluteFill>
              <Video
                src={scene.src}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  console.error(`Error loading video ${scene.src}:`, e);
                }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      
      {audio && <Audio src={audio} />}
    </AbsoluteFill>
  );
};
