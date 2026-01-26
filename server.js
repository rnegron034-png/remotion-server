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
app.use(express.json({ limit: "100mb" }));

const PORT = process.env.PORT || 8080;
const JOBS = {};

const VIDEO_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

/* ============================
   Health
============================ */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    jobs: Object.keys(JOBS).length,
  });
});

/* ============================
   Render
============================ */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be array" });
    }

    const jobId = uuidv4();
    const workDir = path.join(VIDEO_DIR, jobId);
    fs.mkdirSync(workDir, { recursive: true });

    JOBS[jobId] = { status: "downloading" };

    // 1. Download clips
    const localClips = [];
    for (let i = 0; i < clips.length; i++) {
      const target = path.join(workDir, `clip${i}.mp4`);
      await execPromise(`curl -L "${clips[i]}" -o "${target}"`);
      localClips.push(target);
    }

    // 2. Concat clips (keep their audio too)
    const concatFile = path.join(workDir, "list.txt");
    fs.writeFileSync(concatFile, localClips.map(f => `file '${f}'`).join("\n"));

    const mergedVideo = path.join(workDir, "merged.mp4");
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${mergedVideo}"`);

    // 3. If audio exists, normalize it
    let finalOutput = path.join(VIDEO_DIR, `${jobId}.mp4`);

    if (audio) {
      JOBS[jobId].status = "processing-audio";

      const audioRaw = path.join(workDir, "audio_raw");
      await execPromise(`curl -L "${audio}" -o "${audioRaw}"`);

      const audioWav = path.join(workDir, "audio.wav");

      // Re-encode audio to clean PCM WAV (this fixes Pixabay MP3 corruption)
      await execPromise(
        `ffmpeg -y -err_detect ignore_err -i "${audioRaw}" -ac 2 -ar 44100 -vn "${audioWav}"`
      );

      JOBS[jobId].status = "rendering";

      // Strip video audio + apply clean wav
      await execPromise(
        `ffmpeg -y -i "${mergedVideo}" -i "${audioWav}" -map 0:v:0 -map 1:a:0 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "${finalOutput}"`
      );
    } else {
      JOBS[jobId].status = "rendering";
      await execPromise(`ffmpeg -y -i "${mergedVideo}" -c:v libx264 -pix_fmt yuv420p "${finalOutput}"`);
    }

    JOBS[jobId] = { status: "done", file: finalOutput };

    res.json({ jobId });
  } catch (e) {
    console.error("RENDER ERROR:", e);
    res.status(500).json({ error: "render failed" });
  }
});

/* ============================
   Status
============================ */
app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

/* ============================
   Download
============================ */
app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

/* ============================
   Root
============================ */
app.get("/", (req, res) => {
  res.json({ status: "Remotion server running" });
});

/* ============================
   Start
============================ */
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});

/* ============================
   Helpers
============================ */
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        reject(err);
      } else resolve(stdout);
    });
  });
}
