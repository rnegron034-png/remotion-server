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

// Configuration for cleanup
const CLEANUP_CONFIG = {
  cleanupBeforeNewJob: true,
  deleteAfterHours: 2,
  cleanupIntervalMinutes: 30,
  keepCompletedJobs: 5
};

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err);
      else resolve(stdout);
    });
  });
}

function jobPath(id) {
  return path.join(WORKDIR, id);
}

function update(jobId, patch) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, ...patch, lastUpdated: new Date().toISOString() });
}

/* ---------------- CLEANUP FUNCTIONS ---------------- */

function deleteJobFiles(jobId) {
  try {
    const dir = jobPath(jobId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`✅ Cleaned up files for job: ${jobId}`);
      return true;
    }
  } catch (err) {
    console.error(`❌ Failed to cleanup job ${jobId}:`, err);
    return false;
  }
}

function cleanupCompletedJobs() {
  const completedJobs = [];
  jobs.forEach((job, jobId) => {
    if (job.status === 'done' || job.status === 'error') {
      completedJobs.push({ jobId, completedTime: job.completedTime || job.lastUpdated });
    }
  });

  completedJobs.sort((a, b) => 
    new Date(a.completedTime).getTime() - new Date(b.completedTime).getTime()
  );

  const toDelete = completedJobs.slice(0, Math.max(0, completedJobs.length - CLEANUP_CONFIG.keepCompletedJobs));
  
  let cleaned = 0;
  toDelete.forEach(job => {
    if (deleteJobFiles(job.jobId)) {
      jobs.delete(job.jobId);
      cleaned++;
    }
  });

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} completed jobs (keeping last ${CLEANUP_CONFIG.keepCompletedJobs})`);
  }

  return cleaned;
}

function cleanupOldJobs() {
  const now = new Date().getTime();
  const maxAge = CLEANUP_CONFIG.deleteAfterHours * 60 * 60 * 1000;
  let cleaned = 0;

  jobs.forEach((job, jobId) => {
    const jobTime = new Date(job.startTime).getTime();
    const age = now - jobTime;

    if (age > maxAge) {
      deleteJobFiles(jobId);
      jobs.delete(jobId);
      cleaned++;
    }
  });

  if (cleaned > 0) {
    console.log(`⏰ Cleaned up ${cleaned} old jobs (older than ${CLEANUP_CONFIG.deleteAfterHours}h)`);
  }

  return cleaned;
}

function cleanupBeforeNewJob() {
  console.log('🧹 Running cleanup before new job...');
  const completedCleaned = cleanupCompletedJobs();
  const oldCleaned = cleanupOldJobs();
  const total = completedCleaned + oldCleaned;
  if (total > 0) {
    console.log(`✅ Total cleanup: ${total} jobs removed`);
  }
}

setInterval(() => {
  cleanupOldJobs();
  cleanupCompletedJobs();
}, CLEANUP_CONFIG.cleanupIntervalMinutes * 60 * 1000);

/* ---------------- SRT CONVERSION ---------------- */

function toSrtTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

// IMPROVED: Smart word-per-word subtitle generation
function subtitlesToSrt(subs) {
  return subs.map((s, i) => {
    // Limit words per line for better readability (3-5 words max)
    let text = s.text;
    const words = text.split(' ');
    
    // If too many words, split into multiple lines (max 3-5 words per line)
    if (words.length > 5) {
      const lines = [];
      for (let i = 0; i < words.length; i += 4) {
        lines.push(words.slice(i, i + 4).join(' '));
      }
      text = lines.join('\\N'); // \N creates new line in SRT
    }
    
    return `${i+1}
${toSrtTime(s.start)} --> ${toSrtTime(s.end)}
${text}

