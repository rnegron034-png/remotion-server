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

/* ---------------- ASS/SRT CONVERSION WITH KARAOKE ---------------- */

function toAssTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const centisec = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(Math.floor(m)).padStart(2,"0")}:${String(Math.floor(s)).padStart(2,"0")}.${String(centisec).padStart(2,"0")}`;
}

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

function estimateWordTiming(sub) {
  // If word-level timing not provided, estimate it
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

function buildKaraokeText(words, highlightColor) {
  // Build karaoke effect with word-by-word color change
  // \\k effect in ASS will progressively fill words from left to right
  let text = '';
  
  words.forEach((w, i) => {
    const duration = Math.round((w.end - w.start) * 100); // centiseconds
    
    if (i === 0) {
      text += `{\\k${duration}}${w.word}`;
    } else {
      text += ` {\\k${duration}}${w.word}`;
    }
  });
  
  return text;
}

function subtitlesToAss(subs, styleConfig) {
  // ASS header
  let ass = `[Script Info]
Title: Karaoke Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${styleConfig.fontname},${styleConfig.fontsize},${styleConfig.primaryColour},${styleConfig.secondaryColour},${styleConfig.outlineColour},${styleConfig.backColour},${styleConfig.bold},0,0,0,100,100,${styleConfig.spacing},0,${styleConfig.borderStyle},${styleConfig.outline},${styleConfig.shadow},${styleConfig.alignment},10,10,${styleConfig.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Process each subtitle
  subs.forEach((sub) => {
    const words = sub.words || estimateWordTiming(sub);
    const karaokeText = buildKaraokeText(words, styleConfig.secondaryColour);
    
    ass += `Dialogue: 0,${toAssTime(sub.start)},${toAssTime(sub.end)},Default,,0,0,0,,${karaokeText}\n`;
  });

  return ass;
}

/* ---------------- SUBTITLE STYLES WITH KARAOKE ---------------- */

const SUBTITLE_STYLES = {
  // Karaoke styles with yellow highlight
  karaoke: {
    name: "Poppins 12px Karaoke (Yellow Highlight)",
    useKaraoke: true,
    config: {
      fontname: "Poppins SemiBold",
      fontsize: 12,
      primaryColour: "&H00FFFFFF",      // White (unsung)
      secondaryColour: "&H0000FFFF",    // Yellow (sung) - BGR format
      outlineColour: "&H00000000",      // Black outline
      backColour: "&H00000000",         // Transparent background
      bold: 1,
      borderStyle: 1,
      outline: 2,
      shadow: 1,
      alignment: 2,                     // Bottom center
      marginV: 40,
      spacing: -30
    }
  },

  karaokeOrange: {
    name: "Poppins 12px Karaoke (Orange Highlight)",
    useKaraoke: true,
    config: {
      fontname: "Poppins SemiBold",
      fontsize: 12,
      primaryColour: "&H00FFFFFF",      // White (unsung)
      secondaryColour: "&H0000A5FF",    // Orange (sung)
      outlineColour: "&H00000000",
      backColour: "&H00000000",
      bold: 1,
      borderStyle: 1,
      outline: 2,
      shadow: 1,
      alignment: 2,
      marginV: 40,
      spacing: -30
    }
  },

  karaokeLarge: {
    name: "Poppins 16px Karaoke (Yellow Highlight)",
    useKaraoke: true,
    config: {
      fontname: "Poppins SemiBold",
      fontsize: 16,
      primaryColour: "&H00FFFFFF",
      secondaryColour: "&H0000FFFF",
      outlineColour: "&H00000000",
      backColour: "&H00000000",
      bold: 1,
      borderStyle: 1,
      outline: 2,
      shadow: 1,
      alignment: 2,
      marginV: 50,
      spacing: -30
    }
  },

  // Original non-karaoke styles for compatibility
  default: {
    name: "Poppins 12px (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40,Spacing=-30`
  },

  medium: {
    name: "Poppins 14px (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=14,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=45,Spacing=-30`
  },

  boxed: {
    name: "Poppins 12px Boxed (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&HC0000000&,Bold=1,BorderStyle=4,Outline=1,Shadow=1,Alignment=2,MarginV=40,Spacing=-30`
  },

  bold: {
    name: "Poppins Bold 12px (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins Bold,Fontsize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40,Spacing=-30`
  },

  regular: {
    name: "Poppins Regular 12px (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins,Fontsize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=0,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40,Spacing=-30`
  },

  large: {
    name: "Poppins 16px (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=16,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=50,Spacing=-30`
  },

  highlight: {
    name: "Poppins 12px Yellow (tracking -30)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=12,PrimaryColour=&H000000&,OutlineColour=&H000000&,BackColour=&H00FFFF&,Bold=1,BorderStyle=4,Outline=1,Shadow=0,Alignment=2,MarginV=40,Spacing=-30`
  },

  extraTight: {
    name: "Poppins 12px (tracking -40)",
    useKaraoke: false,
    style: `Fontname=Poppins SemiBold,Fontsize=12,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=40,Spacing=-40`
  }
};

// DEFAULT: Karaoke with yellow highlight
const DEFAULT_STYLE = 'karaoke';

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
    name: value.name,
    hasKaraoke: value.useKaraoke || false
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
  const useKaraoke = styleData.useKaraoke || false;

  console.log(`Using subtitle style: ${styleData.name} (Karaoke: ${useKaraoke})`);

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // Create subtitle file (ASS for karaoke, SRT for static)
  let subtitlePath;
  if (useKaraoke) {
    subtitlePath = path.join(dir, "subs.ass");
    const assContent = subtitlesToAss(subtitles, styleData.config);
    fs.writeFileSync(subtitlePath, assContent);
  } else {
    subtitlePath = path.join(dir, "subs.srt");
    fs.writeFileSync(subtitlePath, subtitlesToSrt(subtitles));
  }

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
  const escapedSubPath = subtitlePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  
  // For ASS (karaoke), use ass filter. For SRT (static), use subtitles filter with force_style
  let subtitleFilter;
  if (useKaraoke) {
    subtitleFilter = `ass='${escapedSubPath}'`;
  } else {
    subtitleFilter = `subtitles='${escapedSubPath}':force_style='${styleData.style}'`;
  }
  
  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "${subtitleFilter}" -map 0:v -map 1:a -shortest -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k "${final}"`
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
  console.log("🎤 Karaoke word-highlighting enabled!");
  console.log("📝 Default: Poppins SemiBold, 12px");
  console.log("💛 Highlight: Yellow karaoke effect");
  console.log("📏 Letter spacing: -30 (tight tracking)");
  console.log(`🧹 Cleanup: Before each job (keep ${CLEANUP_CONFIG.keepCompletedJobs} recent)`);
});
