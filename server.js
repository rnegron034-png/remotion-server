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
function subtitlesToSrt(subs) {
  return subs.map((s, i) => {
    return `${i+1}
${toSrtTime(s.start)} --> ${toSrtTime(s.end)}
${s.text}
`;
  }).join("");
}
/* ---------------- VIRAL SUBTITLE STYLES ---------------- */
const SUBTITLE_STYLES = {
  // New default: Large, bold, high-contrast for viral impact (inspired by Alex Hormozi / YouTube Shorts best practices)
  viral_default: {
    name: "Viral Poppins Bold 48px (White w/ Thick Black Outline + Semi-Transparent BG)",
    style: `Fontname=Poppins Bold,Fontsize=48,PrimaryColour=&H00FFFFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=4,Shadow=2,Alignment=2,MarginV=60,Spacing=-2`
  },
  // Yellow variant for classic subtitle look
  viral_yellow: {
    name: "Viral Poppins Bold 48px (Yellow w/ Thick Black Outline + Semi-Transparent BG)",
    style: `Fontname=Poppins Bold,Fontsize=48,PrimaryColour=&H0000FFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=4,Shadow=2,Alignment=2,MarginV=60,Spacing=-2`
  },
  // Montserrat (popular for Shorts)
  viral_montserrat: {
    name: "Viral Montserrat Black 52px (White w/ Outline + BG)",
    style: `Fontname=Montserrat Black,Fontsize=52,PrimaryColour=&H00FFFFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=5,Shadow=2,Alignment=2,MarginV=70,Spacing=0`
  },
  // Oswald (condensed bold)
  viral_oswald: {
    name: "Viral Oswald Bold 50px (White w/ Thick Outline)",
    style: `Fontname=Oswald Bold,Fontsize=50,PrimaryColour=&H00FFFFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=4,Shadow=2,Alignment=2,MarginV=65,Spacing=-5`
  },
  // Top-aligned for special effects
  viral_top: {
    name: "Viral Poppins Bold 48px Top-Aligned",
    style: `Fontname=Poppins Bold,Fontsize=48,PrimaryColour=&H00FFFFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=4,Shadow=2,Alignment=6,MarginV=60,Spacing=-2`
  },
  // Boxed with highlight
  viral_highlight: {
    name: "Viral Poppins 48px Highlight Box",
    style: `Fontname=Poppins Bold,Fontsize=48,PrimaryColour=&H00000000&,OutlineColour=&HFF000000&,BackColour=&H00FFFFFF&,Bold=1,BorderStyle=4,Outline=2,Shadow=0,Alignment=2,MarginV=60,Spacing=-2`
  },
  // Extra large for max attention
  viral_xlarge: {
    name: "Viral Poppins Bold 72px (Max Impact)",
    style: `Fontname=Poppins Bold,Fontsize=72,PrimaryColour=&H00FFFFFF&,OutlineColour=&HFF000000&,BackColour=&H80000000&,Bold=1,BorderStyle=3,Outline=5,Shadow=3,Alignment=2,MarginV=80,Spacing=-4`
  },
  // Tight tracking original but larger
  original_large: {
    name: "Poppins SemiBold 48px (tracking -30)",
    style: `Fontname=Poppins SemiBold,Fontsize=48,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60,Spacing=-30`
  }
};
// DEFAULT: Viral style for maximum viewer attention
const DEFAULT_STYLE = SUBTITLE_STYLES.viral_default.style;
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
app.get("/subtitle-styles", (req, res) => {
  const styles = Object.entries(SUBTITLE_STYLES).map(([key, value]) => ({
    id: key,
    name: value.name
  }));
  res.json({ styles, default: 'viral_default' });
});
/* ---------------- JOB PIPELINE ---------------- */
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];
  let subtitleStyle = DEFAULT_STYLE;
 
  if (payload.client_payload.subtitleStyle) {
    const requestedStyle = payload.client_payload.subtitleStyle;
    if (SUBTITLE_STYLES[requestedStyle]) {
      subtitleStyle = SUBTITLE_STYLES[requestedStyle].style;
      console.log(`Using subtitle style: ${SUBTITLE_STYLES[requestedStyle].name}`);
    } else {
      subtitleStyle = requestedStyle;
    }
  }
  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);
  const srtPath = path.join(dir, "subs.srt");
  fs.writeFileSync(srtPath, subtitlesToSrt(subtitles));
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i + 1, progress: 10 + (i/scenes.length)*40 });
  }
  update(jobId, { status: "processing", stage: "Processing clips", progress: 50 });
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
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);
  update(jobId, { stage: "Adding subtitles and audio", progress: 85 });
  const final = path.join(dir, "final.mp4");
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
  console.log("📝 Default Style: Viral Poppins Bold 48px with thick outline and semi-transparent BG");
  console.log("🔥 Optimized for viewer attention in YouTube Shorts");
  console.log(`🧹 Cleanup: Before each job (keep ${CLEANUP_CONFIG.keepCompletedJobs} recent)`);
});
