import { AbsoluteFill, Sequence, Video, Img, Audio } from "remotion";

export const Video = ({ scenes, audio }) => {
  return (
    <AbsoluteFill>
      {scenes.map((s, i) => (
        <Sequence key={i} from={s.start} durationInFrames={s.duration}>
          {s.local.endsWith(".mp4") ? (
            <Video src={s.local} />
          ) : (
            <Img src={s.local} />
          )}
        </Sequence>
      ))}
      {audio && <Audio src={audio.local} />}
    </AbsoluteFill>
  );
};
