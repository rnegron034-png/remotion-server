import { AbsoluteFill, Video as RVideo, Audio } from "remotion";

export const Video = ({ scenes, audio }) => {
  return (
    <AbsoluteFill>
      {scenes.map((s, i) => (
        <RVideo key={i} src={s.src} />
      ))}

      {audio && <Audio src={audio.src} />}
    </AbsoluteFill>
  );
};
