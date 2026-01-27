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

// === CONFIGURATION (tunable & future-proof) ===
const MAX_CONCURRENT_JOBS = 3;                  // Prevent overload
const JOB_EXPIRY_MS = 60 * 60 * 1000;            // 1 hour – final video & metadata auto-delete
const MAX_CLIPS = 50;
const DOWNLOAD_TIMEOUT_MS = 120000;
const PROCESS_TIMEOUT_MS = 600000;

// === GLOBAL STATE ===
const JOBS = {};
let activeProcessingJobs = 0;

// Ensure directories
if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

// === UTILS ===
async function execCommand(cmd, timeout = PROCESS_TIMEOUT_MS, description = "") {
  console.log(`[${description || "FFmpeg"}] ${cmd.substring(0, 300)}${cmd.length > 300 ? "..." : ""}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      maxBuffer: 100 * 1024 * 1024,
      shell: "/bin/bash",
    });
    if (stderr && !stderr.includes("frame=")) console.warn(`FFmpeg stderr: ${stderr.trim()}`);
    if (stdout) console.log(`FFmpeg stdout: ${stdout.trim()}`);
    return { stdout, stderr };
  } catch (error) {
    const errMsg = error.stderr?.trim() || error.stdout?.trim() || error.message;
    console.error(`FFmpeg failed (${description}): ${errMsg}`);
    throw new Error(`FFmpeg error: ${errMsg}`);
  }
}

async function downloadFile(url, output) {
  try { new URL(url); } catch { throw new Error("Invalid URL"); }

  console.log(`Downloading: ${url}`);
  const cmd = `curl -L --max-time 120 --fail --silent --show-error -A "Mozilla/5.0" -o "${output}" "${url}"`;
  await execCommand(cmd, DOWNLOAD_TIMEOUT_MS, "Download");

  const stat = await fs.stat(output);
  if (stat.size === 0) throw new Error("Downloaded file empty");
  console.log(`Downloaded: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

// Only cleans temporary working files – NEVER touches the final video
async function cleanupWorkDir(jobId) {
  try {
    const workDir = path.join(VIDEO_DIR, jobId);
    if (fsSync.existsSync(workDir)) {
      await fs.rm(workDir, { recursive: true, force: true });
      console.log(`Cleaned temporary files: ${jobId}`);
    }
  } catch (err) {
    console.error(`Temp cleanup failed (${jobId}): ${err.message}`);
  }
}

// === ROUTES ===
app.use(cors());
app.use(express.json({ limit: "100mb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    activeJobs: activeProcessingJobs,
    trackedJobs: Object.keys(JOBS).length,
    timestamp: new Date().toISOString(),
  });
});

app.post("/render", async (req, res) => {
  if (activeProcessingJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({ error: "Server busy – too many jobs. Try later." });
  }

  const jobId = uuidv4();
  const { clips = [], audio } = req.body;

  // Strict validation
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips array required and non-empty" });
  }
  if (clips.length > MAX_CLIPS) {
    return res.status(400).json({ error: `Max ${MAX_CLIPS} clips` });
  }
  for (const url of clips) {
    if (typeof url !== "string" || !url.startsWith("http")) {
      return res.status(400).json({ error: "Invalid clip URL" });
    }
  }
  if (audio && (typeof audio !== "string" || !audio.startsWith("http"))) {
    return res.status(400).json({ error: "Invalid audio URL" });
  }

  const workDir = path.join(VIDEO_DIR, jobId);
  await fs.mkdir(workDir, { recursive: true });

  JOBS[jobId] = {
    status: "processing",
    totalClips: clips.length,
    hasAudio: !!audio,
    createdAt: new Date().toISOString(),
    progress: 0,
  };

  res.json({ jobId, status: "processing", message: "Job started" });

  // Background processing with proper lifecycle
  (async () => {
    activeProcessingJobs++;
    let finalPath = null;
    try {
      finalPath = await processRenderJob(jobId, workDir, clips, audio);
    } catch (err) {
      console.error(`Job ${jobId} failed: ${err.message}`);
      if (JOBS[jobId]) {
        JOBS[jobId] = {
          ...JOBS[jobId],
          status: "failed",
          error: err.message || "Unknown error",
          failedAt: new Date().toISOString(),
        };
      }
    } finally {
      activeProcessingJobs--;

      // Auto-expire metadata AND final video after 1 hour
      setTimeout(async () => {
        delete JOBS[jobId];
        console.log(`Expired job metadata: ${jobId}`);

        if (finalPath && fsSync.existsSync(finalPath)) {
          await fs.unlink(finalPath);
          console.log(`Auto-deleted final video: ${path.basename(finalPath)}`);
        }
      }, JOB_EXPIRY_MS);
    }
  })();
});

