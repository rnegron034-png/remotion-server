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

// === CONFIG FOR RELIABILITY & BALANCED QUALITY ===
const MAX_CONCURRENT_JOBS = 2;
const MAX_JOB_DURATION_MS = 60 * 60 * 1000;      // 60 min max (extra safe)
const JOB_EXPIRY_MS = 3 * 60 * 60 * 1000;        // 3 hours
const MAX_CLIPS = 50;
const DOWNLOAD_TIMEOUT_MS = 180000;
const PROCESS_TIMEOUT_MS = 1800000;             // 30 min per FFmpeg step (increased for medium preset)

// === GLOBAL STATE ===
const JOBS = {};
let activeProcessingJobs = 0;

if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

// === UTILS ===
async function execCommand(cmd, timeout = PROCESS_TIMEOUT_MS, description = "") {
  console.log(`[${description || "FFmpeg"}] ${cmd.substring(0, 600)}${cmd.length > 600 ? "..." : ""}`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      maxBuffer: 200 * 1024 * 1024,
      shell: "/bin/bash",
      killSignal: "SIGKILL",
    });
    // Show more output on normal run for debugging
    if (stderr) console.warn(`FFmpeg stderr (${description}): ${stderr.trim()}`);
    return { stdout, stderr };
  } catch (error) {
    let errMsg = error.stderr?.trim() || error.stdout?.trim() || error.message || "Unknown FFmpeg error";
    if (error.timedOut) errMsg = `Timeout after ${timeout / 60000} min: ${errMsg}`;
    if (error.killed) errMsg = `Process killed (OOM/timeout): ${errMsg}`;
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

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "clips array is required and non-empty" });
  }
  if (clips.length > MAX_CLIPS) {
    return res.status(400).json({ error: `Maximum ${MAX_CLIPS} clips allowed` });
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

  const jobTimeout = setTimeout(async () => {
    console.error(`Job ${jobId} global timeout after ${MAX_JOB_DURATION_MS / 60000} min`);
    if (JOBS[jobId]) {
      JOBS[jobId].status = "failed";
      JOBS[jobId].error = "Global job timeout";
      JOBS[jobId].failedAt = new Date().toISOString();
    }
    await cleanupWorkDir(jobId);
  }, MAX_JOB_DURATION_MS);

  (async () => {
    activeProcessingJobs++;
    let finalPath = null;
    try {
      finalPath = await processRenderJob(jobId, workDir, clips, audio);
      clearTimeout(jobTimeout);
    } catch (err) {
      clearTimeout(jobTimeout);
      console.error(`Job ${jobId} failed: ${err.message}`);
      if (JOBS[jobId]) {
        JOBS[jobId] = {
          ...JOBS[jobId],
          status: "failed",
          error: err.message,
          failedAt: new Date().toISOString(),
        };
      }
      await cleanupWorkDir(jobId);
    } finally {
      activeProcessingJobs--;
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
  }

  console.log("\nConcatenating videos");
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

async function repairMp4(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -err_detect ignore_err -fflags +genpts+discardcorrupt -i "${input}" -map 0:v? -map 0:a? -c copy -movflags +faststart "${output}"`;
  try {
    await execCommand(cmd, 120000, "Repair MP4");
  } catch {
    console.log("Repair failed → using original");
    await fs.rename(input, output);
  }
}

async function normalizeVideo(input, output) {
  // BALANCED HIGH QUALITY: medium preset is reliable, fast enough, excellent quality
  // CRF 19 = very good visuals, smaller files than ultrafast
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -fflags +genpts+discardcorrupt -i "${input}" ` +
    `-map 0:v? -vsync cfr -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
    `-c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p -movflags +faststart -an "${output}"`;
  await execCommand(cmd, PROCESS_TIMEOUT_MS, "Normalize video");
}

async function normalizeAudio(input, output) {
  const cmd = `ffmpeg -y -hide_banner -loglevel warning -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 192k "${output}"`;
  await execCommand(cmd, 180000, "Normalize audio");
}

app.get("/status/:id", (req, res) => {
  const jobId = req.params.id;
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) return res.status(400).json({ error: "Invalid job ID" });

  const job = JOBS[jobId];
  if (!job) return res.json({ status: "unknown", message: "Job not found or expired" });

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
    return res.status(410).json({ error: "Video expired or missing" });
  }

  res.download(job.file, `compilation_${jobId}.mp4`);
});

app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

process.on("SIGTERM", async () => {
  console.log("\nGraceful shutdown...");
  server.close(async () => {
    for (const jobId of Object.keys(JOBS)) {
      await cleanupWorkDir(jobId).catch(() => {});
    }
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`\nRELIABLE HIGH-QUALITY Video Server LIVE on port ${PORT}`);
  console.log(`Quality: libx264 medium preset CRF 19 → excellent YouTube-ready quality`);
  console.log(`Increased timeouts • Better error details • Handles any input format`);
});

export default app;
