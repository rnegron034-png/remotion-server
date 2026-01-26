import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { spawn } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuration
const PORT = process.env.PORT || 8080;
const VIDEO_DIR = path.join(__dirname, "videos");
const MAX_CLIPS = 50;
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const DOWNLOAD_TIMEOUT = 120000; // 2 minutes
const RENDER_TIMEOUT = 600000; // 10 minutes
const JOB_RETENTION = 3600000; // 1 hour

// Middleware
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// Job storage with automatic cleanup
const JOBS = {};

// Ensure video directory exists
if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

/* ================= UTILITIES ================= */

/**
 * Execute command with proper error handling and timeout
 */
function execCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 300000; // 5 min default
    
    console.log(`Executing: ${command} ${args.join(" ")}`);
    
    const child = spawn(command, args, {
      shell: false,
      ...options
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timeout after ${timeout}ms`));
    }, timeout);
    
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Process error: ${error.message}`));
    });
    
    child.on("close", (code) => {
      clearTimeout(timer);
      
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        console.error(`Command failed with code ${code}:`, stderr);
        reject(new Error(`Command failed: ${stderr || "Unknown error"}`));
      }
    });
  });
}

/**
 * Download file with validation and error handling
 */
async function downloadFile(url, outputPath) {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL");
  }
  
  // Validate URL format
  try {
    new URL(url);
  } catch {
    throw new Error("Malformed URL");
  }
  
  await execCommand("curl", [
    "-L",
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "--max-filesize", String(MAX_FILE_SIZE),
    "--max-time", "120",
    "-o", outputPath,
    url
  ], { timeout: DOWNLOAD_TIMEOUT });
  
  // Verify file was downloaded
  const stats = await fs.stat(outputPath);
  if (stats.size === 0) {
    throw new Error("Downloaded file is empty");
  }
  
  if (stats.size > MAX_FILE_SIZE) {
    await fs.unlink(outputPath);
    throw new Error("File exceeds maximum size");
  }
}

/**
 * Validate media file with ffprobe
 */
async function validateMedia(filePath) {
  try {
    await execCommand("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ], { timeout: 30000 });
  } catch (error) {
    throw new Error(`Invalid media file: ${error.message}`);
  }
}

/**
 * Normalize video to consistent format
 */
async function normalizeVideo(inputPath, outputPath) {
  await execCommand("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-an",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:-1:-1",
    "-r", "30",
    outputPath
  ], { timeout: 300000 });
}

/**
 * Normalize audio to consistent format
 */
async function normalizeAudio(inputPath, outputPath) {
  await execCommand("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath
  ], { timeout: 120000 });
}

/**
 * Concatenate videos with optional audio
 */
async function concatenateVideos(listPath, audioPath, outputPath) {
  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath
  ];
  
  if (audioPath) {
    args.push("-i", audioPath, "-shortest");
  }
  
  args.push(
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  );
  
  await execCommand("ffmpeg", args, { timeout: RENDER_TIMEOUT });
}

/**
 * Clean up job files
 */
async function cleanupJob(jobId) {
  try {
    const workDir = path.join(VIDEO_DIR, jobId);
    if (fsSync.existsSync(workDir)) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`Cleanup error for job ${jobId}:`, error);
  }
}

/**
 * Update job status
 */
function updateJobStatus(jobId, status, extra = {}) {
  JOBS[jobId] = {
    ...JOBS[jobId],
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

/* ================= ROUTES ================= */

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  const activeJobs = Object.values(JOBS).filter(j => 
    j.status === "downloading" || j.status === "rendering"
  ).length;
  
  res.json({ 
    ok: true, 
    totalJobs: Object.keys(JOBS).length,
    activeJobs,
    timestamp: new Date().toISOString()
  });
});

/**
 * Render video endpoint
 */
app.post("/render", async (req, res) => {
  const jobId = uuidv4();
  let workDir;
  
  try {
    const { clips, audio } = req.body;
    
    // Validation
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips array is required" });
    }
    
    if (clips.length > MAX_CLIPS) {
      return res.status(400).json({ 
        error: `Maximum ${MAX_CLIPS} clips allowed` 
      });
    }
    
    // Validate all URLs
    for (const url of clips) {
      if (typeof url !== "string" || !url.startsWith("http")) {
        return res.status(400).json({ error: "Invalid clip URL" });
      }
    }
    
    if (audio && (typeof audio !== "string" || !audio.startsWith("http"))) {
      return res.status(400).json({ error: "Invalid audio URL" });
    }
    
    // Create work directory
    workDir = path.join(VIDEO_DIR, jobId);
    await fs.mkdir(workDir, { recursive: true });
    
    // Initialize job
    updateJobStatus(jobId, "downloading", { 
      totalClips: clips.length,
      hasAudio: !!audio,
      createdAt: new Date().toISOString()
    });
    
    // Send immediate response
    res.json({ 
      jobId, 
      status: "processing",
      estimatedTime: clips.length * 30 + 60 // rough estimate in seconds
    });
    
    // Process asynchronously
    processRenderJob(jobId, workDir, clips, audio).catch(error => {
      console.error(`Job ${jobId} failed:`, error);
      updateJobStatus(jobId, "failed", { 
        error: error.message,
        failedAt: new Date().toISOString()
      });
    });
    
  } catch (error) {
    console.error(`Job ${jobId} initialization failed:`, error);
    
    if (workDir) {
      await cleanupJob(jobId).catch(console.error);
    }
    
    res.status(500).json({ 
      error: "Failed to start render job",
      details: error.message 
    });
  }
});

