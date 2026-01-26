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

/* ================================
   Health
================================ */
app.get("/", (req, res) => {
  res.json({ status: "Remotion server running" });
});

/* ================================
   POST /render
================================ */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio, title } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be an array of video URLs" });
    }

    const jobId = uuidv4();
    const output = path.join(VIDEO_DIR, `${jobId}.mp4`);

    JOBS[jobId] = { status: "rendering", file: output };

    // Create concat file
    const concatFile = path.join(VIDEO_DIR, `${jobId}.txt`);
    const list = clips.map(c => `file '${c}'`).join("\n");
    fs.writeFileSync(concatFile, list);

    // Build ffmpeg command
    let cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}"`;

    if (audio) {
      cmd += ` -i "${audio}" -shortest -map 0:v:0 -map 1:a:0`;
    }

    cmd += ` -c:v libx264 -pix_fmt yuv420p "${output}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr);
        JOBS[jobId].status = "error";
        return;
      }
      JOBS[jobId].status = "done";
    });

    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Render failed" });
  }
});

/* ================================
   GET /status/:id
================================ */
app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json({ status: job.status });
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
   Start server
================================ */
app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
