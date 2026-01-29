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

const WORKDIR = "/tmp/jobs";
fs.mkdirSync(WORKDIR, { recursive: true });
const jobs = new Map();

/* ================= UTILS ================= */

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) reject(stderr || stdout);
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

async function download(url, out) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  const f = fs.createWriteStream(out);
  await new Promise((res, rej) => {
    r.body.pipe(f);
    r.body.on("error", rej);
    f.on("finish", res);
  });
}

/* ================= KARAOKE ================= */

function secToAss(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}

function karaokeASS(subs) {
  let ass = `[Script Info]
PlayResX=1080
PlayResY=1920

[V4+ Styles]
Format=Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style=Default,Poppins SemiBold,36,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,1,0,0,0,100,100,-30,0,1,2,1,2,40,40,60,1

[Events]
Format=Layer,Start,End,Style,Text
`;

  for (const s of subs) {
    const words = s.text.split(" ");
    const total = s.end - s.start;
    const w = total / words.length;
    let t = s.start;

    for (let i = 0; i < words.length; i++) {
      const line = words.map((wrd, idx) =>
        idx === i ? `{\\c&H00FFFF&}${wrd}{\\c&HFFFFFF&}` : wrd
      ).join(" ");

      ass += `Dialogue:0,${secToAss(t)},${secToAss(t+w)},Default,${line}\n`;
      t += w;
    }
  }
  return ass;
}

/* ================= API ================= */

app.post("/remotion-render", async (req, res) => {
  const p = req.body;

  if (!p?.client_payload?.scenes?.length)
    return res.status(400).json({ error: "Scenes missing" });

  if (!p?.client_payload?.audio?.src)
    return res.status(400).json({ error: "Audio missing" });

  const jobId = uuidv4();
  const dir = jobPath(jobId);
  fs.mkdirSync(dir, { recursive: true });

  jobs.set(jobId, {
    jobId,
    status: "queued",
    stage: "Queued",
    progress: 0,
    totalScenes: p.client_payload.scenes.length,
    processedScenes: 0,
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    downloadUrl: null,
    outputFile: null,
    error: null
  });

  res.json({ jobId, statusUrl: `/status/${jobId}` });

  processJob(jobId, p).catch(e => {
    console.error(e);
    update(jobId, { status: "error", stage: "Failed", error: String(e) });
  });
});

app.get("/status/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Not found" });
  res.json(j);
});

app.get("/download/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== "done") return res.status(400).json({ error: "Not ready" });
  res.download(j.outputFile, `video_${j.jobId}.mp4`);
});

/* ================= PIPELINE ================= */

async function processJob(jobId, payload) {
  const start = Date.now();
  const dir = jobPath(jobId);
  const scenes = payload.client_payload.scenes;
  const audioUrl = payload.client_payload.audio.src;
  const subtitles = payload.client_payload.subtitles || [];

  update(jobId, { status: "downloading", stage: "Downloading", progress: 5 });

  const audio = path.join(dir, "audio.mp3");
  await download(audioUrl, audio);

  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(dir, `clip_${i}.mp4`);
    await download(scenes[i].src, p);
    clips.push(p);
    update(jobId, { processedScenes: i+1, progress: 10 + (i/scenes.length)*30 });
  }

  update(jobId, { status: "processing", stage: "Formatting clips", progress: 40 });

  const fixed = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(dir, `fixed_${i}.mp4`);
    await execAsync(`ffmpeg -y -i "${clips[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='1.03':d=125" -an -r 30 -preset veryfast "${out}"`);
    fixed.push(out);
  }

  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, fixed.map(f => `file '${f}'`).join("\n"));
  const merged = path.join(dir, "merged.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${list}" -c copy "${merged}"`);

  const ass = path.join(dir, "subs.ass");
  fs.writeFileSync(ass, karaokeASS(subtitles));

  update(jobId, { stage: "Subtitles & Audio", progress: 80 });

  const final = path.join(dir, "final.mp4");
  await execAsync(
    `ffmpeg -y -i "${merged}" -i "${audio}" -vf "ass=${ass}" -map 0:v -map 1:a -shortest -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${final}"`
  );

  const stats = fs.statSync(final);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

  const totalTime = Math.round((Date.now() - start) / 1000);

  update(jobId, {
    status: "done",
    stage: "Complete",
    progress: 100,
    outputFile: final,
    downloadUrl: `/download/${jobId}`,
    completedTime: new Date().toISOString(),
    renderTime: totalTime,
    fileSize: sizeMB + " MB"
  });
}

/* ================= START ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Karaoke Render Server Ready");
});
