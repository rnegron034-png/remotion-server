import {AbsoluteFill, Audio, Img, Sequence, Video as RemotionVideo} from 'remotion';

export const Video = ({scenes, audio}) => {
  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {scenes.map((scene, i) => {
        const fromFrame = Math.round(scene.start * scene.fps || 30);
        const durationFrames = Math.round(scene.duration * scene.fps || 30);

        return (
          <Sequence key={i} from={fromFrame} durationInFrames={durationFrames}>
            {scene.type === "video" ? (
              <RemotionVideo src={scene.local} />
            ) : (
              <Img src={scene.local} style={{objectFit: 'cover'}} />
            )}
          </Sequence>
        );
      })}

      {audio && (
        <Audio
          src={audio.local}
          startFrom={audio.trim ? Math.round(audio.trim[0] * 30) : 0}
          durationInFrames={audio.trim ? Math.round((audio.trim[1] - audio.trim[0]) * 30) : undefined}
        />
      )}
    </AbsoluteFill>
  );
};
