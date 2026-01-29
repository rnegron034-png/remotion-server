import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const jobs = new Map();
const WORKDIR = "/tmp/jobs";
fs.mkdirSync(WORKDIR, { recursive: true });

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });
}

function jobPath(id) {
  return path.join(WORKDIR, id);
}

/* ============================
   POST /remotion-render
============================ */
app.post("/remotion-render", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload?.client_payload?.scenes?.length) {
      return res.status(400).json({ error: "Scenes missing" });
    }
    if (!payload?.client_payload?.audio?.src) {
      return res.status(400).json({ error: "Audio URL missing" });
    }

    const jobId = uuidv4();
    const dir = jobPath(jobId);
    fs.mkdirSync(dir, { recursive: true });

    jobs.set(jobId, { status: "queued" });

    res.json({ jobId });

    processJob(jobId, payload).catch(e => {
      console.error("JOB FAILED", e);
      jobs.set(jobId, { status: "error", error: String(e) });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================
   GET /status/:jobId
============================ */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/* ============================
   JOB PIPELINE
============================ */
async function processJob(jobId, payload) {
  jobs.set(jobId, { status: "downloading" });

  const dir = jobPath(jobId);
  const clips = payload.client_payload.scenes.map(s => s.src);
  const audioUrl = payload.client_payload.audio.src;

  // Download audio
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // Download all clips
  const clipPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(clips[i], p);
    clipPaths.push(p);
  }

  // Normalize clips
  jobs.set(jobId, { status: "processing" });

  const fixed = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(`ffmpeg -y -i ${clipPaths[i]} -r 30 -c:v libx264 -pix_fmt yuv420p ${out}`);
    fixed.push(out);
  }

  // Create concat list
  const concatFile = path.join(dir, "list.txt");
  fs.writeFileSync(concatFile, fixed.map(f => `file '${f}'`).join("\n"));

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i ${concatFile} -c copy ${merged}`);

  const final = path.join(dir, "final.mp4");
  await execAsync(`ffmpeg -y -i ${merged} -i ${audioPath} -map 0:v -map 1:a -shortest -c:v copy -c:a aac ${final}`);

  jobs.set(jobId, {
    status: "done",
    file: final
  });
}

/* ============================
   Downloader (Bunny + Drive)
============================ */
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed: " + url);
  const fileStream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
