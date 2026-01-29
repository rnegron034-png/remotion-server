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
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });
}

function jobPath(id) {
  return path.join(WORKDIR, id);
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.set(jobId, {
    ...job,
    ...updates,
    lastUpdated: new Date().toISOString()
  });
}

/* ===========================
   POST /remotion-render
=========================== */
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
    stage: "Queued",
    progress: 0,
    processedScenes: 0,
    totalScenes: payload.client_payload.scenes.length,
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

  processJob(jobId, payload).catch(e => {
    console.error(e);
    updateJob(jobId, { status: "error", stage: "Failed", error: String(e) });
  });
});

/* ===========================
   GET /status/:jobId
=========================== */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/* ===========================
   GET /download/:jobId
=========================== */
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.download(job.outputFile, `video_${job.jobId}.mp4`);
});

/* ===========================
   JOB PIPELINE
=========================== */
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];

  /* ---- Audio ---- */
  updateJob(jobId, { stage: "Downloading audio", progress: 5 });
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  /* ---- Subtitles ---- */
  const srtPath = path.join(dir, "subs.srt");
  fs.writeFileSync(srtPath, buildSRT(subtitles));

  /* ---- Clips ---- */
  const normalized = [];

  for (let i = 0; i < scenes.length; i++) {
    updateJob(jobId, {
      stage: `Normalizing clip ${i + 1}/${scenes.length}`,
      progress: 10 + (i / scenes.length) * 40,
      processedScenes: i
    });

    const raw = path.join(dir, `clip_${i}.mp4`);
    const fixed = path.join(dir, `fixed_${i}.mp4`);
    await download(scenes[i].src, raw);

    // Railway-safe normalize: remove audio, force 9:16, downscale
    await execAsync(`
      ffmpeg -y -i "${raw}"
      -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280"
      -r 30 -an -c:v libx264 -preset ultrafast -crf 28 "${fixed}"
    `);

    normalized.push(fixed);
  }

  /* ---- Concat (no re-encode) ---- */
  updateJob(jobId, { stage: "Concatenating", progress: 55 });
  const listFile = path.join(dir, "list.txt");
  fs.writeFileSync(listFile, normalized.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");

  await execAsync(`
    ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${merged}"
  `);

  /* ---- Final render (ONE encode) ---- */
  updateJob(jobId, { stage: "Final render", progress: 75 });
  const final = path.join(dir, "final.mp4");

  await execAsync(`
    ffmpeg -y -i "${merged}" -i "${audioPath}"
    -vf "subtitles=${srtPath}"
    -map 0:v -map 1:a -shortest
    -c:v libx264 -preset veryfast -crf 23 -c:a aac "${final}"
  `);

  updateJob(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    processedScenes: scenes.length,
    outputFile: final,
    downloadUrl: `/download/${jobId}`
  });
}

/* ===========================
   HELPERS
=========================== */
async function download(url, out) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Download failed");
  await new Promise((res, rej) => {
    const s = fs.createWriteStream(out);
    r.body.pipe(s);
    r.body.on("error", rej);
    s.on("finish", res);
  });
}

function buildSRT(subs) {
  return subs.map((s, i) =>
    `${i + 1}
${toTime(s.start)} --> ${toTime(s.end)}
${s.text}

`).join("");
}

function toTime(t) {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  const ms = String(Math.floor((t % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

/* ===========================
   START
=========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Remotion render server running on", PORT);
});
