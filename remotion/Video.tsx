import { AbsoluteFill, Video as RemotionVideo, Audio, getInputProps } from "remotion";

export const Video = () => {
  const { scenes, audio } = getInputProps();

  return (
    <AbsoluteFill>
      {scenes.map((s, i) => (
        <RemotionVideo key={i} src={s.src} />
      ))}

      {audio?.src && <Audio src={audio.src} />}
    </AbsoluteFill>
  );
};
