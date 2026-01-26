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

// Configuration
const PORT = process.env.PORT || 8080;
const VIDEO_DIR = path.join(__dirname, "videos");
const MAX_CLIPS = 50;
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120000;
const RENDER_TIMEOUT = 600000;
const JOB_RETENTION = 3600000;

app.use(cors());
app.use(express.json({ limit: "100mb" }));

const JOBS = {};

if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

/* ================= UTILITIES ================= */

/**
 * Execute command using child_process.exec (simpler, more reliable)
 */
async function execCommand(command, timeout = 300000) {
  console.log(`Executing: ${command}`);
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      shell: '/bin/bash'
    });
    
    return { stdout, stderr };
  } catch (error) {
    console.error(`Command failed:`, error.message);
    if (error.stderr) {
      console.error(`STDERR:`, error.stderr.slice(-500));
    }
    throw error;
  }
}

async function downloadFile(url, outputPath) {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL");
  }
  
  try {
    new URL(url);
  } catch {
    throw new Error("Malformed URL");
  }
  
  const command = `curl -L -A "Mozilla/5.0" --max-filesize ${MAX_FILE_SIZE} --max-time 120 --fail --silent --show-error -o "${outputPath}" "${url}"`;
  
  await execCommand(command, DOWNLOAD_TIMEOUT);
  
  const stats = await fs.stat(outputPath);
  if (stats.size === 0) {
    throw new Error("Downloaded file is empty");
  }
  
  console.log(`  Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
}

async function validateMedia(filePath) {
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  
  const { stdout } = await execCommand(command, 30000);
  const duration = parseFloat(stdout.trim());
  
  if (duration > 0) {
    console.log(`  Duration: ${duration.toFixed(2)}s`);
  }
}

async function normalizeVideo(inputPath, outputPath) {
  const command = `
    ffmpeg -hide_banner -nostdin -y
    -fflags +genpts
    -i "${inputPath}"
    -map 0:v:0
    -vsync cfr
    -r 30
    -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    -c:v libx264
    -preset veryfast
    -crf 23
    -pix_fmt yuv420p
    -profile:v high
    -level 4.0
    -movflags +faststart
    -an
    "${outputPath}"
  `;

  await execCommand(command, 300000);

  const stats = await fs.stat(outputPath);
  if (stats.size === 0) throw new Error("Normalized video is empty");
}


async function normalizeAudio(inputPath, outputPath) {
  const command = `ffmpeg -hide_banner -nostdin -loglevel error -y \
    -i "${inputPath}" \
    -vn -ac 2 -ar 48000 \
    -c:a aac -b:a 192k \
    "${outputPath}"`;
  
  await execCommand(command, 120000);
}

async function concatenateVideos(listPath, audioPath, outputPath) {
  let command = `ffmpeg -hide_banner -nostdin -loglevel error -y \
    -f concat -safe 0 -i "${listPath}"`;
  
  if (audioPath) {
    command += ` -i "${audioPath}" -shortest`;
  }
  
  command += ` -c:v libx264 -preset fast -crf 23 \
    -c:a aac -b:a 192k \
    -pix_fmt yuv420p \
    -movflags +faststart \
    "${outputPath}"`;
  
  await execCommand(command, RENDER_TIMEOUT);
}

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

function updateJobStatus(jobId, status, extra = {}) {
  JOBS[jobId] = {
    ...JOBS[jobId],
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

/* ================= ROUTES ================= */

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

app.post("/render", async (req, res) => {
  const jobId = uuidv4();
  let workDir;
  
  try {
    const { clips, audio } = req.body;
    
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips array is required" });
    }
    
    if (clips.length > MAX_CLIPS) {
      return res.status(400).json({ 
        error: `Maximum ${MAX_CLIPS} clips allowed` 
      });
    }
    
    for (const url of clips) {
      if (typeof url !== "string" || !url.startsWith("http")) {
        return res.status(400).json({ error: "Invalid clip URL" });
      }
    }
    
    if (audio && (typeof audio !== "string" || !audio.startsWith("http"))) {
      return res.status(400).json({ error: "Invalid audio URL" });
    }
    
    workDir = path.join(VIDEO_DIR, jobId);
    await fs.mkdir(workDir, { recursive: true });
    
    updateJobStatus(jobId, "downloading", { 
      totalClips: clips.length,
      hasAudio: !!audio,
      createdAt: new Date().toISOString()
    });
    
    res.json({ 
      jobId, 
      status: "processing",
      estimatedTime: clips.length * 30 + 60
    });
    
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

async function processRenderJob(jobId, workDir, clips, audio) {
  try {
    console.log(`\n🎬 Starting job ${jobId}`);
    updateJobStatus(jobId, "downloading");
    const normalizedClips = [];
    
    for (let i = 0; i < clips.length; i++) {
      console.log(`\n📥 Clip ${i + 1}/${clips.length}`);
      
      const rawPath = path.join(workDir, `raw_${i}.mp4`);
      const normalizedPath = path.join(workDir, `clip_${i}.mp4`);
      
      try {
        console.log(`  Downloading...`);
        await downloadFile(clips[i], rawPath);
        
        console.log(`  Validating...`);
        await validateMedia(rawPath);
        
        console.log(`  Normalizing...`);
        await normalizeVideo(rawPath, normalizedPath);
        
        normalizedClips.push(normalizedPath);
        await fs.unlink(rawPath);
        
        updateJobStatus(jobId, "downloading", {
          progress: Math.round(((i + 1) / clips.length) * 50)
        });
        
        console.log(`  ✅ Complete`);
      } catch (error) {
        console.error(`  ❌ Failed:`, error.message);
        throw new Error(`Clip ${i + 1}: ${error.message}`);
      }
    }
    
    let normalizedAudio = null;
    if (audio) {
      console.log(`\n🎵 Processing audio...`);
      updateJobStatus(jobId, "downloading", { progress: 60 });
      
      const rawAudioPath = path.join(workDir, "raw_audio");
      const normalizedAudioPath = path.join(workDir, "audio.m4a");
      
      await downloadFile(audio, rawAudioPath);
      await validateMedia(rawAudioPath);
      await normalizeAudio(rawAudioPath, normalizedAudioPath);
      normalizedAudio = normalizedAudioPath;
      
      await fs.unlink(rawAudioPath);
      console.log(`  ✅ Audio complete`);
    }
    
    console.log(`\n🎬 Rendering final video...`);
    updateJobStatus(jobId, "rendering", { progress: 70 });
    
    const listPath = path.join(workDir, "list.txt");
    const listContent = normalizedClips
      .map(f => `file '${f}'`)
      .join("\n");
    await fs.writeFile(listPath, listContent, "utf8");
    
    const outputPath = path.join(VIDEO_DIR, `${jobId}.mp4`);
    await concatenateVideos(listPath, normalizedAudio, outputPath);
    
    const outputStats = await fs.stat(outputPath);
    if (outputStats.size === 0) {
      throw new Error("Output video is empty");
    }
    
    console.log(`\n✅ Success! ${(outputStats.size / 1024 / 1024).toFixed(2)}MB`);
    
    updateJobStatus(jobId, "done", { 
      file: outputPath,
      fileSize: outputStats.size,
      progress: 100,
      completedAt: new Date().toISOString()
    });
    
    await cleanupJob(jobId);
    
    setTimeout(() => {
      console.log(`🗑️  Cleaning up job ${jobId}`);
      delete JOBS[jobId];
      fs.unlink(outputPath).catch(console.error);
    }, JOB_RETENTION);
    
  } catch (error) {
    console.error(`\n❌ Job ${jobId} failed:`, error.message);
    updateJobStatus(jobId, "failed", { 
      error: error.message,
      failedAt: new Date().toISOString()
    });
    await cleanupJob(jobId);
    throw error;
  }
}

app.get("/status/:id", (req, res) => {
  const jobId = req.params.id;
  
  if (!jobId || !/^[a-f0-9-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: "Invalid job ID" });
  }
  
  const job = JOBS[jobId];
  
  if (!job) {
    return res.json({ status: "unknown" });
  }
  
  const { file, ...safeJob } = job;
  res.json(safeJob);
});

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
    
    res.download(job.file, `video_${jobId}.mp4`);
    
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ error: "Download failed" });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: err.message 
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down...");
  
  server.close(async () => {
    console.log("Server closed");
    
    for (const jobId of Object.keys(JOBS)) {
      await cleanupJob(jobId).catch(console.error);
    }
    
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error("⚠️  Forced shutdown");
    process.exit(1);
  }, 30000);
});

const server = app.listen(PORT, () => {
  console.log(`✅ Video render server on port ${PORT}`);
  console.log(`📁 Video directory: ${VIDEO_DIR}`);
});

export default app;
