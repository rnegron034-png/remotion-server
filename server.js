function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (e, stdout, stderr) => {
      if (e) reject(stderr || e);
      else resolve(stdout);
    });
  });
}
// Download audio
const audioRaw = path.join(workDir, "audio.raw");
await run(`curl -L "${audio}" -o "${audioRaw}"`);

// Convert to WAV (this fixes corrupted mp3)
const audioWav = path.join(workDir, "audio.wav");
await run(`ffmpeg -y -i "${audioRaw}" -ar 44100 -ac 2 "${audioWav}"`);
await run(`ffmpeg -y -i "${videoOnly}" -i "${audioWav}" -shortest -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac "${finalOut}"`);

import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;
const VIDEO_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

const JOBS = {};

/* ================= HEALTH ================= */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    jobs: Object.keys(JOBS).length,
    uptime: process.uptime()
  });
});

app.get("/", (req, res) => {
  res.json({ status: "Remotion server running" });
});

/* ================= RENDER ================= */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips[] required" });
    }

    const jobId = uuidv4();
    const workDir = path.join(VIDEO_DIR, jobId);
    fs.mkdirSync(workDir);

    const videoOnly = path.join(workDir, "video.mp4");
    const finalOut = path.join(VIDEO_DIR, `${jobId}.mp4`);

    JOBS[jobId] = { status: "downloading", file: finalOut };

    // 1. Download all clips
    const localClips = [];
    for (let i = 0; i < clips.length; i++) {
      const target = path.join(workDir, `clip${i}.mp4`);
      await run(`curl -L "${clips[i]}" -o "${target}"`);
      localClips.push(target);
    }

    // 2. Remove audio from clips
    const silentClips = [];
    for (let i = 0; i < localClips.length; i++) {
      const silent = path.join(workDir, `silent${i}.mp4`);
      await run(`ffmpeg -y -i "${localClips[i]}" -an -c:v copy "${silent}"`);
      silentClips.push(silent);
    }

    // 3. Create concat list
    const concatFile = path.join(workDir, "list.txt");
    fs.writeFileSync(concatFile, silentClips.map(f => `file '${f}'`).join("\n"));

    JOBS[jobId].status = "rendering";

    // 4. Stitch silent video
    await run(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v libx264 -pix_fmt yuv420p "${videoOnly}"`);

    // 5. Add audio (if exists)
    if (audio) {
      const audioRaw = path.join(workDir, "audio.raw");
      const audioWav = path.join(workDir, "audio.wav");

      await run(`curl -L "${audio}" -o "${audioRaw}"`);
      await run(`ffmpeg -y -i "${audioRaw}" -ar 44100 -ac 2 "${audioWav}"`);
      await run(`ffmpeg -y -i "${videoOnly}" -i "${audioWav}" -shortest -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac "${finalOut}"`);
    } else {
      fs.copyFileSync(videoOnly, finalOut);
    }

    JOBS[jobId].status = "done";
    res.json({ jobId });
  } catch (e) {
    console.error("RENDER ERROR", e);
    res.status(500).json({ error: "render failed" });
  }
});


/* ================= STATUS ================= */
app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

/* ================= DOWNLOAD ================= */
app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

/* ================= UTILS ================= */
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (e, out, err) => {
      if (e) reject(err || out);
      else resolve(out);
    });
  });
}

/* ================= START ================= */
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
