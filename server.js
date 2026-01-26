import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const VIDEO_DIR = path.join(__dirname, "videos");

app.use(cors());
app.use(express.json({ limit: "200mb" }));

const JOBS = {};

if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

/* ================== SYSTEM ================== */

async function run(cmd, timeout = 600000) {
  const { stdout, stderr } = await execAsync(cmd, {
    timeout,
    maxBuffer: 1024 * 1024 * 100,
    shell: "/bin/bash",
  });
  return { stdout, stderr };
}

/* ================== DOWNLOAD ================== */

async function download(url, out) {
  await run(`curl -L --fail --silent --show-error -o "${out}" "${url}"`, 120000);
  const stat = await fs.stat(out);
  if (stat.size < 1000) throw new Error("Downloaded file is empty");
}

/* ================== REPAIR ================== */

async function repair(input, output) {
  await run(`
    ffmpeg -y -err_detect ignore_err \
    -i "${input}" \
    -map 0:v:0? -map 0:a:0? \
    -c copy \
    -movflags +faststart \
    "${output}"
  `, 120000);
}

/* ================== NORMALIZE ================== */

async function normalizeVideo(input, output) {
  await run(`
    ffmpeg -y -fflags +genpts \
    -i "${input}" \
    -map 0:v:0 \
    -vsync cfr -r 30 \
    -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" \
    -c:v libx264 -pix_fmt yuv420p \
    -profile:v high -level 4.0 \
    -an \
    -movflags +faststart \
    "${output}"
  `, 300000);
}

async function normalizeAudio(input, output) {
  await run(`
    ffmpeg -y -i "${input}" \
    -vn -ac 2 -ar 48000 \
    -c:a aac -b:a 192k \
    "${output}"
  `, 120000);
}

/* ================== CONCAT ================== */

async function concat(list, audio, out) {
  let cmd = `ffmpeg -y -f concat -safe 0 -i "${list}"`;
  if (audio) cmd += ` -i "${audio}" -shortest -map 0:v:0 -map 1:a:0`;
  else cmd += ` -map 0:v:0`;

  cmd += `
    -c:v libx264 -pix_fmt yuv420p
    -c:a aac -b:a 192k
    -movflags +faststart
    "${out}"
  `;

  await run(cmd, 600000);
}

/* ================== JOB ENGINE ================== */

async function processJob(id, clips, audio) {
  const dir = path.join(VIDEO_DIR, id);
  await fs.mkdir(dir, { recursive: true });

  try {
    JOBS[id] = { status: "downloading", created: Date.now() };

    const normalized = [];

    for (let i = 0; i < clips.length; i++) {
      const raw = path.join(dir, `raw_${i}.mp4`);
      const fixed = path.join(dir, `fixed_${i}.mp4`);
      const clean = path.join(dir, `clip_${i}.mp4`);

      await download(clips[i], raw);
      await repair(raw, fixed);
      await normalizeVideo(fixed, clean);

      normalized.push(clean);
      await fs.rm(raw);
      await fs.rm(fixed);
    }

    let audioFile = null;
    if (audio) {
      const rawA = path.join(dir, "audio_raw");
      const normA = path.join(dir, "audio.m4a");
      await download(audio, rawA);
      await normalizeAudio(rawA, normA);
      audioFile = normA;
      await fs.rm(rawA);
    }

    const list = path.join(dir, "list.txt");
    await fs.writeFile(list, normalized.map(f => `file '${f}'`).join("\n"));

    const out = path.join(VIDEO_DIR, `${id}.mp4`);
    JOBS[id].status = "rendering";

    await concat(list, audioFile, out);

    const stat = await fs.stat(out);
    if (stat.size < 1000) throw new Error("Output video is empty");

    JOBS[id] = { status: "done", file: out, size: stat.size };

    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    JOBS[id] = { status: "failed", error: err.message };
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ================== ROUTES ================== */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", (req, res) => {
  const { clips, audio } = req.body;
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips required" });
  }

  const id = uuidv4();
  JOBS[id] = { status: "queued" };

  processJob(id, clips, audio);

  res.json({ jobId: id });
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

app.listen(PORT, () => {
  console.log("Video renderer listening on", PORT);
});
