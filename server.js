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

const execAsync = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });

const jobPath = (id) => path.join(WORKDIR, id);

const updateJob = (jobId, updates) => {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.set(jobId, {
    ...job,
    ...updates,
    lastUpdated: new Date().toISOString(),
  });
};

/* ===============================
   POST /remotion-render
================================*/
app.post("/remotion-render", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload?.client_payload?.scenes?.length)
      return res.status(400).json({ error: "Scenes missing" });

    if (!payload?.client_payload?.audio?.src)
      return res.status(400).json({ error: "Audio missing" });

    if (!payload?.client_payload?.subtitles)
      return res.status(400).json({ error: "Subtitles missing" });

    const jobId = uuidv4();
    const dir = jobPath(jobId);
    fs.mkdirSync(dir, { recursive: true });

    jobs.set(jobId, {
      jobId,
      status: "queued",
      stage: "Queued",
      progress: 0,
      totalScenes: payload.client_payload.scenes.length,
      processedScenes: 0,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      downloadUrl: null,
      error: null,
    });

    res.json({
      jobId,
      status: "queued",
      statusUrl: `/status/${jobId}`,
      downloadUrl: `/download/${jobId}`,
    });

    processJob(jobId, payload).catch((e) => {
      updateJob(jobId, {
        status: "error",
        stage: "Failed",
        error: String(e),
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   STATUS
================================*/
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/* ===============================
   DOWNLOAD
================================*/
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") return res.status(404).json({ error: "Not ready" });
  res.download(job.outputFile);
});

/* ===============================
   JOB PIPELINE
================================*/
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles;

  updateJob(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  // Download audio
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // Save subtitles
  const srtPath = path.join(dir, "subs.srt");
  fs.writeFileSync(srtPath, subtitles.map((s, i) => {
    const fmt = (t) => new Date(t * 1000).toISOString().substr(11, 12).replace(".", ",");
    return `${i+1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`;
  }).join("\n"));

  // Download clips
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    updateJob(jobId, { processedScenes: i+1, progress: 10 + (i/scenes.length)*30 });
  }

  // Normalize clips
  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(`ffmpeg -y -i "${clips[i]}" -r 30 -c:v libx264 -pix_fmt yuv420p "${out}"`);
    fixed.push(out);
  }

  // Concat
  const list = fixed.map(f => `file '${f}'`).join("\n");
  fs.writeFileSync(path.join(dir, "list.txt"), list);

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${path.join(dir,"list.txt")}" -c copy "${merged}"`);

  updateJob(jobId, { stage: "Rendering", progress: 80 });

  // 🔥 FINAL RENDER (9:16 + subtitles + audio locked)
  const final = path.join(dir, "final.mp4");

  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" \
    -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,subtitles=${srtPath}" \
    -map 0:v -map 1:a \
    -c:v libx264 -preset veryfast -crf 23 \
    -c:a aac -shortest "${final}"`
  );

  updateJob(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`,
  });
}

/* ===============================
   Downloader
================================*/
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const file = fs.createWriteStream(output);
  await new Promise((r, j) => {
    res.body.pipe(file);
    res.body.on("error", j);
    file.on("finish", r);
  });
}

/* ===============================
   HEALTH
================================*/
app.get("/health", (_, res) => res.json({ ok: true }));

/* ===============================
   START
================================*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Render server running on", PORT));
