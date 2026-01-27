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
const WORK = path.join(__dirname, "videos");

if (!fsSync.existsSync(WORK)) fsSync.mkdirSync(WORK, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "200mb" }));

const JOBS = {};
let active = 0;
const MAX = 2;

/* ------------------ UTILS ------------------ */

async function run(cmd) {
  console.log(cmd);
  const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 200 });
  if (stderr) console.log(stderr);
  return stdout;
}

async function download(url, out) {
  await run(`curl -L --fail -o "${out}" "${url}"`);
}

/* ------------------ REMOTION RENDER ------------------ */

app.post("/remotion-render", async (req, res) => {
  if (active >= MAX) return res.status(503).json({ error: "Server busy" });

  const jobId = uuidv4();
  const jobDir = path.join(WORK, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const { scenes, audio } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: "Scenes required" });

  JOBS[jobId] = { status: "rendering", progress: 0 };
  res.json({ jobId });

  (async () => {
    active++;
    try {
      /* 1. Download media */
      for (let i = 0; i < scenes.length; i++) {
        const p = path.join(jobDir, `scene_${i}`);
        await download(scenes[i].src, p);
        scenes[i].local = p;
      }
      if (audio) {
        const a = path.join(jobDir, "audio.mp3");
        await download(audio.src, a);
        audio.local = a;
      }

      /* 2. Save props */
      const propsPath = path.join(jobDir, "props.json");
      await fs.writeFile(propsPath, JSON.stringify({ scenes, audio }));

      /* 3. Render with Remotion */
      const outVideo = path.join(jobDir, "video.mp4");

      await run(
        `npx remotion render remotion/index.ts Video "${outVideo}" --props="${propsPath}" --codec=h264`
      );

      /* 4. Mux audio */
      const final = path.join(WORK, `${jobId}.mp4`);
      if (audio) {
        await run(
          `ffmpeg -y -i "${outVideo}" -i "${audio.local}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${final}"`
        );
      } else {
        await fs.rename(outVideo, final);
      }

      JOBS[jobId] = { status: "done", file: final };

    } catch (e) {
      JOBS[jobId] = { status: "failed", error: e.message };
    } finally {
      active--;
    }
  })();
});

/* ------------------ STATUS & DOWNLOAD ------------------ */

app.get("/status/:id", (req, res) => res.json(JOBS[req.params.id] || { status: "unknown" }));

app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.status(404).json({ error: "Not ready" });
  res.download(job.file);
});

app.listen(PORT, () => console.log("RENDER SERVER LIVE"));
