import express from "express";
import { exec } from "child_process";
import fs from "fs";
import { v4 as uuid } from "uuid";

const app = express();
app.use(express.json());

const jobs = {};

app.post("/render", async (req, res) => {
  const { clips, audio, title } = req.body;
  const id = uuid();
  const out = `videos/${id}.mp4`;

  fs.mkdirSync("videos", { recursive: true });

  jobs[id] = { status: "processing", file: out };

  const list = clips.map(c => `file '${c}'`).join("\n");
  fs.writeFileSync(`list-${id}.txt`, list);

  const cmd = `
  ffmpeg -y -f concat -safe 0 -i list-${id}.txt \
  -c copy temp-${id}.mp4 &&
  ffmpeg -i temp-${id}.mp4 -i "${audio}" \
  -map 0:v -map 1:a -shortest -movflags +faststart ${out}
  `;

  exec(cmd, (err) => {
    if (err) jobs[id].status = "error";
    else jobs[id].status = "done";
  });

  res.json({ jobId: id });
});

app.get("/status/:id", (req, res) => {
  res.json(jobs[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

app.listen(3000, () => console.log("Remotion server running"));
