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
/* ---------------- ASS SUBTITLE GENERATION ---------------- */
function toAssTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const centisec = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(Math.floor(m)).padStart(2,"0")}:${String(Math.floor(s)).padStart(2,"0")}.${String(centisec).padStart(2,"0")}`;
}
function estimateWordTiming(sub) {
  const text = sub.text;
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const duration = sub.end - sub.start;
  const timePerWord = duration / words.length;
 
  return words.map((word, i) => ({
    word,
    start: sub.start + (i * timePerWord),
    end: sub.start + ((i + 1) * timePerWord)
  }));
}
function buildKaraokeText(words) {
  let text = '';
  words.forEach((w, i) => {
    const duration = Math.round((w.end - w.start) * 100);
    if (i === 0) {
      text += `{\\k${duration}}${w.word}`;
    } else {
      text += ` {\\k${duration}}${w.word}`;
    }
  });
  return text;
}
function subtitlesToAss(subs, fontsize = 90) {
  // VIRAL ASS SUBTITLE with proper yellow karaoke
  let ass = `[Script Info]
Title: Viral Karaoke Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Poppins Black,${fontsize},&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,1,0,0,0,100,100,-35,0,1,5,4,5,20,20,100,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  subs.forEach((sub) => {
    const words = sub.words || estimateWordTiming(sub);
    const karaokeText = buildKaraokeText(words);
    ass += `Dialogue: 0,${toAssTime(sub.start)},${toAssTime(sub.end)},Default,,0,0,0,,${karaokeText}\n`;
  });
  return ass;
}
/* ---------------- SUBTITLE STYLES ---------------- */
const SUBTITLE_STYLES = {
  viral: {
    name: "Viral Style - 90px Yellow Karaoke (CENTER)",
    fontsize: 90
  },
  viralBottom: {
    name: "Viral Style - 90px Yellow Karaoke (BOTTOM)",
    fontsize: 90
  },
  viralHuge: {
    name: "Viral Style - 120px MEGA Yellow Karaoke (CENTER)",
    fontsize: 120
  },
  karaoke: {
    name: "Poppins 40px Karaoke Center (Yellow Highlight)",
    fontsize: 40
  }
};
const DEFAULT_STYLE = 'viral';
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
  res.json({ styles, default: DEFAULT_STYLE });
});
/* ---------------- JOB PIPELINE ---------------- */
async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];
  // Get subtitle style
  const requestedStyle = payload.client_payload.subtitleStyle || DEFAULT_STYLE;
  const styleData = SUBTITLE_STYLES[requestedStyle] || SUBTITLE_STYLES[DEFAULT_STYLE];
  const fontsize = styleData.fontsize;
  console.log(`🎬 Using subtitle style: ${styleData.name} (${fontsize}px YELLOW karaoke)`);
  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);
  // Create ASS subtitle file with YELLOW karaoke
  const subtitlePath = path.join(dir, "subs.ass");
  const assContent = subtitlesToAss(subtitles, fontsize);
  fs.writeFileSync(subtitlePath, assContent);
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i + 1, progress: 10 + (i/scenes.length)*30 });
  }
  update(jobId, { status: "processing", stage: "Merging clips", progress: 40 });
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, clips.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);
  update(jobId, { stage: "✨ Adding YELLOW karaoke subtitles", progress: 70 });
  const final = path.join(dir, "final.mp4");
 
  // CRITICAL: Use ass filter for proper yellow karaoke rendering
  // Optimized: veryfast preset and crf 23 for faster encoding with good quality
  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "ass='${subtitlePath}'" -map 0:v -map 1:a -shortest -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k "${final}"`
  );
  update(jobId, {
    status: "done",
    stage: "🎉 Complete - Viral Ready!",
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
  console.log("🚀 VIRAL VIDEO SERVER READY! (OPTIMIZED VERSION)");
  console.log("🔥 WORKING FEATURES:");
  console.log(" ✅ 90-120px YELLOW karaoke subtitles");
  console.log(" ✅ Word-by-word highlighting");
  console.log(" ✅ Optimized FFmpeg presets for speed");
  console.log(" ✅ Professional viral-ready output");
  console.log(`\n📝 Default: ${SUBTITLE_STYLES[DEFAULT_STYLE].name}`);
  console.log(`🧹 Cleanup: Before each job (keep ${CLEANUP_CONFIG.keepCompletedJobs} recent)`);
});
