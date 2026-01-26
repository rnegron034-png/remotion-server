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

if (!fsSync.existsSync(VIDEO_DIR)) fsSync.mkdirSync(VIDEO_DIR, { recursive: true });

const JOBS = {};

async function execCmd(cmd, timeout = 600000) {
  const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 50, shell: "/bin/bash" });
  return { stdout, stderr };
}

async function download(url, out) {
  await execCmd(`curl -L --fail --silent --show-error -o "${out}" "${url}"`, 120000);
  const stat = await fs.stat(out);
  if (stat.size === 0) throw new Error("Downloaded file empty");
}

async function repair(input, output) {
  const cmd = `ffmpeg -y -err_detect ignore_err -i "${input}" -map 0:v:0? -map 0:a:0? -c copy -movflags +faststart "${output}"`;
  await execCmd(cmd, 120000);
}

async function normalizeVideo(input, output) {
  const cmd = `ffmpeg -y -fflags +genpts -i "${input}" -map 0:v:0 -vsync cfr -r 30 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -an -movflags +faststart "${output}"`;
  await execCmd(cmd, 300000);
}

async function normalizeAudio(input, output) {
  const cmd = `ffmpeg -y -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 192k "${output}"`;
  await execCmd(cmd, 120000);
}

async function concat(list, audio, out) {
  let cmd = `ffmpeg -y -f concat -safe 0 -i "${list}"`;
  if (audio) cmd += ` -i "${audio}" -shortest`;
  cmd += ` -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${out}"`;
  await execCmd(cmd, 600000);
}

async function clean(dir) {
  if (fsSync.existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  const { clips, audio } = req.body;
  if (!Array.isArray(clips) || clips.length === 0) return res.status(400).json({ error: "clips required" });

  const id = uuidv4();
  const work = path.join(VIDEO_DIR, id);
  await fs.mkdir(work, { recursive: true });

  JOBS[id] = { status: "processing", createdAt: new Date().toISOString() };
  res.json({ jobId: id });

  (async () => {
    try {
      const normalized = [];

      for (let i = 0; i < clips.length; i++) {
        const raw = path.join(work, `raw_${i}.mp4`);
        const repaired = path.join(work, `repaired_${i}.mp4`);
        const final = path.join(work, `clip_${i}.mp4`);

        await download(clips[i], raw);
        await repair(raw, repaired);
        await fs.unlink(raw);

        await normalizeVideo(repaired, final);
        await fs.unlink(repaired);

        normalized.push(final);
      }

      let audioFinal = null;
      if (audio) {
        const rawA = path.join(work, "raw_audio");
        const finalA = path.join(work, "audio.m4a");

        await download(audio, rawA);
        await normalizeAudio(rawA, finalA);
        await fs.unlink(rawA);
        audioFinal = finalA;
      }

      const list = path.join(work, "list.txt");
      await fs.writeFile(list, normalized.map(f => `file '${f}'`).join("\n"));

      const out = path.join(VIDEO_DIR, `${id}.mp4`);
      await concat(list, audioFinal, out);

      JOBS[id] = { status: "done", file: out };

      await clean(work);
    } catch (e) {
      JOBS[id] = { status: "failed", error: e.message };
      await clean(work);
    }
  })();
});

app.get("/status/:id", (req, res) => {
  res.json(JOBS[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const j = JOBS[req.params.id];
  if (!j || j.status !== "done") return res.sendStatus(404);
  res.download(j.file);
});

app.listen(PORT, () => console.log("Server running on", PORT));
