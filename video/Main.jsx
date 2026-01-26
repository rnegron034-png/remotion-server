import { AbsoluteFill, Sequence, Video, Audio } from "remotion";

export const MainVideo = ({ clips, audio }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {clips.map((src, i) => (
        <Sequence key={i} from={i * 60} durationInFrames={60}>
          <Video src={src} />
        </Sequence>
      ))}

      {audio && <Audio src={audio} />}
    </AbsoluteFill>
  );
};
