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

/* ---------------- SUBTITLE STYLE PRESETS ---------------- */

const SUBTITLE_STYLES = {
  // Modern TikTok/Instagram Reels style - RECOMMENDED
  modern: `Fontname=Montserrat ExtraBold,Fontsize=48,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H80000000&,Bold=1,Italic=0,BorderStyle=1,Outline=3,Shadow=2,Alignment=2,MarginV=80`,
  
  // Bold with yellow highlight (like many viral videos)
  viral: `Fontname=Arial Black,Fontsize=52,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,BackColour=&H80000000&,Bold=1,Italic=0,BorderStyle=3,Outline=4,Shadow=3,Alignment=2,MarginV=80`,
  
  // Clean Netflix style
  netflix: `Fontname=Netflix Sans,Fontsize=44,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H96000000&,Bold=0,Italic=0,BorderStyle=4,Outline=0,Shadow=0,Alignment=2,MarginV=60`,
  
  // Neon glow effect
  neon: `Fontname=Impact,Fontsize=50,PrimaryColour=&H00FFFF&,OutlineColour=&HFF00FF&,BackColour=&H80000000&,Bold=1,Italic=0,BorderStyle=1,Outline=4,Shadow=0,Alignment=2,MarginV=80`,
  
  // Professional with box background
  professional: `Fontname=Helvetica Neue Bold,Fontsize=46,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&HC8000000&,Bold=1,Italic=0,BorderStyle=4,Outline=2,Shadow=2,Alignment=2,MarginV=70`,
  
  // Minimalist clean
  minimal: `Fontname=Roboto Bold,Fontsize=42,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=&H00000000&,Bold=1,Italic=0,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60`,
  
  // Gaming/YouTube style
  gaming: `Fontname=Anton,Fontsize=54,PrimaryColour=&H00FF00&,OutlineColour=&H000000&,BackColour=&H80000000&,Bold=1,Italic=0,BorderStyle=1,Outline=5,Shadow=3,Alignment=2,MarginV=90`,
  
  // Elegant serif
  elegant: `Fontname=Playfair Display Bold,Fontsize=44,PrimaryColour=&HFFFFFF&,OutlineColour=&H1A1A1A&,BackColour=&HA0000000&,Bold=1,Italic=0,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=70`
};

// You can change this to any style above
const DEFAULT_STYLE = SUBTITLE_STYLES.modern;

/* ---------------- API ---------------- */

app.post("/remotion-render", async (req, res) => {
  const payload = req.body;

  if (!payload?.client_payload?.scenes?.length) {
    return res.status(400).json({ error: "Scenes missing" });
  }
  if (!payload?.client_payload?.audio?.src) {
    return res.status(400).json({ error: "Audio missing" });
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
  if (!j || j.status !== "done") return res.status(400).json({ error: "Not ready" });
  res.download(j.outputFile, `video_${j.jobId}.mp4`);
});

/* ---------------- JOB PIPELINE ---------------- */

async function processJob(jobId, payload) {
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];

  // Get custom style from payload or use default
  const subtitleStyle = payload.client_payload.subtitleStyle || DEFAULT_STYLE;

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  // Download audio
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // Write subtitles
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

  // Normalize + crop to 9:16
  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(
      `ffmpeg -y -i "${clips[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -r 30 -an -c:v libx264 "${out}"`
    );
    fixed.push(out);
  }

  // Concat
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);

  // Burn subtitles + add audio with improved styling
  const final = path.join(dir, "final.mp4");
  
  // Escape the SRT path for FFmpeg
  const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  
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
  console.log("🚀 Remotion server ready with improved subtitles!");
});
