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

    jobs.set(jobId, {
      jobId,
      status: "queued",
      progress: 0,
      stage: "Queued",
      totalScenes: payload.client_payload.scenes.length,
      processedScenes: 0,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      estimatedTimeRemaining: null,
      downloadUrl: null,
      error: null
    });

    res.json({
      jobId,
      status: "queued",
      statusUrl: `/status/${jobId}`,
      totalScenes: payload.client_payload.scenes.length
    });

    processJob(jobId, payload).catch(e => {
      console.error("JOB FAILED", e);
      updateJobProgress(jobId, {
        status: "error",
        stage: "Failed",
        error: String(e),
        progress: 0
      });
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================
   GET /status/:jobId
============================ */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  let renderTime = null;
  if (job.completedTime) {
    renderTime = Math.round((new Date(job.completedTime) - new Date(job.startTime)) / 1000);
  }

  res.json({
    ...job,
    renderTime,
    renderTimeFormatted: renderTime ? formatDuration(renderTime) : null
  });
});

/* ============================
   GET /download/:jobId
============================ */
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(400).json({ error: "Job not completed" });
  if (!fs.existsSync(job.outputFile)) return res.status(404).json({ error: "File missing" });

  res.download(job.outputFile, `video_${job.jobId}.mp4`);
});

/* ============================
   JOB PIPELINE
============================ */
async function processJob(jobId, payload) {
  const startTime = Date.now();
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;

  try {
    updateJobProgress(jobId, { status: "downloading", stage: "Downloading audio", progress: 10 });

    const audioPath = path.join(dir, "audio.mp3");
    await download(audioUrl, audioPath);

    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      updateJobProgress(jobId, {
        stage: `Downloading clip ${i + 1}/${scenes.length}`,
        processedScenes: i,
        progress: 10 + (i / scenes.length) * 30
      });

      const p = path.join(dir, `clip_${i}.mp4`);
      await download(scenes[i].src, p);
      clipPaths.push(p);
    }

    /* Railway-safe normalize (NO re-encode) */
    updateJobProgress(jobId, { stage: "Normalizing", progress: 50 });
    const fixed = [];

    for (let i = 0; i < clipPaths.length; i++) {
      const out = path.join(dir, `fixed_${i}.mp4`);
      await execAsync(
        `ffmpeg -y -i "${clipPaths[i]}" -map 0:v -map 0:a? -c copy -movflags +faststart "${out}"`
      );
      fixed.push(out);
    }

    updateJobProgress(jobId, { stage: "Concatenating", progress: 70 });
    const concatFile = path.join(dir, "list.txt");
    fs.writeFileSync(concatFile, fixed.map(f => `file '${f}'`).join("\n"));

    const merged = path.join(dir, "merged.mp4");
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${merged}"`);

    updateJobProgress(jobId, { stage: "Muxing audio", progress: 85 });
    const final = path.join(dir, "final.mp4");
    await execAsync(
      `ffmpeg -y -i "${merged}" -i "${audioPath}" -map 0:v -map 1:a -shortest -c:v copy -c:a aac "${final}"`
    );

    const stats = fs.statSync(final);
    const totalTime = Math.round((Date.now() - startTime) / 1000);

    updateJobProgress(jobId, {
      status: "done",
      stage: "Complete",
      progress: 100,
      processedScenes: scenes.length,
      completedTime: new Date().toISOString(),
      outputFile: final,
      downloadUrl: `/download/${jobId}`,
      fileSize: (stats.size / 1024 / 1024).toFixed(2) + " MB",
      renderTime: totalTime
    });

  } catch (err) {
    updateJobProgress(jobId, {
      status: "error",
      stage: "Failed",
      error: err.message
    });
    throw err;
  }
}

/* ============================
   Downloader
============================ */
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const stream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

/* ============================
   Utils
============================ */
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/* ============================
   Health
============================ */
app.get("/health", (req, res) => {
  res.json({ status: "ok", jobs: jobs.size, uptime: process.uptime() });
});

/* ============================
   Start
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Remotion Render Server Ready");
});
