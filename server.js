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

const jobPath = id => path.join(WORKDIR, id);

function update(jobId, data) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, ...data, lastUpdated: new Date().toISOString() });
}

/* ===============================
   CREATE JOB
================================*/
app.post("/remotion-render", async (req, res) => {
  const payload = req.body;
  if (!payload?.client_payload?.scenes?.length) return res.status(400).json({ error: "Scenes missing" });
  if (!payload?.client_payload?.audio?.src) return res.status(400).json({ error: "Audio missing" });

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
    downloadUrl: null,
    error: null
  });

  res.json({ jobId, statusUrl: `/status/${jobId}` });

  processJob(jobId, payload).catch(e => {
    console.error(e);
    update(jobId, { status: "error", stage: "Failed", error: String(e) });
  });
});

/* ===============================
   STATUS
================================*/
app.get("/status/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

/* ===============================
   DOWNLOAD
================================*/
app.get("/download/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== "done") return res.status(400).json({ error: "Not ready" });
  res.download(j.outputFile, `video_${j.jobId}.mp4`);
});

/* ===============================
   PIPELINE
================================*/
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || "";

  update(jobId, { stage: "Downloading audio", progress: 5 });

  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  const clipList = [];

  for (let i = 0; i < scenes.length; i++) {
    update(jobId, { stage: `Downloading clip ${i + 1}`, processedScenes: i, progress: 10 + (i / scenes.length) * 30 });
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clipList.push(p);
  }

  update(jobId, { stage: "Normalizing & cropping", progress: 50 });

  const fixed = [];
  for (let i = 0; i < clipList.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);

    await execAsync(`
      ffmpeg -y -i "${clipList[i]}" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
      -an -r 30 -c:v libx264 -preset veryfast -crf 22 "${out}"
    `);

    fixed.push(out);
  }

  update(jobId, { stage: "Concatenating", progress: 70 });
  const list = fixed.map(f => `file '${f}'`).join("\n");
  fs.writeFileSync(path.join(dir, "list.txt"), list);

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${dir}/list.txt" -c copy "${merged}"`);

  const subsPath = path.join(dir, "subs.srt");
  fs.writeFileSync(subsPath, subtitles);

  update(jobId, { stage: "Adding audio & subtitles", progress: 85 });

  const final = path.join(dir, "final.mp4");
  await execAsync(`
    ffmpeg -y -i "${merged}" -i "${audioPath}" \
    -vf "subtitles=${subsPath}" \
    -map 0:v -map 1:a -shortest \
    -c:v libx264 -preset veryfast -crf 22 -c:a aac "${final}"
  `);

  update(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`,
    completedTime: new Date().toISOString()
  });
}

/* ===============================
   DOWNLOAD HELPER
================================*/
async function download(url, out) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Download failed");
  const s = fs.createWriteStream(out);
  await new Promise((res, rej) => {
    r.body.pipe(s);
    r.body.on("error", rej);
    s.on("finish", res);
  });
}

/* ===============================
   START
================================*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Render server running on", PORT));
