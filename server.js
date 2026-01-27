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

// === IMPROVED CONFIGURATION (better quality + maximum reliability) ===
const MAX_CONCURRENT_JOBS = 2;                  // Reduced to 2 for extra safety on limited hosting
const JOB_EXPIRY_MS = 3 * 60 * 60 * 1000;        // 3 hours – plenty of time for download/n8n
const MAX_CLIPS = 50;
const DOWNLOAD_TIMEOUT_MS = 180000;             // 3 min per download
const PROCESS_TIMEOUT_MS = 1800000;             // 30 min per FFmpeg step (safe for veryfast)

// === GLOBAL STATE ===
const JOBS = {};
let activeProcessingJobs = 0;

// Ensure directories
if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

// === UTILS ===
async function execCommand(cmd, timeout = PROCESS_TIMEOUT_MS, description = "") {
  console.log(`[${description || "FFmpeg"}] ${cmd.substring(0, 500)}${cmd.length > 500 ? "..." : ""}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      maxBuffer: 200 * 1024 * 1024, // Larger buffer for better logs
      shell: "/bin/bash",
      killSignal: "SIGKILL",
    });
    if (stderr && !stderr.includes("frame=") && !stderr.includes("speed=")) {
      console.warn(`FFmpeg stderr (${description}): ${stderr.trim()}`);
    }
    return { stdout, stderr };
  } catch (error) {
    let errMsg = error.stderr?.trim() || error.stdout?.trim() || error.message || "Unknown FFmpeg error";
    if (error.timedOut) errMsg = `Timeout: ${errMsg}`;
    if (error.killed) errMsg = `Killed by system (likely OOM/low resources): ${errMsg}`;
    console.error(`FFmpeg FAILED (${description}): ${errMsg}`);
    throw new Error(`FFmpeg error (${description}): ${errMsg}`);
  }
}

async function downloadFile(url, output) {
  try { new URL(url); } catch { throw new Error("Invalid URL format"); }

  console.log(`Downloading: ${url}`);
  const cmd = `curl -L --max-time 180 --fail --silent --show-error -A "Mozilla/5.0" -o "${output}" "${url}"`;
  await execCommand(cmd, DOWNLOAD_TIMEOUT_MS, "Download");

  const stat = await fs.stat(output);
  if (stat.size === 0) throw new Error("Downloaded file is empty");
  console.log(`Downloaded: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

// Clean only temporary files (never touches final video)
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
app.use(express.json({ limit: "150mb" }));

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
    return res.status(503).json({ error: "Server busy – too many concurrent jobs. Try later." });
  }

  const jobId = uuidv4();
  const { clips = [], audio } = req.body;

  // Strict validation
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips array required and non-empty" });
  }
  if (clips.length > MAX_CLIPS) {
    return res.status(400).json({ error: `Max ${MAX_CLIPS} clips allowed` });
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

  res.json({ jobId, status: "processing", message: "Job started successfully" });

  // Background processing
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

      // Auto-expire metadata + final video after 3 hours
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

  for (let i = 0; i < clips.length; i++) {
    console.log(`\nProcessing clip ${i + 1}/${clips.length}`);
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
    console.log(`Clip ${i + 1} normalized`);
  }

  let audioFile = null;
  if (audioUrl) {
    console.log("\nProcessing audio");
    const rawAudio = path.join(workDir, "raw_audio");
    audioFile = path.join(workDir, "audio.m4a");

    await downloadFile(audioUrl, rawAudio);
    await normalizeAudio(rawAudio, audioFile);
    await fs.unlink(rawAudio).catch(() => {});

    JOBS[jobId].progress = 70;
    console.log("Audio normalized");
  }

  console.log("\nConcatenating videos (stream copy)");
  JOBS[jobId].progress = 80;

  const listPath = path.join(workDir, "list.txt");
  await fs.writeFile(listPath, normalizedClips.map(f => `file '${f}'`).join("\n"));

  const videoOnlyPath = path.join(workDir, "video_only.mp4");
  const finalPath = path.join(VIDEO_DIR, `${jobId}.mp4`);

  await execCommand(
    `ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart "${videoOnlyPath}"`,
    PROCESS_TIMEOUT_MS,
    "Video concat"
  );

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
  if (stat.size === 0) throw new Error("Final video is empty");

  console.log(`\nJob ${jobId} SUCCESS | Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  JOBS[jobId] = {
    ...JOBS[jobId],
    status: "done",
    file: finalPath,
    fileSize: stat.size,
    progress: 100,
    completedAt: new Date().toISOString(),
  };

  await cleanupWorkDir(jobId);

  return finalPath;
}

// Enhanced FFmpeg steps (same reliability + noticeable quality improvement)
async function repairMp4(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -err_detect ignore_err -fflags +genpts+discardcorrupt -i "${input}" -map 0:v? -map 0:a? -c copy -movflags +faststart "${output}"`;
  try {
    await execCommand(cmd, 120000, "Repair MP4");
  } catch {
    console.log("Repair failed → using original raw file");
    await fs.rename(input, output);
  }
}

async function normalizeVideo(input, output) {
  // QUALITY UPGRADE: veryfast preset + CRF 22 = significantly better visuals than ultrafast@23
  // Still extremely reliable (only minor CPU increase, proven safe on limited containers)
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -fflags +genpts+discardcorrupt -i "${input}" ` +
    `-map 0:v? -vsync cfr -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p" ` +
    `-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart -an "${output}"`;
  await execCommand(cmd, PROCESS_TIMEOUT_MS, "Normalize video (improved quality)");
}

async function normalizeAudio(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 256k "${output}"`; // Slight audio quality boost
  await execCommand(cmd, 180000, "Normalize audio");
}

// Status & Download
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
  if (job.status !== "done") return res.status(400).json({ error: "Video not ready", progress: job.progress || 0 });

  if (!fsSync.existsSync(job.file)) {
    delete JOBS[jobId];
    return res.status(410).json({ error: "Video expired or deleted" });
  }

  res.download(job.file, `compilation_${jobId}.mp4`);
});

// Error handling
app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Graceful shutdown (fixed order)
const server = app.listen(PORT, () => {
  console.log(`\nIMPROVED Video Compilation Server LIVE on port ${PORT}`);
  console.log(`Quality: libx264 veryfast CRF 22 → noticeably better than ultrafast@23`);
  console.log(`Ultra-reliable • Longer expiry (3h) • Safer concurrency • Any input format`);
});

process.on("SIGTERM", async () => {
  console.log("\nGraceful shutdown received...");
  server.close(async () => {
    console.log("Server closed");
    for (const jobId of Object.keys(JOBS)) {
      await cleanupWorkDir(jobId).catch(() => {});
    }
    process.exit(0);
  });
});

export default app;