async function processRenderJob(jobId, workDir, clips, audioUrl) {
  console.log(`\nStarting job ${jobId} | Clips: ${clips.length} | Audio: ${!!audioUrl}`);

  const normalizedClips = [];

  // Process clips
  for (let i = 0; i < clips.length; i++) {
    console.log(`\nClip ${i + 1}/${clips.length}`);
    const rawPath = path.join(workDir, `raw_${i}`);
    const fixedPath = path.join(workDir, `fixed_${i}.mp4`);
    const normPath = path.join(workDir, `norm_${i}.mp4`);

    await downloadFile(clips[i], rawPath);
    await repairMp4(rawPath, fixedPath);
    await fs.unlink(rawPath).catch(() => {});
    await normalizeVideo(fixedPath, normPath);
    await fs.unlink(fixedPath).catch(() => {});

    normalizedClips.push(normPath);

    JOBS[jobId].progress = Math.round(60 * (i + 1) / clips.length);
  }

  // Process audio
  let audioFile = null;
  if (audioUrl) {
    console.log("\nAudio processing");
    const rawAudio = path.join(workDir, "raw_audio");
    audioFile = path.join(workDir, "audio.m4a");

    await downloadFile(audioUrl, rawAudio);
    await normalizeAudio(rawAudio, audioFile);
    await fs.unlink(rawAudio).catch(() => {});

    JOBS[jobId].progress = 70;
  }

  // Final assembly
  console.log("\nConcatenating videos");
  JOBS[jobId].progress = 80;

  const listPath = path.join(workDir, "list.txt");
  await fs.writeFile(listPath, normalizedClips.map(f => `file '${f}'`).join("\n"));

  const videoOnlyPath = path.join(workDir, "video_only.mp4");
  const finalPath = path.join(VIDEO_DIR, `${jobId}.mp4`);

  // Stream-copy concat (fast & reliable)
  await execCommand(
    `ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart "${videoOnlyPath}"`,
    PROCESS_TIMEOUT_MS,
    "Video concat"
  );

  // Mux audio if present
  if (audioFile) {
    console.log("Muxing audio");
    await execCommand(
      `ffmpeg -y -hide_banner -loglevel error -i "${videoOnlyPath}" -i "${audioFile}" -c copy -map 0:v:0 -map 1:a:0 -shortest -movflags +faststart "${finalPath}"`,
      PROCESS_TIMEOUT_MS,
      "Audio mux"
    );
    await fs.unlink(videoOnlyPath).catch(() => {});
  } else {
    await fs.rename(videoOnlyPath, finalPath);
  }

  const stat = await fs.stat(finalPath);
  if (stat.size === 0) throw new Error("Final video empty");

  console.log(`\nJob ${jobId} SUCCESS | Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  JOBS[jobId] = {
    ...JOBS[jobId],
    status: "done",
    file: finalPath,
    fileSize: stat.size,
    progress: 100,
    completedAt: new Date().toISOString(),
  };

  // Clean temporary files immediately – keep final video for download
  await cleanupWorkDir(jobId);

  return finalPath; // for expiry deletion
}

// FFmpeg steps
async function repairMp4(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "${input}" -map 0:v:0? -map 0:a:0? -c copy -movflags +faststart "${output}"`;
  try {
    await execCommand(cmd, 60000, "Repair");
  } catch {
    console.log("Repair skipped → using raw");
    await fs.rename(input, output);
  }
}

async function normalizeVideo(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel error -fflags +genpts -i "${input}" ` +
    `-map 0:v:0 -vsync cfr -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
    `-c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -movflags +faststart -an "${output}"`;
  await execCommand(cmd, PROCESS_TIMEOUT_MS, "Normalize video");
}

async function normalizeAudio(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel error -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 192k "${output}"`;
  await execCommand(cmd, 120000, "Normalize audio");
}

// Status & download
app.get("/status/:id", (req, res) => {
  const jobId = req.params.id;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).json({ error: "Invalid job ID" });

  const job = JOBS[jobId];
  if (!job) return res.json({ status: "unknown", message: "Job expired or not found" });

  const { file, ...safe } = job;
  res.json(safe);
});

app.get("/download/:id", (req, res) => {
  const jobId = req.params.id;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).json({ error: "Invalid job ID" });

  const job = JOBS[jobId];
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  if (job.status !== "done") return res.status(400).json({ error: "Not ready", progress: job.progress });

  if (!fsSync.existsSync(job.file)) {
    // Defensive: if file gone but status done (rare race), mark expired
    delete JOBS[jobId];
    return res.status(410).json({ error: "Video expired and deleted" });
  }

  res.download(job.file, `video_${jobId}.mp4`);
});

// Error handling
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  res.status(500).json({ error: "Server error" });
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down gracefully...");
  server.close(async () => {
    for (const jobId of Object.keys(JOBS)) {
      await cleanupWorkDir(jobId).catch(() => {});
    }
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`\nVideo Render Server running on port ${PORT}`);
  console.log(`Videos stored in: ${VIDEO_DIR}`);
  console.log(`Max concurrent: ${MAX_CONCURRENT_JOBS} | Video kept for: ${JOB_EXPIRY_MS / 60000} minutes`);
});

export default app;