`;
  }).join("");
}

/* ---------------- OPTIMIZED SUBTITLE STYLES FOR 9:16 VIDEOS ---------------- */

const SUBTITLE_STYLES = {
  // 🔥 VIRAL - TikTok/Instagram Reels Style (BEST FOR ENGAGEMENT)
  viral: {
    name: "Viral",
    style: `Fontname=Impact,Fontsize=70,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=6,Shadow=3,Alignment=2,MarginV=180`
  },

  // 🎯 MODERN - Clean Bold Style (RECOMMENDED)
  modern: {
    name: "Modern",
    style: `Fontname=Arial Black,Fontsize=65,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=5,Shadow=2,Alignment=2,MarginV=200`
  },

  // 💛 HIGHLIGHT - Yellow Background Box (ATTENTION GRABBING)
  highlight: {
    name: "Highlight",
    style: `Fontname=Arial Black,Fontsize=68,PrimaryColour=&H000000&,OutlineColour=&H000000&,BackColour=&H00FFFF&,Bold=1,BorderStyle=4,Outline=2,Shadow=0,Alignment=2,MarginV=200`
  },

  // 🌈 NEON - Colorful Glow (FOR ENERGETIC CONTENT)
  neon: {
    name: "Neon",
    style: `Fontname=Impact,Fontsize=72,PrimaryColour=&H00FFFF&,OutlineColour=&HFF00FF&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=6,Shadow=0,Alignment=2,MarginV=180`
  },

  // 📦 BOX - Black Background Box (HIGH CONTRAST)
  box: {
    name: "Box",
    style: `Fontname=Arial Black,Fontsize=66,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&HD0000000&,Bold=1,BorderStyle=4,Outline=3,Shadow=2,Alignment=2,MarginV=200`
  },

  // 🎬 CINEMATIC - Professional Style
  cinematic: {
    name: "Cinematic",
    style: `Fontname=Arial,Fontsize=60,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H96000000&,Bold=1,BorderStyle=4,Outline=2,Shadow=1,Alignment=2,MarginV=150`
  },

  // 🎮 GAMING - Bold Green (FOR GAMING CONTENT)
  gaming: {
    name: "Gaming",
    style: `Fontname=Impact,Fontsize=70,PrimaryColour=&H00FF00&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=6,Shadow=3,Alignment=2,MarginV=180`
  },

  // ⚡ MINIMAL - Simple & Clean
  minimal: {
    name: "Minimal",
    style: `Fontname=Arial,Fontsize=62,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=4,Shadow=1,Alignment=2,MarginV=160`
  }
};

// DEFAULT: Use VIRAL style (best for engagement)
const DEFAULT_STYLE = SUBTITLE_STYLES.viral.style;

/* ---------------- API ---------------- */

app.post("/remotion-render", async (req, res) => {
  const payload = req.body;

  if (!payload?.client_payload?.scenes?.length) {
    return res.status(400).json({ error: "Scenes missing" });
  }
  if (!payload?.client_payload?.audio?.src) {
    return res.status(400).json({ error: "Audio missing" });
  }

  if (CLEANUP_CONFIG.cleanupBeforeNewJob) {
    cleanupBeforeNewJob();
  }

  const jobId = uuidv4();
  const dir = jobPath(jobId);
  fs.mkdirSync(dir, { recursive: true });

  jobs.set(jobId, {
    jobId,
    status: "queued",
    stage: "Queued",
    progress: 0,
    totalScenes: payload.client_payload.scenes.length,
    processedScenes: 0,
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    downloadUrl: null,
    error: null
  });

  res.json({ jobId, status: "queued", statusUrl: `/status/${jobId}` });

  processJob(jobId, payload).catch(e => {
    console.error(e);
    update(jobId, { status: "error", stage: "Failed", error: String(e) });
  });
});

app.get("/status/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

app.get("/download/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j || j.status !== "done") {
    return res.status(400).json({ error: "Not ready" });
  }
  res.download(j.outputFile, `video_${j.jobId}.mp4`, (err) => {
    if (!err) console.log(`📥 Video downloaded: ${j.jobId}`);
  });
});

app.post("/cleanup/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const j = jobs.get(jobId);
  
  if (!j) return res.status(404).json({ error: "Job not found" });

  const deleted = deleteJobFiles(jobId);
  if (deleted) {
    jobs.delete(jobId);
    res.json({ success: true, message: "Job cleaned up" });
  } else {
    res.status(500).json({ error: "Cleanup failed" });
  }
});

app.post("/cleanup-all", (req, res) => {
  const completedCleaned = cleanupCompletedJobs();
  const oldCleaned = cleanupOldJobs();
  const total = completedCleaned + oldCleaned;
  res.json({ success: true, cleaned: total, message: `Cleaned up ${total} jobs` });
});

app.get("/stats", (req, res) => {
  const stats = {
    totalJobs: jobs.size,
    queued: 0,
    processing: 0,
    downloading: 0,
    done: 0,
    error: 0
  };

  jobs.forEach(job => {
    if (stats[job.status] !== undefined) stats[job.status]++;
  });

  res.json(stats);
});

// NEW: Get available subtitle styles
app.get("/subtitle-styles", (req, res) => {
  const styles = Object.entries(SUBTITLE_STYLES).map(([key, value]) => ({
    id: key,
    name: value.name
  }));
  res.json({ styles, default: 'viral' });
});

/* ---------------- JOB PIPELINE ---------------- */

async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];

  // Get style from payload or use default
  let subtitleStyle = DEFAULT_STYLE;
  
  if (payload.client_payload.subtitleStyle) {
    const requestedStyle = payload.client_payload.subtitleStyle;
    if (SUBTITLE_STYLES[requestedStyle]) {
      subtitleStyle = SUBTITLE_STYLES[requestedStyle].style;
      console.log(`Using subtitle style: ${SUBTITLE_STYLES[requestedStyle].name}`);
    } else {
      // Custom style string provided
      subtitleStyle = requestedStyle;
    }
  }

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  // Download audio
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // Write subtitles with smart formatting
  const srtPath = path.join(dir, "subs.srt");
  fs.writeFileSync(srtPath, subtitlesToSrt(subtitles));

  // Download clips
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i + 1, progress: 10 + (i/scenes.length)*40 });
  }

  update(jobId, { status: "processing", stage: "Processing clips", progress: 50 });

  // Normalize + crop to 9:16
  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(
      `ffmpeg -y -i "${clips[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -r 30 -an -c:v libx264 -preset fast "${out}"`
    );
    fixed.push(out);
    update(jobId, { progress: 50 + (i/clips.length)*20 });
  }

  update(jobId, { stage: "Merging clips", progress: 70 });

  // Concat
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);

  update(jobId, { stage: "Adding subtitles and audio", progress: 85 });

  // Burn subtitles + add audio
  const final = path.join(dir, "final.mp4");
  
  // Escape SRT path for FFmpeg
  const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  
  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "subtitles='${escapedSrtPath}':force_style='${subtitleStyle}'" -map 0:v -map 1:a -shortest -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k "${final}"`
  );

  update(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`,
    completedTime: new Date().toISOString()
  });
}

/* ---------------- DOWNLOAD ---------------- */

async function download(url, output) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const f = fs.createWriteStream(output);
  await new Promise((res, rej) => {
    r.body.pipe(f);
    r.body.on("error", rej);
    f.on("finish", res);
  });
}

/* ---------------- START ---------------- */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Remotion server ready!");
  console.log("📱 Optimized for viral 9:16 videos");
  console.log("🎬 Default style: VIRAL (best for engagement)");
  console.log(`🧹 Cleanup: Before each job (keep ${CLEANUP_CONFIG.keepCompletedJobs} recent)`);
});
