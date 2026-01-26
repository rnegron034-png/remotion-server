import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;

/* ================================
   GLOBAL STATE
================================ */
const JOBS = {};
const VIDEO_DIR = path.join(__dirname, "videos");
fs.mkdirSync(VIDEO_DIR, { recursive: true });

/* ================================
   HEALTH
================================ */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    jobs: Object.keys(JOBS).length
  });
});

app.get("/", (req, res) => {
  res.json({ status: "Remotion server running" });
});

/* ================================
   POST /render
================================ */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be a non-empty array" });
    }

    const jobId = uuidv4();
    const workDir = path.join(VIDEO_DIR, jobId);
    fs.mkdirSync(workDir, { recursive: true });

    const output = path.join(VIDEO_DIR, `${jobId}.mp4`);
    JOBS[jobId] = { status: "downloading", file: output };

    /* =============================
       Download clips
    ============================== */
    const localClips = [];

    for (let i = 0; i < clips.length; i++) {
      const target = path.join(workDir, `clip${i}.mp4`);
      await download(clips[i], target);
      localClips.push(target);
    }

    /* =============================
       Download audio
    ============================== */
    let audioFile = null;
    if (audio) {
      audioFile = path.join(workDir, "audio.mp3");
      await download(audio, audioFile);
    }

    /* =============================
       Build concat file
    ============================== */
    const listFile = path.join(workDir, "list.txt");
    fs.writeFileSync(
      listFile,
      localClips.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
    );

    JOBS[jobId].status = "rendering";

    /* =============================
       Run ffmpeg (non-blocking)
    ============================== */
    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile
    ];

    if (audioFile) {
      args.push("-i", audioFile, "-shortest", "-map", "0:v:0", "-map", "1:a:0");
    }

    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", output);

    execFile("ffmpeg", args, (err) => {
      if (err) {
        console.error("FFMPEG ERROR", err);
        JOBS[jobId].status = "error";
      } else {
        JOBS[jobId].status = "done";
      }
    });

    res.json({ jobId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "render failed" });
  }
});

/* ================================
   GET /status/:id
================================ */
app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

/* ================================
   GET /download/:id
================================ */
app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

/* ================================
   Downloader
================================ */
function download(url, target) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-L", url, "-o", target], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/* ================================
   START
================================ */
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
