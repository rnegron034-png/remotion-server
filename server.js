import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions } from '@remotion/renderer';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ============================
// GLOBAL STATE (same as before)
// ============================
const jobs = new Map();
let activeRenders = 0;
const MAX_CONCURRENT = 1;

const RENDERS_DIR = path.join(__dirname, 'renders');
const SRC_DIR = path.join(__dirname, 'src');

// ============================
// UTIL
// ============================
function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ============================
// BOOTSTRAP REMOTION FILES
// ============================
async function ensureRemotionFiles() {
  await fs.mkdir(SRC_DIR, { recursive: true });

  // IMPORTANT:
  // We DO NOT overwrite your existing logic,
  // just ensure files exist (as you already do)

  const indexPath = path.join(SRC_DIR, 'index.js');
  try {
    await fs.access(indexPath);
  } catch {
    throw new Error('src/index.js missing – do not auto-generate in prod');
  }
}

// ============================
// POST /remotion-render
// ============================
app.post('/remotion-render', async (req, res) => {
  const { scenes } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes array is required' });
  }

  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy, try later' });
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

  renderVideo(jobId, scenes, outputPath)
    .catch(err => {
      console.error(`[${jobId}] FAILED`, err);
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
app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') {
    return res.status(400).json({ error: `Job is ${job.status}` });
  }
  res.download(job.outputPath);
});

// ============================
// CORE RENDER FUNCTION
// ============================
async function renderVideo(jobId, scenes, outputPath) {
  const job = jobs.get(jobId);
  let bundleLocation;

  try {
    job.status = 'bundling';
    job.stage = 'bundling';
    job.progress = 5;

    bundleLocation = await bundle({
      entryPoint: path.join(SRC_DIR, 'index.js'),
    });

    const compositions = await getCompositions(bundleLocation);
    const composition = compositions.find(c => c.id === 'VideoComposition');

    if (!composition) {
      throw new Error('VideoComposition not found');
    }

    job.status = 'rendering';
    job.stage = 'rendering scenes';
    job.progress = 10;

    const partFiles = [];

    // ============================
    // SCENE-BY-SCENE RENDER (KEY FIX)
    // ============================
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
        },

        // RAM-SAFE SETTINGS
        concurrency: 1,
        imageFormat: 'jpeg',
        jpegQuality: 85,
        scale: 1,

        chromiumOptions: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--single-process',
          ],
        },

        crf: 22,
        pixelFormat: 'yuv420p',
        x264Preset: 'veryfast',
        enforceAudioTrack: false,
        verbose: false,
      });

      job.progress = 10 + Math.round(((i + 1) / scenes.length) * 70);
    }

    // ============================
    // FFmpeg CONCAT (ZERO RE-ENCODE)
    // ============================
    job.stage = 'concatenating';
    job.progress = 85;

    const listFile = outputPath.replace('.mp4', '.txt');
    const listContent = partFiles.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(listFile, listContent);

    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`
    );

    job.status = 'done';
    job.stage = 'complete';
    job.progress = 100;

    // ============================
    // CLEANUP
    // ============================
    for (const p of partFiles) {
      await fs.rm(p, { force: true }).catch(() => {});
    }
    await fs.rm(listFile, { force: true }).catch(() => {});
    if (bundleLocation) {
      await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    }

    try {
      await execAsync('pkill -f chromium || true');
    } catch {}

  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.error = err.message;
    throw err;
  }
}

// ============================
// START SERVER
// ============================
async function start() {
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  await ensureRemotionFiles();

  app.listen(PORT, () => {
    console.log(`✓ Server running on ${PORT}`);
    console.log(`✓ Shorts mode: 9:16`);
    console.log(`✓ Scene-isolated rendering enabled`);
  });
}

start();
