import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import { execFile } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const WORK = "/tmp/jobs";
fsSync.mkdirSync(WORK, { recursive: true });

const JOBS = {};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 500 }, (err, stdout, stderr) => {
      if (err) {
        console.error(stderr);
        reject(stderr || err.message);
      } else {
        console.log(stdout);
        resolve(stdout);
      }
    });
  });
}

async function download(url, out) {
  await run("curl", ["-L", "-o", out, url]);
}

/* ===================== RENDER ===================== */

app.post("/remotion-render", async (req, res) => {
  const { scenes, audio } = req.body;

  if (!scenes || !scenes.length) {
    return res.status(400).json({ error: "Scenes required" });
  }

  const jobId = uuid();
  const dir = path.join(WORK, jobId);
  await fs.mkdir(dir, { recursive: true });

  JOBS[jobId] = { status: "rendering" };
  res.json({ jobId });

  (async () => {
    try {
      // Download scenes
      for (let i = 0; i < scenes.length; i++) {
        const f = path.join(dir, `scene_${i}.mp4`);
        await download(scenes[i].src, f);
        scenes[i].src = f;
      }

      // Download audio
      if (audio) {
        const a = path.join(dir, "audio.mp3");
        await download(audio.src, a);
        audio.src = a;
      }

      // Write props
      const propsFile = path.join(dir, "props.json");
      await fs.writeFile(propsFile, JSON.stringify({ scenes, audio }));

      const out = path.join(dir, "video.mp4");

      await run("npx", [
        "remotion",
        "render",
        "remotion/index.tsx",
        "Video",
        out,
        `--props=${propsFile}`,
        "--codec=h264",
        "--browser-executable=/usr/bin/chromium"
      ]);

      JOBS[jobId] = { status: "done", file: out };

    } catch (e) {
      console.error("RENDER FAILED", e);
      JOBS[jobId] = { status: "failed", error: String(e) };
    }
  })();
});

/* ===================== STATUS ===================== */

app.get("/status/:id", (req, res) => {
  res.json(JOBS[req.params.id] || { status: "unknown" });
});

app.get("/download/:id", (req, res) => {
  const j = JOBS[req.params.id];
  if (!j || j.status !== "done") return res.status(404).end();
  res.download(j.file);
});

app.listen(8080, () => console.log("REMOTION SERVER LIVE"));
