import express from "express";
import { v4 as uuid } from "uuid";
import fs from "fs";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const jobs = new Map();
const PORT = process.env.PORT || 8080;

app.post("/render", async (req, res) => {
  const { clips, audio, title } = req.body;
  const id = uuid();

  jobs.set(id, { status: "processing" });

  const dir = `/tmp/${id}`;
  fs.mkdirSync(dir, { recursive: true });

  // Download clips
  for (let i = 0; i < clips.length; i++) {
    await fetch(clips[i])
      .then(r => r.arrayBuffer())
      .then(b => fs.writeFileSync(`${dir}/${i}.mp4`, Buffer.from(b)));
  }

  await fetch(audio)
    .then(r => r.arrayBuffer())
    .then(b => fs.writeFileSync(`${dir}/audio.mp3`, Buffer.from(b)));

  const list = clips.map((_, i) => `file '${dir}/${i}.mp4'`).join("\n");
  fs.writeFileSync(`${dir}/list.txt`, list);

  const output = `${dir}/out.mp4`;

  exec(`
ffmpeg -y -f concat -safe 0 -i ${dir}/list.txt -i ${dir}/audio.mp3 \
-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
-c:a aac -shortest ${output}
`, (err) => {
    if (err) {
      console.error(err);
      jobs.set(id, { status: "error" });
      return;
    }
    jobs.set(id, { status: "done", file: output });
  });

  res.json({ jobId: id });
});

app.get("/status/:id", (req, res) => {
  res.json(jobs.get(req.params.id) || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

app.listen(PORT, () => console.log("Listening on", PORT));
