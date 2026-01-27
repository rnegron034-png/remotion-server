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

const jobs = new Map();
let activeRenders = 0;
const MAX_CONCURRENT = 1;

const RENDERS_DIR = path.join(__dirname, 'renders');

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================
// POST /remotion-render
// ============================
app.post('/remotion-render', async (req, res) => {
  const { scenes, audio } = req.body;

  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes array is required' });
  }

  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server is busy, try again later' });
  }

  const jobId = generateJobId();
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);

  jobs.set(jobId, {
    status: 'queued',
    outputPath,
    error: null,
    createdAt: new Date().toISOString()
  });

  activeRenders++;
  renderVideo(jobId, { scenes, audio }, outputPath)
    .catch(err => {
      console.error(`[${jobId}] Render failed:`, err);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
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
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId: req.params.jobId,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt
  });
});

// ============================
// GET /download/:jobId
// ============================
app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'done') {
    return res.status(400).json({ error: `Job is ${job.status}` });
  }

  try {
    await fs.access(job.outputPath);
    res.download(job.outputPath, `${req.params.jobId}.mp4`);
  } catch (err) {
    res.status(500).json({ error: 'Video file not found' });
  }
});

// ============================
// Render Function (Programmatic API)
// ============================
async function renderVideo(jobId, inputProps, outputPath) {
  const job = jobs.get(jobId);
  let bundleLocation = null;

  try {
    console.log(`[${jobId}] Starting render with props:`, JSON.stringify(inputProps));
    job.status = 'bundling';

    // Step 1: Bundle the Remotion project
    const entryPoint = path.join(__dirname, 'src', 'index.js');
    console.log(`[${jobId}] Bundling from ${entryPoint}`);

    bundleLocation = await bundle({
      entryPoint,
      webpackOverride: (config) => config,
    });

    console.log(`[${jobId}] Bundle created at ${bundleLocation}`);
    job.status = 'rendering';

    // Step 2: Get available compositions
    const compositions = await getCompositions(bundleLocation, {
      inputProps,
    });

    console.log(`[${jobId}] Available compositions:`, compositions.map(c => c.id));

    const composition = compositions.find(c => c.id === 'VideoComposition');
    if (!composition) {
      throw new Error('VideoComposition not found');
    }

    console.log(`[${jobId}] Rendering composition:`, composition.id);

    // Step 3: Render the video
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,
      concurrency: 1,
      verbose: true,
      onProgress: ({ progress, renderedFrames, encodedFrames }) => {
        const percent = (progress * 100).toFixed(1);
        console.log(`[${jobId}] Progress: ${percent}% (${renderedFrames} frames rendered, ${encodedFrames} encoded)`);
      },
    });

    console.log(`[${jobId}] Render complete`);

    // Verify output exists
    await fs.access(outputPath);
    job.status = 'done';

    // Cleanup bundle
    if (bundleLocation) {
      await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    }

    // Kill lingering Chromium processes
    try {
      await execAsync('pkill -f chromium || true');
    } catch (e) {}

  } catch (error) {
    console.error(`[${jobId}] Render error:`, error);
    job.status = 'failed';
    job.error = error.message;

    // Cleanup bundle on error
    if (bundleLocation) {
      await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    }

    throw error;
  }
}

// ============================
// Server Start
// ============================
async function startServer() {
  await fs.mkdir(RENDERS_DIR, { recursive: true });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Max concurrent renders: ${MAX_CONCURRENT}`);
  });
}

startServer();
