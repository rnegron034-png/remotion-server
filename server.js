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
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });
}

function jobPath(id) {
  return path.join(WORKDIR, id);
}

function updateJobProgress(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates, lastUpdated: new Date().toISOString() });
  }
}

/* ============================
   POST /remotion-render
============================ */
app.post("/remotion-render", async (req, res) => {
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

  jobs.set(jobId, {
    jobId,
    status: "queued",
    progress: 0,
    stage: "Queued",
    totalScenes: payload.client_payload.scenes.length,
    processedScenes: 0,
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    downloadUrl: null,
    error: null
  });

  res.json({
    jobId,
    status: "queued",
    statusUrl: `/status/${jobId}`
  });

  processJob(jobId, payload).catch(err => {
    updateJobProgress(jobId, { status: "error", stage: "Failed", error: String(err) });
  });
});

/* ============================
   STATUS
============================ */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") return res.status(404).json({ error: "Not ready" });
  res.download(job.outputFile);
});

/* ============================
   PIPELINE
============================ */
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const srtUrl = payload.client_payload.subtitles?.src;

  updateJobProgress(jobId, { stage: "Downloading audio", progress: 5 });

  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  let srtPath = null;
  if (srtUrl) {
    srtPath = path.join(dir, "subs.srt");
    await download(srtUrl, srtPath);
  }

  const clipPaths = [];

  for (let i = 0; i < scenes.length; i++) {
    updateJobProgress(jobId, {
      stage: `Downloading clip ${i + 1}/${scenes.length}`,
      processedScenes: i,
      progress: 10 + (i / scenes.length) * 20
    });

    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clipPaths.push(p);
  }

  /* Normalize clips (NO AUDIO) */
  updateJobProgress(jobId, { stage: "Normalizing clips", progress: 40 });

  const fixed = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);

    await execAsync(
      `ffmpeg -y -i "${clipPaths[i]}" -an -r 30 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p -c:v libx264 -preset veryfast "${out}"`
    );

    fixed.push(out);
  }

  /* Concat */
  updateJobProgress(jobId, { stage: "Merging clips", progress: 65 });

  const list = fixed.map(f => `file '${f}'`).join("\n");
  const listFile = path.join(dir, "list.txt");
  fs.writeFileSync(listFile, list);

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v copy "${merged}"`);

  /* Add Audio + Subtitles */
  updateJobProgress(jobId, { stage: "Adding audio & subtitles", progress: 85 });

  const final = path.join(dir, "final.mp4");

  if (srtPath) {
    await execAsync(
      `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "subtitles=${srtPath}" -map 0:v -map 1:a -c:v libx264 -c:a aac -shortest "${final}"`
    );
  } else {
    await execAsync(
      `ffmpeg -y -i "${merged}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${final}"`
    );
  }

  updateJobProgress(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`
  });
}

/* ============================
   Downloader
============================ */
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed: " + url);
  const stream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

/* ============================
   START
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Remotion Render Server running on", PORT);
});
