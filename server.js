import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const jobs = new Map();
const WORKDIR = "/tmp/jobs";
fs.mkdirSync(WORKDIR, { recursive: true });

const MAX_JOBS = 3; // Railway CPU protection

function jobPath(id) {
  return path.join(WORKDIR, id);
}

/* ============================ */
/* SAFE FFmpeg execution */
/* ============================ */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: "inherit" });

    p.on("error", reject);
    p.on("close", code => {
      if (code !== 0) reject(new Error("ffmpeg failed"));
      else resolve();
    });
  });
}

/* ============================ */
/* Progress tracker */
/* ============================ */
function updateJobProgress(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return;

  jobs.set(jobId, {
    ...job,
    ...updates,
    lastUpdated: new Date().toISOString()
  });
}

/* ============================ */
/* POST /remotion-render */
/* ============================ */
app.post("/remotion-render", async (req, res) => {
  try {
    if (jobs.size >= MAX_JOBS) {
      return res.status(429).json({ error: "Server busy" });
    }

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
      stage: "Queued",
      progress: 0,
      processedScenes: 0,
      totalScenes: payload.client_payload.scenes.length,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    });

    res.json({
      jobId,
      status: "queued",
      statusUrl: `/status/${jobId}`
    });

    processJob(jobId, payload);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================ */
/* JOB PIPELINE */
/* ============================ */
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const start = Date.now();

  try {
    updateJobProgress(jobId, { status: "downloading", stage: "Audio", progress: 5 });

    const audioPath = path.join(dir, "audio.mp3");
    await download(audioUrl, audioPath);

    const clips = [];
    for (let i = 0; i < scenes.length; i++) {
      updateJobProgress(jobId, {
        stage: `Downloading ${i + 1}/${scenes.length}`,
        processedScenes: i,
        progress: 5 + (i / scenes.length) * 30
      });

      const out = path.join(dir, `clip_${i}.mp4`);
      await download(scenes[i].src, out);
      clips.push(out);
    }

    updateJobProgress(jobId, { stage: "Normalizing", progress: 40 });

    const fixed = [];
    for (let i = 0; i < clips.length; i++) {
      const out = path.join(dir, `fixed_${i}.mp4`);

      await runFFmpeg([
        "-y",
        "-i", clips[i],
        "-r", "30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        out
      ]);

      fixed.push(out);
    }

    updateJobProgress(jobId, { stage: "Concatenating", progress: 65 });

    const list = path.join(dir, "list.txt");
    fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));

    const merged = path.join(dir, "merged.mp4");
    await runFFmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", merged]);

    updateJobProgress(jobId, { stage: "Adding audio", progress: 85 });

    const final = path.join(dir, "final.mp4");
    await runFFmpeg([
      "-y",
      "-i", merged,
      "-i", audioPath,
      "-map", "0:v",
      "-map", "1:a",
      "-shortest",
      "-c:v", "copy",
      "-c:a", "aac",
      final
    ]);

    const size = (fs.statSync(final).size / 1024 / 1024).toFixed(2);
    const time = Math.round((Date.now() - start) / 1000);

    updateJobProgress(jobId, {
      status: "done",
      stage: "Complete",
      progress: 100,
      outputFile: final,
      fileSize: size + " MB",
      completedTime: new Date().toISOString(),
      renderTime: time,
      downloadUrl: `/download/${jobId}`
    });

  } catch (e) {
    updateJobProgress(jobId, {
      status: "error",
      stage: "Failed",
      error: String(e)
    });
  }
}

/* ============================ */
/* Downloader (stream-safe) */
/* ============================ */
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${url}`);

  const file = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
}

/* ============================ */
/* Status + Download */
/* ============================ */
app.get("/status/:id", (req, res) => {
  res.json(jobs.get(req.params.id) || { error: "Not found" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.outputFile) return res.status(404).end();
  res.download(job.outputFile);
});

/* ============================ */
app.get("/health", (req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

/* ============================ */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Remotion Render Server Ready");
});
