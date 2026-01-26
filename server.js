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
const JOBS = {};
const VIDEO_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

/* =====================
   HEALTH
===================== */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    jobs: Object.keys(JOBS).length,
  });
});

app.get("/", (req, res) => {
  res.json({ status: "Remotion Server Online" });
});

/* =====================
   POST /render
===================== */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be an array" });
    }

    const jobId = uuidv4();
    const workDir = path.join(VIDEO_DIR, jobId);
    fs.mkdirSync(workDir, { recursive: true });

    JOBS[jobId] = { status: "downloading" };

    // ---- Download & normalize all clips ----
    const normalized = [];

    for (let i = 0; i < clips.length; i++) {
      const raw = path.join(workDir, `raw_${i}.mp4`);
      const clean = path.join(workDir, `clean_${i}.mp4`);

      await execPromise(`curl -L "${clips[i]}" -o "${raw}"`);

      // Re-encode to stable H264 + AAC
      await execPromise(
        `ffmpeg -y -i "${raw}" -vf scale=1280:720 -r 30 -c:v libx264 -pix_fmt yuv420p -c:a aac "${clean}"`
      );

      normalized.push(clean);
    }

    // ---- Build concat list ----
    const listFile = path.join(workDir, "list.txt");
    fs.writeFileSync(listFile, normalized.map(f => `file '${f}'`).join("\n"));

    const videoNoAudio = path.join(workDir, "video.mp4");
    await execPromise(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${videoNoAudio}"`
    );

    // ---- Optional Audio ----
    let finalOutput = path.join(VIDEO_DIR, `${jobId}.mp4`);

    if (audio) {
      const audioFile = path.join(workDir, "audio.mp3");

      await execPromise(`curl -L "${audio}" -o "${audioFile}"`);

      // Rebuild audio to safe AAC
      const cleanAudio = path.join(workDir, "audio.aac");
      await execPromise(`ffmpeg -y -i "${audioFile}" -c:a aac "${cleanAudio}"`);

      await execPromise(
        `ffmpeg -y -i "${videoNoAudio}" -i "${cleanAudio}" -shortest -c:v copy -c:a aac "${finalOutput}"`
      );
    } else {
      fs.copyFileSync(videoNoAudio, finalOutput);
    }

    JOBS[jobId] = {
      status: "done",
      file: finalOutput,
    };

    res.json({ jobId });

  } catch (err) {
    console.error("RENDER FAILED:", err);
    res.status(500).json({ error: "Render failed" });
  }
});

/* =====================
   STATUS
===================== */
app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

/* =====================
   DOWNLOAD
===================== */
app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

/* =====================
   START
===================== */
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});

/* =====================
   Helper
===================== */
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}
