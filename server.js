import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { exec } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.PUPPETEER_EXECUTABLE_PATH = "/usr/bin/chromium";
process.env.REMOTION_BROWSER = "chromium";

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
const MAX = 1; // Railway RAM safety

/* ===================== UTIL ===================== */

function run(cmd) {
  return new Promise((resolve, reject) => {
    console.log("\nRUN:", cmd);
    const p = exec(cmd, { maxBuffer: 1024 * 1024 * 500 });

    p.stdout.on("data", d => console.log(d.toString()));
    p.stderr.on("data", d => console.error(d.toString()));

    p.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error("Command failed: " + code));
    });
  });
}

async function download(url, out) {
  await run(`curl -L --fail --silent --show-error -o "${out}" "${url}"`);
}

/* ===================== REMOTION RENDER ===================== */

app.post("/remotion-render", async (req, res) => {
  if (active >= MAX) return res.status(503).json({ error: "Server busy" });

  const jobId = uuidv4();
  const dir = path.join(WORK, jobId);
  await fs.mkdir(dir, { recursive: true });

  const { scenes, audio } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: "Scenes required" });

  JOBS[jobId] = { status: "rendering", progress: 1 };
  res.json({ jobId });

  (async () => {
    active++;
    try {
      console.log("\n=== JOB", jobId, "===");

      /* 1) Download assets */
      for (let i = 0; i < scenes.length; i++) {
        const f = path.join(dir, `scene_${i}`);
        await download(scenes[i].src, f);
        scenes[i].local = f;
      }

      if (audio) {
        const a = path.join(dir, "audio.mp3");
        await download(audio.src, a);
        audio.local = a;
      }

      /* 2) Write props */
      const props = path.join(dir, "props.json");
      await fs.writeFile(props, JSON.stringify({ scenes, audio }));

      /* 3) Render with Remotion */
      const video = path.join(dir, "video.mp4");

await run(`
npx remotion render remotion/index.ts Video "${video}"
--props="${props}"
--codec=h264
--browser-executable=/usr/bin/chromium
--chromium-flags="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --single-process --no-zygote"
--log=verbose
`);

      /* 4) Mux audio */
      const final = path.join(WORK, `${jobId}.mp4`);
      if (audio) {
        await run(`ffmpeg -y -i "${video}" -i "${audio.local}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${final}"`);
      } else {
        await fs.rename(video, final);
      }

      JOBS[jobId] = { status: "done", file: final };
      console.log("DONE", jobId);

    } catch (e) {
      console.error("RENDER FAILED:", e);
      JOBS[jobId] = { status: "failed", error: e.message };
    } finally {
      active--;
    }
  })();
});

/* ===================== STATUS ===================== */

app.get("/status/:id", (req, res) => res.json(JOBS[req.params.id] || { status: "unknown" }));

app.get("/download/:id", (req, res) => {
  const j = JOBS[req.params.id];
  if (!j || j.status !== "done") return res.status(404).json({ error: "Not ready" });
  res.download(j.file);
});

app.listen(PORT, () => console.log("REMOTION RENDER SERVER LIVE"));
