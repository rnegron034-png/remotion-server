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
const MAX = 1; // Safe for limited containers

function run(cmd, description = "") {
  return new Promise((resolve, reject) => {
    console.log(`\n[${description || "EXEC"}] ${cmd}`);
    const p = exec(cmd, {
      maxBuffer: 1024 * 1024 * 500,
      env: process.env,
      timeout: 1800000, // 30 min timeout per command
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", d => {
      const text = d.toString();
      stdout += text;
      console.log(text);
    });
    p.stderr.on("data", d => {
      const text = d.toString();
      stderr += text;
      console.warn(text);
    });
    p.on("exit", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    p.on("error", err => reject(err));
  });
}

async function download(url, out) {
  await run(`curl -L --max-time 180 --fail --silent --show-error -A "Mozilla/5.0" "${url}" -o "${out}"`, "Download");
  const stat = await fs.stat(out);
  if (stat.size === 0) throw new Error("Downloaded file empty");
}

app.post("/remotion-render", async (req, res) => {
  try {
    if (active >= MAX) return res.status(503).json({ error: "Server busy – only 1 job at a time" });

    const { scenes, audio, fps = 30 } = req.body;

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "scenes array is required and must not be empty" });
    }

    // Basic validation
    for (const s of scenes) {
      if (typeof s.src !== "string" || !s.src.startsWith("http")) {
        return res.status(400).json({ error: "Invalid scene src URL" });
      }
      if (typeof s.start !== "number" || typeof s.duration !== "number" || s.duration <= 0) {
        return res.status(400).json({ error: "Invalid start/duration in scene" });
      }
      if (!["video", "image"].includes(s.type)) {
        return res.status(400).json({ error: "Scene type must be 'video' or 'image'" });
      }
    }

    if (audio && (typeof audio.src !== "string" || !audio.src.startsWith("http"))) {
      return res.status(400).json({ error: "Invalid audio src URL" });
    }

    const jobId = uuidv4();
    const dir = path.join(WORK, jobId);
    await fs.mkdir(dir, { recursive: true });

    JOBS[jobId] = { status: "processing", progress: 5, message: "Preparing assets" };
    res.json({ jobId, status: "processing" });

    (async () => {
      active++;
      try {
        // Calculate total duration for --frames
        let totalDuration = 0;
        for (const s of scenes) {
          const end = s.start + s.duration;
          if (end > totalDuration) totalDuration = end;
        }
        const totalFrames = Math.ceil(totalDuration * fps);

        // Download all assets
        const processedScenes = [];
        for (let i = 0; i < scenes.length; i++) {
          const s = scenes[i];
          const ext = s.type === "video" ? ".mp4" : ".jpg";
          const local = path.join(dir, `asset_${i}${ext}`);
          await download(s.src, local);
          processedScenes.push({ ...s, local });
          JOBS[jobId].progress = 10 + Math.round(40 * (i + 1) / scenes.length);
        }

        let audioLocal = null;
        let audioTrim = audio?.trim;
        if (audio?.src) {
          audioLocal = path.join(dir, "audio.mp3");
          await download(audio.src, audioLocal);
          JOBS[jobId].progress = 55;
        }

        // Write props
        const propsPath = path.join(dir, "props.json");
        await fs.writeFile(propsPath, JSON.stringify({
          scenes: processedScenes,
          audio: audioLocal ? { local: audioLocal, trim: audioTrim } : null,
          fps,
        }));

        JOBS[jobId].progress = 60;
        JOBS[jobId].message = "Rendering with Remotion";

        // Render command – high quality, safe flags
        const outputVideo = path.join(WORK, `${jobId}.mp4`);
        const cmd = [
          "npx remotion render",
          "remotion/index.ts", // ← adjust if your entry file is different (e.g. video/index.ts)
          "Video",              // ← composition ID
          `"${outputVideo}"`,
          `--props="${propsPath}"`,
          "--codec=h264",
          "--crf=18",               // excellent quality
          "--pixel-format=yuv420p",
          "--concurrency=1",        // prevent CPU overload
          `--frames=0-${totalFrames - 1}`,
          "--log=verbose"
        ].join(" ");

        await run(cmd, "Remotion render");

        JOBS[jobId] = {
          status: "done",
          file: outputVideo,
          fileSize: (await fs.stat(outputVideo)).size,
          progress: 100,
          completedAt: new Date().toISOString(),
        };

        console.log(`\nSUCCESS: Job ${jobId} completed`);

      } catch (e) {
        console.error("\nRENDER FAILED:", e);
        JOBS[jobId] = {
          status: "failed",
          error: e.message || "Unknown rendering error",
          failedAt: new Date().toISOString(),
        };
      } finally {
        active--;
        // Always clean temporary assets (keep only final video)
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  const { file, ...safe } = job;
  res.json(safe);
});

app.get("/download/:id", (req, res) => {
  const job = JOBS[req.params.id];
  if (!job || job.status !== "done") return res.status(404).json({ error: "Not ready or not found" });
  if (!fsSync.existsSync(job.file)) {
    delete JOBS[req.params.id];
    return res.status(410).json({ error: "Video expired" });
  }
  res.download(job.file, `video_${req.params.id}.mp4`);
});

app.listen(PORT, () => console.log(`\nRemotion Render Server LIVE on port ${PORT}`));
