import express from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const jobs = new Map();
const PORT = process.env.PORT || 3000;

app.post("/render", async (req, res) => {
  const { clips, audio, title } = req.body;

  const jobId = uuidv4();
  const out = `videos/${jobId}.mp4`;
  fs.mkdirSync("videos", { recursive: true });

  jobs.set(jobId, { status: "processing", file: out });

  runRender(jobId, clips, audio, out);

  res.json({ jobId });
});

app.get("/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.file)) return res.sendStatus(404);
  res.download(job.file);
});

function runRender(jobId, clips, audio, out) {
  const list = clips.map(c => `file '${c}'`).join("\n");
  fs.writeFileSync("list.txt", list);

  const cmd = `
ffmpeg -y -f concat -safe 0 -i list.txt -i "${audio}" \
-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
-c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
-c:a aac -shortest "${out}"
`;

  exec(cmd, (err) => {
    if (err) {
      jobs.set(jobId, { status: "error", file: out });
    } else {
      jobs.set(jobId, { status: "done", file: out });
    }
  });
}

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
