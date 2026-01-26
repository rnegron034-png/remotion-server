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

app.use(cors());
app.use(express.json({ limit: "100mb" }));

if (!fsSync.existsSync(VIDEO_DIR)) {
  fsSync.mkdirSync(VIDEO_DIR, { recursive: true });
}

const JOBS = {};

async function execCommand(cmd, timeout = 300000) {
  console.log(`Executing: ${cmd.substring(0, 100)}...`);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout,
      maxBuffer: 1024 * 1024 * 100,
      shell: "/bin/bash",
    });
    return { stdout, stderr };
  } catch (error) {
    console.error(`Command failed: ${error.message}`);
    if (error.stderr) {
      console.error(`STDERR: ${error.stderr}`);
    }
    throw error;
  }
}

async function downloadFile(url, output) {
  console.log(`  Downloading: ${url}`);
  
  const cmd = `curl -L --max-time 120 --fail --silent --show-error -A "Mozilla/5.0" -o "${output}" "${url}"`;
  await execCommand(cmd, 120000);
  
  const stat = await fs.stat(output);
  if (stat.size === 0) {
    throw new Error("Downloaded file is empty");
  }
  
  console.log(`  Downloaded: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
}

async function repairMp4(input, output) {
  console.log(`  Repairing MP4...`);
  
  const cmd = `ffmpeg -y -hide_banner -loglevel error -err_detect ignore_err -i "${input}" -map 0:v:0? -map 0:a:0? -c copy -movflags +faststart "${output}"`;
  
  try {
    await execCommand(cmd, 60000);
    console.log(`  Repaired successfully`);
  } catch (error) {
    console.log(`  Repair skipped, using original`);
    await fs.rename(input, output);
  }
}

async function normalizeVideo(input, output) {
  console.log(`  Normalizing video...`);
  
  const cmd = `ffmpeg -y -hide_banner -loglevel error -fflags +genpts -i "${input}" \
    -map 0:v:0 -vsync cfr -r 30 \
    -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
    -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p \
    -movflags +faststart -an "${output}"`;
  
  await execCommand(cmd, 300000);
  
  const stat = await fs.stat(output);
  if (stat.size === 0) {
    throw new Error("Normalized video is empty");
  }
  
  console.log(`  Normalized: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
}

async function normalizeAudio(input, output) {
  console.log(`  Normalizing audio...`);
  
  const cmd = `ffmpeg -y -hide_banner -loglevel error -i "${input}" -vn -ac 2 -ar 48000 -c:a aac -b:a 192k "${output}"`;
  
  await execCommand(cmd, 120000);
  console.log(`  Audio normalized`);
}

// FIXED: Better concat with error handling
async function concatVideos(listFile, audio, output) {
  console.log(`  Concatenating ${audio ? 'with' : 'without'} audio...`);
  
  // Verify list file exists and has content
  const listContent = await fs.readFile(listFile, 'utf8');
  console.log(`  List file content:\n${listContent}`);
  
  // Verify all files in list exist
  const lines = listContent.trim().split('\n');
  for (const line of lines) {
    const match = line.match(/file '(.+)'/);
    if (match) {
      const filePath = match[1];
      if (!fsSync.existsSync(filePath)) {
        throw new Error(`Input file not found: ${filePath}`);
      }
      const stat = await fs.stat(filePath);
      console.log(`  - ${path.basename(filePath)}: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    }
  }
  
  // Verify audio exists if provided
  if (audio) {
    if (!fsSync.existsSync(audio)) {
      throw new Error(`Audio file not found: ${audio}`);
    }
    const audioStat = await fs.stat(audio);
    console.log(`  - Audio: ${(audioStat.size / 1024 / 1024).toFixed(2)}MB`);
  }
  
  // Build command with proper escaping
  let cmd = `ffmpeg -y -hide_banner -loglevel warning -stats -f concat -safe 0 -i "${listFile}"`;
  
  if (audio) {
    cmd += ` -i "${audio}" -shortest -map 0:v:0 -map 1:a:0`;
  } else {
    cmd += ` -map 0:v:0`;
  }
  
  cmd += ` -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`;
  
  if (audio) {
    cmd += ` -c:a aac -b:a 192k`;
  }
  
  cmd += ` -movflags +faststart "${output}"`;
  
  console.log(`  Running concat command...`);
  await execCommand(cmd, 600000);
  
  // Verify output
  const outputStat = await fs.stat(output);
  if (outputStat.size === 0) {
    throw new Error("Concatenated video is empty");
  }
  
  console.log(`  ✅ Concatenation complete: ${(outputStat.size / 1024 / 1024).toFixed(2)}MB`);
}

async function cleanupJob(jobId) {
  try {
    const workDir = path.join(VIDEO_DIR, jobId);
    if (fsSync.existsSync(workDir)) {
      await fs.rm(workDir, { recursive: true, force: true });
      console.log(`  Cleaned up work directory`);
    }
  } catch (error) {
    console.error(`Cleanup failed: ${error.message}`);
  }
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  const activeJobs = Object.values(JOBS).filter(j => j.status === "processing").length;
  
  res.json({ 
    ok: true,
    totalJobs: Object.keys(JOBS).length,
    activeJobs,
    timestamp: new Date().toISOString()
  });
});

app.post("/render", async (req, res) => {
  const jobId = uuidv4();
  
  try {
    const { clips, audio } = req.body;
    
    if (!clips || !Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips array is required" });
    }
    
    if (clips.length > 50) {
      return res.status(400).json({ error: "Maximum 50 clips allowed" });
    }
    
    for (const url of clips) {
      if (!url || typeof url !== "string" || !url.startsWith("http")) {
        return res.status(400).json({ error: "Invalid clip URL" });
      }
    }
    
    if (audio && (!audio.startsWith("http"))) {
      return res.status(400).json({ error: "Invalid audio URL" });
    }
    
    const workDir = path.join(VIDEO_DIR, jobId);
    await fs.mkdir(workDir, { recursive: true });
    
    JOBS[jobId] = { 
      status: "processing",
      totalClips: clips.length,
      hasAudio: !!audio,
      createdAt: new Date().toISOString(),
      progress: 0
    };
    
    res.json({ 
      jobId,
      status: "processing",
      message: "Job started successfully"
    });
    
    processRenderJob(jobId, workDir, clips, audio).catch(error => {
      console.error(`\n❌ Job ${jobId} failed:`, error.message);
      JOBS[jobId] = {
        ...JOBS[jobId],
        status: "failed",
        error: error.message,
        failedAt: new Date().toISOString()
      };
    });
    
  } catch (error) {
    console.error(`Job initialization failed:`, error);
    
    if (JOBS[jobId]) {
      JOBS[jobId] = {
        ...JOBS[jobId],
        status: "failed",
        error: error.message,
        failedAt: new Date().toISOString()
      };
    }
    
    res.status(500).json({ 
      error: "Failed to start render job",
      details: error.message 
    });
  }
});

async function processRenderJob(jobId, workDir, clips, audio) {
  console.log(`\n🎬 Starting job ${jobId}`);
  console.log(`   Clips: ${clips.length}, Audio: ${!!audio}`);
  
  try {
    const normalizedClips = [];
    
    for (let i = 0; i < clips.length; i++) {
      console.log(`\n📥 Processing clip ${i + 1}/${clips.length}`);
      
      const rawPath = path.join(workDir, `raw_${i}.mp4`);
      const fixedPath = path.join(workDir, `fixed_${i}.mp4`);
      const normalizedPath = path.join(workDir, `clip_${i}.mp4`);
      
      try {
        await downloadFile(clips[i], rawPath);
        await repairMp4(rawPath, fixedPath);
        await fs.unlink(rawPath).catch(() => {});
        await normalizeVideo(fixedPath, normalizedPath);
        await fs.unlink(fixedPath).catch(() => {});
        
        normalizedClips.push(normalizedPath);
        JOBS[jobId].progress = Math.round(((i + 1) / clips.length) * 60);
        
        console.log(`  ✅ Clip ${i + 1} complete`);
        
      } catch (error) {
        throw new Error(`Clip ${i + 1} failed: ${error.message}`);
      }
    }
    
    let audioFile = null;
    if (audio) {
      console.log(`\n🎵 Processing audio...`);
      
      const rawAudioPath = path.join(workDir, "raw_audio");
      const normalizedAudioPath = path.join(workDir, "audio.m4a");
      
      await downloadFile(audio, rawAudioPath);
      await normalizeAudio(rawAudioPath, normalizedAudioPath);
      await fs.unlink(rawAudioPath).catch(() => {});
      
      audioFile = normalizedAudioPath;
      JOBS[jobId].progress = 70;
      
      console.log(`  ✅ Audio complete`);
    }
    
    console.log(`\n🎬 Creating final video...`);
    JOBS[jobId].progress = 80;
    
    const listContent = normalizedClips.map(f => `file '${f}'`).join("\n");
    const listPath = path.join(workDir, "list.txt");
    await fs.writeFile(listPath, listContent, "utf8");
    
    const finalPath = path.join(VIDEO_DIR, `${jobId}.mp4`);
    await concatVideos(listPath, audioFile, finalPath);
    
    const finalStats = await fs.stat(finalPath);
    if (finalStats.size === 0) {
      throw new Error("Final video is empty");
    }
    
    console.log(`\n✅ Job ${jobId} complete!`);
    console.log(`   Size: ${(finalStats.size / 1024 / 1024).toFixed(2)}MB`);
    
    JOBS[jobId] = {
      ...JOBS[jobId],
      status: "done",
      file: finalPath,
      fileSize: finalStats.size,
      progress: 100,
      completedAt: new Date().toISOString()
    };
    
    await cleanupJob(jobId);
    
    setTimeout(() => {
      console.log(`🗑️  Auto-cleaning job ${jobId}`);
      delete JOBS[jobId];
      fs.unlink(finalPath).catch(() => {});
    }, 3600000);
    
  } catch (error) {
    console.error(`\n❌ Job ${jobId} failed:`, error.message);
    
    JOBS[jobId] = {
      ...JOBS[jobId],
      status: "failed",
      error: error.message,
      failedAt: new Date().toISOString()
    };
    
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
    return res.json({ 
      status: "unknown",
      message: "Job not found or expired"
    });
  }
  
  const { file, ...safeJob } = job;
  res.json(safeJob);
});

app.get("/download/:id", (req, res) => {
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
      status: job.status,
      progress: job.progress || 0
    });
  }
  
  if (!job.file || !fsSync.existsSync(job.file)) {
    return res.status(404).json({ error: "Video file not found" });
  }
  
  res.download(job.file, `video_${jobId}.mp4`, (err) => {
    if (err) {
      console.error(`Download error:`, err);
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: err.message 
  });
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down...");
  
  server.close(async () => {
    console.log("Server closed");
    
    for (const jobId of Object.keys(JOBS)) {
      await cleanupJob(jobId).catch(() => {});
    }
    
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error("⚠️  Forced shutdown");
    process.exit(1);
  }, 30000);
});

const server = app.listen(PORT, () => {
  console.log(`✅ Video render server running on port ${PORT}`);
  console.log(`📁 Video directory: ${VIDEO_DIR}`);
});

export default app;
