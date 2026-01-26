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
app.use(express.json({ limit: "100mb" }));

if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

const JOBS = {};

async function execCommand(cmd, timeout = 300000) {
  console.log(cmd);
  return await execAsync(cmd, {
    timeout,
    maxBuffer: 1024 * 1024 * 100,
    shell: "/bin/bash",
  });
}

async function downloadFile(url, output) {
  await execCommand(
    `curl -L --fail --silent --show-error -o "${output}" "${url}"`
  );
  const stat = await fs.stat(output);
  if (stat.size === 0) throw new Error("Download empty");
}

async function repairMp4(input, output) {
  const cmd =
    `ffmpeg -y -err_detect ignore_err -i "${input}" ` +
    `-map 0:v:0? -map 0:a:0? -c copy -movflags +faststart "${output}"`;
  try {
    await execCommand(cmd);
  } catch {
    await fs.rename(input, output);
  }
}

async function normalizeVideo(input, output) {
  const cmd =
    `ffmpeg -y -fflags +genpts -i "${input}" ` +
    `-map 0:v:0 -vsync cfr -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
    `-movflags +faststart -an "${output}"`;
  await execCommand(cmd);
  const s = await fs.stat(output);
  if (s.size === 0) throw new Error("Normalized video empty");
}

async function normalizeAudio(input, output) {
  await execCommand(
    `ffmpeg -y -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 192k "${output}"`
  );
}

async function concatVideos(listFile, audio, out) {
  let cmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}"`;
  if (audio) cmd += ` -i "${audio}" -shortest`;
  cmd += ` -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k "${out}"`;
  await execCommand(cmd, 600000);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  const { clips, audio } = req.body;
  if (!clips || !clips.length) return res.status(400).json({ error: "No clips" });

  const jobId = uuidv4();
  const workDir = path.join(VIDEO_DIR, jobId);
  await fs.mkdir(workDir, { recursive: true });

  JOBS[jobId] = { status: "processing" };
  res.json({ jobId });

  (async () => {
    try {
      const normalized = [];

      for (let i = 0; i < clips.length; i++) {
        const raw = path.join(workDir, `raw_${i}.mp4`);
        const fixed = path.join(workDir, `fixed_${i}.mp4`);
        const out = path.join(workDir, `clip_${i}.mp4`);

        await downloadFile(clips[i], raw);
        await repairMp4(raw, fixed);
        await fs.unlink(raw);
        await normalizeVideo(fixed, out);
        await fs.unlink(fixed);
        normalized.push(out);
      }

      let audioFile = null;
      if (audio) {
        const raw = path.join(workDir, "raw_audio");
        const fixed = path.join(workDir, "audio.m4a");
        await downloadFile(audio, raw);
        await normalizeAudio(raw, fixed);
        await fs.unlink(raw);
        audioFile = fixed;
      }

      const list = normalized.map(f => `file '${f}'`).join("\n");
      const listFile = path.join(workDir, "list.txt");
      await fs.writeFile(listFile, list);

      const final = path.join(VIDEO_DIR, `${jobId}.mp4`);
      await concatVideos(listFile, audioFile, final);

      JOBS[jobId] = { status: "done", file: final };
    } catch (e) {
      console.error(e);
      JOBS[jobId] = { status: "failed", error: e.message };
    }
  })();
});

app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.status(404).end();
  res.download(job.file);
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
