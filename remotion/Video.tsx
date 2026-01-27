import { AbsoluteFill, OffthreadVideo, Audio, Sequence, useVideoConfig } from 'remotion';
import React from 'react';

// ADD "export" HERE ↓
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
              <OffthreadVideo
                src={scene.src}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      
      {audio && <Audio src={audio} />}
    </AbsoluteFill>
  );
};
