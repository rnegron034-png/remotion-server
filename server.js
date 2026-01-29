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
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
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

/* ---------------- ASS SUBTITLE ENGINE ---------------- */

function toAssTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}

const ASS_STYLE = `Style: Default,Poppins SemiBold,12,&HFFFFFF,&H000000,&H00000000,1,1,2,1,2,60,60,40,-30`;

function subtitlesToAss(subs) {
  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Spacing
${ASS_STYLE}

[Events]
Format: Layer, Start, End, Style, Text
`;

  subs.forEach(s => {
    ass += `Dialogue: 0,${toAssTime(s.start)},${toAssTime(s.end)},Default,${s.text.replace(/\n/g,"\\N")}\n`;
  });

  return ass;
}

/* ---------------- API ---------------- */

app.post("/remotion-render", async (req, res) => {
  const payload = req.body;

  if (!payload?.client_payload?.scenes?.length)
    return res.status(400).json({ error: "Scenes missing" });

  if (!payload?.client_payload?.audio?.src)
    return res.status(400).json({ error: "Audio missing" });

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

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  // audio
  const audioPath = path.join(dir, "audio.mp3");
  await download(audioUrl, audioPath);

  // subtitles
  const assPath = path.join(dir, "subs.ass");
  fs.writeFileSync(assPath, subtitlesToAss(subtitles));

  // clips
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i + 1, progress: 10 + (i/scenes.length)*40 });
  }

  update(jobId, { stage: "Cropping", progress: 50 });

  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(
      `ffmpeg -y -i "${clips[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -an -r 30 -c:v libx264 -preset veryfast "${out}"`
    );
    fixed.push(out);
  }

  update(jobId, { stage: "Merging", progress: 70 });

  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));

  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);

  update(jobId, { stage: "Subtitles + Audio", progress: 85 });

  const final = path.join(dir, "final.mp4");
  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audioPath}" -vf "ass='${assPath.replace(/\\/g,"\\\\").replace(/:/g,"\\:")}'" -map 0:v -map 1:a -shortest -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${final}"`
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
  console.log("🚀 Remotion server LIVE");
  console.log("🎬 Vertical 9:16");
  console.log("🔊 Audio from narration only");
  console.log("📝 Poppins SemiBold 12px, tracking -30");
});
