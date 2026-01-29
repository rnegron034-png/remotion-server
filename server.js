import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const jobs = new Map();
const WORKDIR = "/tmp/jobs";
fs.mkdirSync(WORKDIR, { recursive: true });

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
  await validateMedia(audioPath, "audio");

  let srtPath = null;
  if (srtUrl) {
    updateJobProgress(jobId, { stage: "Downloading subtitles", progress: 8 });
    srtPath = path.join(dir, "subs.srt");
    await download(srtUrl, srtPath);
    // Validate SRT roughly
    const srtContent = fs.readFileSync(srtPath, 'utf8');
    if (!srtContent.trim().startsWith('1')) {
      throw new Error('Invalid SRT file');
    }
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
    await validateMedia(p, "video");
    clipPaths.push(p);
  }

  /* Normalize clips (NO AUDIO) */
  updateJobProgress(jobId, { stage: "Normalizing clips", progress: 40 });

  const fixed = [];
  for (let i = 0; i < clipPaths.length; i++) {
    updateJobProgress(jobId, {
      stage: `Normalizing clip ${i + 1}/${clipPaths.length}`,
      progress: 40 + (i / clipPaths.length) * 25
    });
    const out = path.join(dir, `fixed_${i}.mp4`);

    const cmd = `ffmpeg -y -i "${clipPaths[i]}" -an -r 30 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p -c:v libx264 -preset ultrafast "${out}"`;
    console.log(`Executing: ${cmd}`);
    try {
      const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
      console.log(`Normalize stdout: ${stdout}`);
      console.log(`Normalize stderr: ${stderr}`);
    } catch (err) {
      console.error(`FFmpeg normalize error: ${err}`);
      throw new Error(`FFmpeg normalize failed for clip ${i}: ${err}`);
    }
    await validateMedia(out, "video");
    fixed.push(out);
  }

  /* Concat */
  updateJobProgress(jobId, { stage: "Merging clips", progress: 65 });

  const list = fixed.map(f => `file '${f}'`).join("\n");
  const listFile = path.join(dir, "list.txt");
  fs.writeFileSync(listFile, list);

  const merged = path.join(dir, "merged.mp4");
  const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v copy "${merged}"`;
  console.log(`Executing: ${concatCmd}`);
  try {
    const { stdout, stderr } = await execAsync(concatCmd, { maxBuffer: 1024 * 1024 * 50 });
    console.log(`Concat stdout: ${stdout}`);
    console.log(`Concat stderr: ${stderr}`);
  } catch (err) {
    console.error(`FFmpeg concat error: ${err}`);
    throw new Error(`FFmpeg concat failed: ${err}`);
  }

  /* Add Audio + Subtitles */
  updateJobProgress(jobId, { stage: "Adding audio & subtitles", progress: 85 });

  const final = path.join(dir, "final.mp4");

  let cmd;
  if (srtPath) {
    cmd = `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "subtitles='${srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}'" -map 0:v -map 1:a -c:v libx264 -preset ultrafast -c:a aac -shortest "${final}"`;
  } else {
    cmd = `ffmpeg -y -i "${merged}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${final}"`;
  }
  console.log(`Executing: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
    console.log(`Final mux stdout: ${stdout}`);
    console.log(`Final mux stderr: ${stderr}`);
  } catch (err) {
    console.error(`FFmpeg final mux error: ${err}`);
    throw new Error(`FFmpeg final mux failed: ${err}`);
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
  let fileId = getGoogleDriveFileId(url);
  if (fileId) {
    return downloadFromGoogleDrive(fileId, output);
  } else {
    return downloadDirect(url, output);
  }
}

function getGoogleDriveFileId(url) {
  if (!url.includes('drive.google.com') && !url.includes('googleusercontent.com')) {
    return null;
  }
  let fileId;
  if (url.includes('/file/d/')) {
    fileId = url.split('/file/d/')[1].split('/')[0];
  } else if (url.includes('id=')) {
    const u = new URL(url);
    fileId = u.searchParams.get('id');
  } else if (url.includes('/open?id=')) {
    const u = new URL(url);
    fileId = u.searchParams.get('id');
  }
  return fileId;
}

async function downloadFromGoogleDrive(fileId, output) {
  let url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let res = await fetch(url, { redirect: 'manual' });

  if (res.status >= 300 && res.status < 400) {
    // Handle redirect if any
    url = res.headers.get('location');
    res = await fetch(url);
  }

  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('text/html')) {
    const text = await res.text();
    const match = text.match(/confirm=([0-9A-Za-z_-]+)&/i);
    if (match) {
      const confirm = match[1];
      url = `https://drive.google.com/uc?export=download&confirm=${confirm}&id=${fileId}`;
      res = await fetch(url);
    } else {
      throw new Error('Could not find confirm token for Google Drive download');
    }
  }

  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

  const stream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

async function downloadDirect(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
  const stream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

/* ============================
   Validator
============================ */
async function validateMedia(filePath, type) {
  let cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  console.log(`Executing: ${cmd}`);
  try {
    const { stdout, stderr } = await execAsync(cmd);
    console.log(`Validate stdout: ${stdout}`);
    console.log(`Validate stderr: ${stderr}`);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration) || duration <= 0) {
      throw new Error('Invalid duration');
    }
  } catch (err) {
    console.error(`Validate error: ${err}`);
    throw new Error(`Invalid ${type} file: ${err}`);
  }
}

/* ============================
   START
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Remotion Render Server running on", PORT);
});
