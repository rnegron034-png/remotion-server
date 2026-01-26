import express from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const jobs = {};

app.post("/render", async (req, res) => {
  const { clips, audio, title } = req.body;
  const jobId = uuidv4();
  jobs[jobId] = { status: "processing" };

  const workDir = `/tmp/${jobId}`;
  fs.mkdirSync(workDir);

  // Download clips
  for (let i = 0; i < clips.length; i++) {
    exec(`curl -L "${clips[i]}" -o ${workDir}/${i}.mp4`);
  }

  exec(`curl -L "${audio}" -o ${workDir}/audio.mp3`);

  setTimeout(() => {
    const list = clips.map((_, i) => `file '${i}.mp4'`).join("\n");
    fs.writeFileSync(`${workDir}/list.txt`, list);

    const output = `${workDir}/final.mp4`;

    const cmd = `
      ffmpeg -y -f concat -safe 0 -i ${workDir}/list.txt \
      -i ${workDir}/audio.mp3 \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
      -map 0:v -map 1:a \
      -c:v libx264 -preset veryfast -crf 22 \
      -c:a aac -shortest \
      ${output}
    `;

    exec(cmd, (err) => {
      if (err) {
        jobs[jobId].status = "error";
        return;
      }
      jobs[jobId] = { status: "done", file: output };
    });
  }, 8000);

  res.json({ jobId });
});

app.get("/status/:id", (req, res) => {
  res.json(jobs[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") return res.status(404).end();
  res.download(job.file);
});

app.listen(3000, () => console.log("Remotion server running"));
