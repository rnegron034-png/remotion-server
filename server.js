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

const PORT = process.env.PORT || 3000;

/* ================= UTIL ================= */

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

function update(jobId, patch) {
  const j = jobs.get(jobId);
  if (!j) return;
  jobs.set(jobId, { ...j, ...patch, lastUpdated: new Date().toISOString() });
}

/* ================= SUBTITLES ================= */

function toSrtTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

function subtitlesToSrt(subs) {
  return subs.map((s, i) => `${i+1}\n${toSrtTime(s.start)} --> ${toSrtTime(s.end)}\n${s.text}\n`).join("\n");
}

const SUBTITLE_STYLE = `Fontname=Poppins SemiBold,Fontsize=36,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=80`;

/* ================= API ================= */

app.post("/remotion-render", async (req, res) => {
  const payload = req.body;

  if (!payload?.client_payload?.scenes?.length)
    return res.status(400).json({ error: "Scenes missing" });

  if (!payload?.client_payload?.audio?.src)
    return res.status(400).json({ error: "Audio missing" });

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
    outputFile: null,
    error: null
  });

  res.json({ jobId, status: "queued", statusUrl: `/status/${jobId}` });

  processJob(jobId, payload).catch(err => {
    console.error(err);
    update(jobId, { status: "error", stage: "Failed", error: String(err) });
  });
});

app.get("/status/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

app.get("/download/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j || j.status !== "done") return res.status(400).json({ error: "Not ready" });
  res.download(j.outputFile, `video_${j.jobId}.mp4`);
});

/* ================= PIPELINE ================= */

async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  const srtPath = path.join(dir, "subs.srt");
  fs.writeFileSync(srtPath, subtitlesToSrt(subtitles), "utf8");

  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i + 1, progress: 10 + (i / scenes.length) * 30 });
  }

  update(jobId, { status: "processing", stage: "Formatting clips", progress: 40 });

  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(
      `ffmpeg -y -i "${clips[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -r 30 -an -c:v libx264 -preset fast "${out}"`
    );
    fixed.push(out);
  }

  update(jobId, { stage: "Merging", progress: 70 });

  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);

  update(jobId, { stage: "Adding audio & subtitles", progress: 85 });

  const final = path.join(dir, "final.mp4");
  const escaped = srtPath.replace(/\\/g,"\\\\").replace(/:/g,"\\:");

  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "subtitles='${escaped}':force_style='${SUBTITLE_STYLE}'" -map 0:v -map 1:a -shortest -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k "${final}"`
  );

 update(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`,
    completedTime: new Date().toISOString(),
    renderTime: totalTime,
    fileSize: sizeMB + " MB"
  });
}

/* ================= DOWNLOAD ================= */

async function download(url, output) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const f = fs.createWriteStream(output);
  await new Promise((res, rej) => {
    r.body.pipe(f);
    r.body.on("error", rej);
    f.on("finish", res);
  });
}

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("🚀 Karaoke Render Server Ready");
  console.log("🎬 9:16 Shorts");
  console.log("📝 Poppins 36px subtitles");
});
