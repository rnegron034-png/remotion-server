import express from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { execSync } from "child_process";
import path from "path";

const app = express();
app.use(express.json());

const JOBS = {};
const TMP = "/tmp";

app.post("/render", async (req, res) => {
  const { clips, audio } = req.body;
  const id = uuidv4();
  const work = `${TMP}/${id}`;
  fs.mkdirSync(work);

  JOBS[id] = { status: "processing" };
  res.json({ jobId: id });

  try {
    // Download clips
    const list = [];
    for (let i = 0; i < clips.length; i++) {
      const p = `${work}/${i}.mp4`;
      execSync(`curl -L "${clips[i]}" -o "${p}"`);
      list.push(`file '${p}'`);
    }

    fs.writeFileSync(`${work}/list.txt`, list.join("\n"));

    // Download audio
    const audioFile = `${work}/audio.mp3`;
    execSync(`curl -L "${audio}" -o "${audioFile}"`);

    // Merge video
    execSync(`
      ffmpeg -y -f concat -safe 0 -i ${work}/list.txt \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
      -c:v libx264 -pix_fmt yuv420p -profile:v main -level 3.1 \
      -movflags +faststart ${work}/video.mp4
    `);

    // Add audio safely
    execSync(`
      ffmpeg -y -i ${work}/video.mp4 -i ${audioFile} \
      -map 0:v:0 -map 1:a:0 -shortest \
      -c:v copy -c:a aac ${work}/final.mp4
    `);

    fs.renameSync(`${work}/final.mp4`, `${TMP}/${id}.mp4`);
    JOBS[id] = { status: "done" };
  } catch (e) {
    console.error(e);
    JOBS[id] = { status: "error" };
  }
});

app.get("/status/:id", (req, res) => {
  res.json(JOBS[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const file = `${TMP}/${req.params.id}.mp4`;
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.download(file);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Render server on", PORT));