/**
 * Process render job asynchronously
 */
async function processRenderJob(jobId, workDir, clips, audio) {
  try {
    // Download and normalize video clips
    updateJobStatus(jobId, "downloading");
    const normalizedClips = [];
    
    for (let i = 0; i < clips.length; i++) {
      const rawPath = path.join(workDir, `raw_${i}.mp4`);
      const normalizedPath = path.join(workDir, `clip_${i}.mp4`);
      
      try {
        await downloadFile(clips[i], rawPath);
        await validateMedia(rawPath);
        await normalizeVideo(rawPath, normalizedPath);
        normalizedClips.push(normalizedPath);
        
        // Delete raw file to save space
        await fs.unlink(rawPath);
        
        updateJobStatus(jobId, "downloading", {
          progress: Math.round(((i + 1) / clips.length) * 50)
        });
      } catch (error) {
        throw new Error(`Clip ${i} failed: ${error.message}`);
      }
    }
    
    // Download and normalize audio if provided
    let normalizedAudio = null;
    if (audio) {
      updateJobStatus(jobId, "downloading", { progress: 60 });
      const rawAudioPath = path.join(workDir, "raw_audio");
      const normalizedAudioPath = path.join(workDir, "audio.m4a");
      
      await downloadFile(audio, rawAudioPath);
      await validateMedia(rawAudioPath);
      await normalizeAudio(rawAudioPath, normalizedAudioPath);
      normalizedAudio = normalizedAudioPath;
      
      await fs.unlink(rawAudioPath);
    }
    
    // Create concat list
    updateJobStatus(jobId, "rendering", { progress: 70 });
    const listPath = path.join(workDir, "list.txt");
    const listContent = normalizedClips
      .map(f => `file '${f}'`)
      .join("\n");
    await fs.writeFile(listPath, listContent, "utf8");
    
    // Render final video
    const outputPath = path.join(VIDEO_DIR, `${jobId}.mp4`);
    await concatenateVideos(listPath, normalizedAudio, outputPath);
    
    // Verify output exists
    const outputStats = await fs.stat(outputPath);
    if (outputStats.size === 0) {
      throw new Error("Output video is empty");
    }
    
    // Success
    updateJobStatus(jobId, "done", { 
      file: outputPath,
      fileSize: outputStats.size,
      progress: 100,
      completedAt: new Date().toISOString()
    });
    
    // Cleanup work directory
    await cleanupJob(jobId);
    
    // Schedule job deletion after retention period
    setTimeout(() => {
      delete JOBS[jobId];
      fs.unlink(outputPath).catch(console.error);
    }, JOB_RETENTION);
    
  } catch (error) {
    console.error(`Processing job ${jobId} failed:`, error);
    updateJobStatus(jobId, "failed", { 
      error: error.message,
      failedAt: new Date().toISOString()
    });
    await cleanupJob(jobId);
    throw error;
  }
}

/**
 * Get job status
 */
app.get("/status/:id", (req, res) => {
  const jobId = req.params.id;
  
  if (!jobId || !/^[a-f0-9-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "Invalid job ID" });
  }
  
  const job = JOBS[jobId];
  
  if (!job) {
    return res.json({ status: "unknown" });
  }
  
  // Don't expose internal file paths
  const { file, ...safeJob } = job;
  res.json(safeJob);
});

/**
 * Download rendered video
 */
app.get("/download/:id", async (req, res) => {
  try {
    const jobId = req.params.id;
    
    if (!jobId || !/^[a-f0-9-]{36}$/i.test(jobId)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }
    
    const job = JOBS[jobId];
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    
    if (job.status !== "done") {
      return res.status(400).json({ 
        error: "Video not ready",
        status: job.status 
      });
    }
    
    if (!job.file || !fsSync.existsSync(job.file)) {
      return res.status(404).json({ error: "Video file not found" });
    }
    
    res.download(job.file, `video_${jobId}.mp4`, (err) => {
      if (err) {
        console.error(`Download error for job ${jobId}:`, err);
      }
    });
    
  } catch (error) {
    console.error("Download endpoint error:", error);
    res.status(500).json({ error: "Download failed" });
  }
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: err.message 
  });
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * Graceful shutdown
 */
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  
  // Stop accepting new requests
  server.close(async () => {
    console.log("Server closed");
    
    // Cleanup all jobs
    for (const jobId of Object.keys(JOBS)) {
      await cleanupJob(jobId).catch(console.error);
    }
    
    process.exit(0);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error("Forced shutdown");
    process.exit(1);
  }, 30000);
});

/**
 * Start server
 */
const server = app.listen(PORT, () => {
  console.log(`✅ Video render server running on port ${PORT}`);
  console.log(`📁 Video directory: ${VIDEO_DIR}`);
  console.log(`⏱️  Job retention: ${JOB_RETENTION / 1000}s`);
});

export default app;
