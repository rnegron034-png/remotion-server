import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions } from '@remotion/renderer';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import SrtParser from 'srt-parser-2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ============================
// GLOBAL STATE (UNCHANGED)
// ============================
const jobs = new Map();
let activeRenders = 0;
const MAX_CONCURRENT = 1;

const RENDERS_DIR = path.join(__dirname, 'renders');
const SRC_DIR = path.join(__dirname, 'src');
const FPS = 30;

// ============================
// UTIL
// ============================
function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function timeToFrames(time) {
  const [h, m, rest] = time.split(':');
  const [s, ms] = rest.split(',');
  const total =
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms) / 1000;
  return Math.round(total * FPS);
}

// ============================
// GOOGLE DRIVE → RAW FILE
// ============================
function normalizeDriveUrl(url) {
  if (url.includes('uc?id=')) return url;
  const match = url.match(/\/d\/(.+?)\//);
  if (!match) throw new Error('Invalid Google Drive URL');
  return `https://drive.google.com/uc?id=${match[1]}`;
}

// ============================
// LOAD + PARSE SRT
// ============================
async function loadSrtSubtitles(srtUrl) {
  const parser = new SrtParser();
  const res = await fetch(normalizeDriveUrl(srtUrl));
  if (!res.ok) throw new Error('Failed to download SRT');

  const text = await res.text();
  const parsed = parser.fromSrt(text);

  return parsed.map(s => ({
    startFrame: timeToFrames(s.startTime),
    endFrame: timeToFrames(s.endTime),
    text: s.text.replace(/\n/g, ' '),
  }));
}

async function loadSrtSubtitles(srtUrl) {
  const parser = new SrtParser();

  const res = await fetch(normalizeDriveUrl(srtUrl)); // ← native fetch
  if (!res.ok) throw new Error('Failed to download SRT');

  const text = await res.text();
  const parsed = parser.fromSrt(text);

  return parsed.map(s => ({
    startFrame: timeToFrames(s.startTime),
    endFrame: timeToFrames(s.endTime),
    text: s.text.replace(/\n/g, ' '),
  }));
}


// ============================
// POST /remotion-render
// ============================
app.post('/remotion-render', async (req, res) => {
  const { scenes, srtUrl } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes array is required' });
  }

  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy' });
  }

  const jobId = generateJobId();
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);

  jobs.set(jobId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    outputPath,
    error: null,
    createdAt: new Date().toISOString(),
  });

  activeRenders++;

  renderVideo(jobId, scenes, srtUrl, outputPath)
    .catch(err => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = err.message;
      }
    })
    .finally(() => {
      activeRenders--;
    });

  res.json({ jobId });
});

// ============================
// GET /status/:jobId
// ============================
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ============================
// GET /download/:jobId
// ============================
app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done') {
    return res.status(400).json({ error: 'Not ready' });
  }
  res.download(job.outputPath);
});

// ============================
// CORE RENDER FUNCTION
// ============================
async function renderVideo(jobId, scenes, srtUrl, outputPath) {
  const job = jobs.get(jobId);
  let bundleLocation;

  const subtitles = srtUrl ? await loadSrtSubtitles(srtUrl) : [];

  bundleLocation = await bundle({
    entryPoint: path.join(SRC_DIR, 'index.js'),
  });

  const compositions = await getCompositions(bundleLocation);
  const composition = compositions.find(c => c.id === 'VideoComposition');
  if (!composition) throw new Error('Composition not found');

  const partFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const partPath = outputPath.replace('.mp4', `_part${i}.mp4`);
    partFiles.push(partPath);

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      outputLocation: partPath,
      codec: 'h264',
      inputProps: {
        scenes: [scenes[i]],
        subtitles,
      },
      concurrency: 1,
      imageFormat: 'jpeg',
      jpegQuality: 85,
      crf: 22,
      x264Preset: 'veryfast',
      pixelFormat: 'yuv420p',
      chromiumOptions: {
        args: ['--no-sandbox', '--disable-gpu'],
      },
    });

    job.progress = Math.round(((i + 1) / scenes.length) * 80);
  }

  const listFile = outputPath.replace('.mp4', '.txt');
  await fs.writeFile(
    listFile,
    partFiles.map(p => `file '${p}'`).join('\n')
  );

  await execAsync(
    `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`
  );

  job.status = 'done';
  job.stage = 'complete';
  job.progress = 100;

  for (const p of partFiles) await fs.rm(p, { force: true });
  await fs.rm(listFile, { force: true });
  await fs.rm(bundleLocation, { recursive: true, force: true });
}

// ============================
// START
// ============================
async function start() {
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  app.listen(PORT, () =>
    console.log(`✓ Server running on ${PORT} (SRT enabled)`)
  );
}

start();
