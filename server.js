import express from "express";
import cors from "cors";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import PQueue from "p-queue";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "300mb" }));

const PORT = process.env.PORT || 3000;

/* -------------------- GLOBAL STATE -------------------- */

const jobs = new Map();
const queue = new PQueue({ concurrency: 2 }); // only 2 renders at a time (Railway safe)

/* -------------------- UTILS -------------------- */

function execP(cmd) {
  return new Promise((res, rej) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        console.error(cmd);
        console.error(stderr);
        return rej(stderr || err);
      }
      res(stdout);
    });
  });
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function update(jobId, data) {
  jobs.set(jobId, { ...jobs.get(jobId), ...data });
}

/* -------------------- STATUS -------------------- */

app.get("/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/* -------------------- START RENDER -------------------- */

app.post("/remotion-render", async (req, res) => {
  try {
    const payload = req.body?.client_payload ?? req.body;
    const { scenes, audio, subtitles, title } = payload;

    if (!Array.isArray(scenes) || !scenes.length) throw new Error("Scenes missing");
    if (!audio?.src) throw new Error("Audio missing");
    if (!Array.isArray(subtitles)) throw new Error("Subtitles missing");

    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      status: "queued",
      progress: 0,
      title
    });

    res.json({ jobId });

    queue.add(() => renderJob(jobId, scenes, audio.src, subtitles, title));

  } catch (e) {
    res.status(400).json({ error: e.message, body: req.body });
  }
});

/* -------------------- CORE PIPELINE -------------------- */

async function renderJob(jobId, scenes, audioUrl, subtitles, title) {
  try {
    update(jobId, { status: "downloading" });

    const work = `/tmp/${jobId}`;
    const clipsDir = `${work}/clips`;
    await ensureDir(clipsDir);

    /* -------- PARALLEL CLIP DOWNLOAD + REPAIR -------- */

    await Promise.all(
      scenes.map((s, i) =>
        execP(
          `ffmpeg -y -err_detect ignore_err -i "${s.src}" -map 0:v:0 -map 0:a? -c:v copy -c:a copy ${clipsDir}/${i}.mp4`
        ).then(() => {
          update(jobId, { progress: (i + 1) / scenes.length * 30 });
        })
      )
    );

    /* -------- CONCAT -------- */

    update(jobId, { status: "concat" });

    const list = scenes.map((_, i) => `file '${clipsDir}/${i}.mp4'`).join("\n");
    await fs.writeFile(`${work}/list.txt`, list);

    await execP(`ffmpeg -y -f concat -safe 0 -i ${work}/list.txt -c copy ${work}/video.mp4`);

    /* -------- AUDIO -------- */

    update(jobId, { status: "audio" });

    await execP(`ffmpeg -y -i "${audioUrl}" ${work}/audio.mp3`);

    /* -------- SUBTITLES (SRT) -------- */

    let srt = subtitles
      .map(
        (s, i) =>
          `${i + 1}\n${secToSrt(s.start)} --> ${secToSrt(s.end)}\n${s.text}\n`
      )
      .join("\n");

    await fs.writeFile(`${work}/subs.srt`, srt);

    /* -------- FINAL MUX -------- */

    update(jobId, { status: "mux" });

    await execP(
      `ffmpeg -y -i ${work}/video.mp4 -i ${work}/audio.mp3 -vf subtitles=${work}/subs.srt -map 0:v -map 1:a -c:a copy ${work}/final.mp4`
    );

    update(jobId, {
      status: "done",
      progress: 100,
      url: `/download/${jobId}`
    });

  } catch (e) {
    console.error(e);
    update(jobId, { status: "failed", error: e.toString() });
  }
}

/* -------------------- DOWNLOAD -------------------- */

app.get("/download/:id", (req, res) => {
  const f = `/tmp/${req.params.id}/final.mp4`;
  if (!fsSync.existsSync(f)) return res.status(404).send("Not ready");
  res.sendFile(f);
});

/* -------------------- TIME UTILS -------------------- */

function secToSrt(s) {
  const ms = Math.floor((s % 1) * 1000);
  const t = new Date(s * 1000).toISOString().substr(11, 8);
  return `${t},${String(ms).padStart(3, "0")}`;
}

/* -------------------- START -------------------- */

app.listen(PORT, () => {
  console.log("🚀 Remotion Render Server running on", PORT);
});
