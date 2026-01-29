import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const jobs = new Map();
const WORKDIR = "/tmp/jobs";
fs.mkdirSync(WORKDIR, { recursive: true });

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });
}

function jobPath(id) {
  return path.join(WORKDIR, id);
}

function updateJobProgress(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates, lastUpdated: new Date().toISOString() });
  }
}

/* ============================
   POST /remotion-render
============================ */
app.post("/remotion-render", async (req, res) => {
  try {
    const payload = req.body;
    
    // Validate payload
    if (!payload?.client_payload?.scenes?.length) {
      return res.status(400).json({ error: "Scenes missing" });
    }
    if (!payload?.client_payload?.audio?.src) {
      return res.status(400).json({ error: "Audio URL missing" });
    }

    const jobId = uuidv4();
    const dir = jobPath(jobId);
    fs.mkdirSync(dir, { recursive: true });
    
    // Initialize job with detailed status
    jobs.set(jobId, {
      jobId: jobId,
      status: "queued",
      progress: 0,
      stage: "Queued",
      totalScenes: payload.client_payload.scenes.length,
      processedScenes: 0,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      estimatedTimeRemaining: null,
      downloadUrl: null,
      error: null
    });

    // Send immediate response
    res.json({
      jobId: jobId,
      status: "queued",
      message: "Job created successfully",
      statusUrl: `/status/${jobId}`,
      totalScenes: payload.client_payload.scenes.length
    });

    // Process job asynchronously
    processJob(jobId, payload).catch(e => {
      console.error("JOB FAILED", e);
      updateJobProgress(jobId, {
        status: "error",
        stage: "Failed",
        error: String(e),
        progress: 0
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

/* ============================
   GET /status/:jobId
============================ */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  
  // Calculate render time if completed
  let renderTime = null;
  if (job.status === "done" && job.startTime && job.completedTime) {
    const start = new Date(job.startTime);
    const end = new Date(job.completedTime);
    renderTime = Math.round((end - start) / 1000); // seconds
  }
  
  res.json({
    ...job,
    renderTime: renderTime,
    renderTimeFormatted: renderTime ? formatDuration(renderTime) : null
  });
});

/* ============================
   GET /download/:jobId
============================ */
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  
  if (job.status !== "done") {
    return res.status(400).json({ error: "Job not completed yet", status: job.status });
  }
  
  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: "Output file not found" });
  }
  
  const fileName = `video_${req.params.jobId}.mp4`;
  res.download(job.outputFile, fileName);
});

/* ============================
   GET /jobs (List all jobs)
============================ */
app.get("/jobs", (req, res) => {
  const allJobs = Array.from(jobs.values()).map(job => ({
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    startTime: job.startTime,
    lastUpdated: job.lastUpdated
  }));
  
  res.json({ jobs: allJobs, total: allJobs.length });
});

/* ============================
   JOB PIPELINE
============================ */
async function processJob(jobId, payload) {
  const startTime = Date.now();
  
  try {
    updateJobProgress(jobId, { 
      status: "downloading", 
      stage: "Downloading assets",
      progress: 5 
    });
    
    const dir = jobPath(jobId);
    const scenes = payload.client_payload.scenes;
    const audioUrl = payload.client_payload.audio.src;

    // Download audio
    updateJobProgress(jobId, { 
      stage: "Downloading audio",
      progress: 10 
    });
    const audioPath = path.join(dir, "audio.mp3");
    await download(audioUrl, audioPath);

    // Download all clips
    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const progress = 10 + ((i + 1) / scenes.length) * 30; // 10-40%
      updateJobProgress(jobId, { 
        stage: `Downloading scene ${i + 1}/${scenes.length}`,
        progress: Math.round(progress),
        processedScenes: i
      });
      
      const p = path.join(dir, `clip_${i}.mp4`);
      await download(scenes[i].src, p);
      clipPaths.push(p);
    }

    // Normalize clips
    updateJobProgress(jobId, { 
      status: "processing",
      stage: "Normalizing video clips",
      progress: 45 
    });
    
    const fixed = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const progress = 45 + ((i + 1) / clipPaths.length) * 20; // 45-65%
      updateJobProgress(jobId, { 
        stage: `Processing scene ${i + 1}/${clipPaths.length}`,
        progress: Math.round(progress)
      });
      
      const out = path.join(dir, `fixed_${i}.mp4`);
      await execAsync(`ffmpeg -y -i "${clipPaths[i]}" -r 30 -c:v libx264 -pix_fmt yuv420p "${out}"`);
      fixed.push(out);
    }

    // Create concat list
    updateJobProgress(jobId, { 
      stage: "Merging video clips",
      progress: 70 
    });
    const concatFile = path.join(dir, "list.txt");
    fs.writeFileSync(concatFile, fixed.map(f => `file '${f}'`).join("\n"));

    const merged = path.join(dir, "merged.mp4");
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${merged}"`);

    // Add audio
    updateJobProgress(jobId, { 
      stage: "Adding audio track",
      progress: 85 
    });
    const final = path.join(dir, "final.mp4");
    await execAsync(`ffmpeg -y -i "${merged}" -i "${audioPath}" -map 0:v -map 1:a -shortest -c:v copy -c:a aac "${final}"`);

    // Get file size
    const stats = fs.statSync(final);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    // Calculate total render time
    const totalTime = Math.round((Date.now() - startTime) / 1000);

    updateJobProgress(jobId, {
      status: "done",
      stage: "Complete",
      progress: 100,
      processedScenes: scenes.length,
      outputFile: final,
      downloadUrl: `/download/${jobId}`,
      fileSize: fileSizeMB + " MB",
      completedTime: new Date().toISOString(),
      renderTime: totalTime
    });
    
    console.log(`✅ Job ${jobId} completed in ${totalTime}s`);
    
  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error);
    updateJobProgress(jobId, {
      status: "error",
      stage: "Failed",
      error: error.message || String(error),
      progress: 0
    });
  }
}

/* ============================
   Downloader
============================ */
async function download(url, output) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  
  const fileStream = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

/* ============================
   Utility Functions
============================ */
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/* ============================
   Health Check
============================ */
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    uptime: process.uptime(),
    activeJobs: jobs.size,
    timestamp: new Date().toISOString()
  });
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Remotion server listening on port ${PORT}`);
  console.log(`📊 Status endpoint: http://localhost:${PORT}/status/:jobId`);
  console.log(`⬇️  Download endpoint: http://localhost:${PORT}/download/:jobId`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
});
