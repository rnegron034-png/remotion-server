import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const PORT = process.env.PORT || 8080;
const VIDEO_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

const JOBS = {};

/* ------------------ UTILS ------------------ */

function run(cmd) {
  console.log("RUN:", cmd);
  execSync(cmd, { stdio: "inherit" });
}

function download(url, out) {
  run(`curl -L -A "Mozilla/5.0" "${url}" -o "${out}"`);
}

function validate(file) {
  run(`ffprobe -v error "${file}"`);
}

function normalizeVideo(input, output) {
  run(
    `ffmpeg -y -i "${input}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -an "${output}"`
  );
}

function normalizeAudio(input, output) {
  run(
    `ffmpeg -y -i "${input}" -vn -ac 2 -ar 44100 -c:a aac "${output}"`
  );
}

/* ------------------ ROUTES ------------------ */

app.get("/health", (req, res) => {
  res.json({ ok: true, jobs: Object.keys(JOBS).length });
});

app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;
    if (!Array.isArray(clips) || clips.length === 0)
      return res.status(400).json({ error: "clips required" });

    const id = uuidv4();
    const work = path.join(VIDEO_DIR, id);
    fs.mkdirSync(work);

    JOBS[id] = { status: "downloading" };

    const safeVideos = [];

    for (let i = 0; i < clips.length; i++) {
      const raw = path.join(work, `raw${i}.mp4`);
      const safe = path.join(work, `safe${i}.mp4`);

      download(clips[i], raw);
      validate(raw);
      normalizeVideo(raw, safe);

      safeVideos.push(safe);
    }

    let safeAudio = null;
    if (audio) {
      const raw = path.join(work, "raw.mp3");
      const safe = path.join(work, "safe.m4a");

      download(audio, raw);
      validate(raw);
      normalizeAudio(raw, safe);

      safeAudio = safe;
    }

    const listFile = path.join(work, "list.txt");
    fs.writeFileSync(listFile, safeVideos.map(f => `file '${f}'`).join("\n"));

    const output = path.join(VIDEO_DIR, `${id}.mp4`);
    JOBS[id] = { status: "rendering", file: output };

    let cmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}"`;
    if (safeAudio) cmd += ` -i "${safeAudio}" -shortest`;
    cmd += ` -c:v libx264 -c:a aac -pix_fmt yuv420p "${output}"`;

    run(cmd);

    JOBS[id].status = "done";
    res.json({ jobId: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "render failed" });
  }
});

app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

app.listen(PORT, () => console.log("Listening on", PORT));
