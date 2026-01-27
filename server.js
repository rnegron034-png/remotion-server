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
const SRC_DIR = path.join(__dirname, 'src');

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================
// Create src/ files on startup
// ============================
async function ensureRemotionFiles() {
  await fs.mkdir(SRC_DIR, { recursive: true });

  const indexContent = `
import { registerRoot } from 'remotion';
import { VideoComposition } from './VideoComposition.js';

registerRoot(VideoComposition);
`.trim();

  const compositionContent = `
import React from 'react';
import { Composition } from 'remotion';
import { VideoSequence } from './VideoSequence.js';

export const VideoComposition = () => {
  return (
    <Composition
      id="VideoComposition"
      component={VideoSequence}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
`.trim();

  const sequenceContent = `
import React from 'react';
import { Series, Video, Audio } from 'remotion';

export const VideoSequence = ({ scenes = [], audio = null }) => {
  console.log('VideoSequence received scenes:', scenes);

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#fff',
        fontSize: 48
      }}>
        No scenes provided
      </div>
    );
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => {
          if (!scene || !scene.src) return null;

          return (
            <Series.Sequence key={index} durationInFrames={150}>
              <Video src={scene.src} />
            </Series.Sequence>
          );
        })}
      </Series>

      {audio && audio.src && <Audio src={audio.src} />}
    </>
  );
};
`.trim();

  await fs.writeFile(path.join(SRC_DIR, 'index.js'), indexContent);
  await fs.writeFile(path.join(SRC_DIR, 'VideoComposition.js'), compositionContent);
  await fs.writeFile(path.join(SRC_DIR, 'VideoSequence.js'), sequenceContent);

  console.log('Remotion source files created');
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
    progress: 0,
    stage: 'queued',
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
    progress: job.progress || 0,
    stage: job.stage || 'unknown',
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
// Render Function (MEMORY OPTIMIZED)
// ============================
async function renderVideo(jobId, inputProps, outputPath) {
  const job = jobs.get(jobId);
  let bundleLocation = null;

  try {
    console.log(`[${jobId}] Starting render`);
    job.status = 'bundling';
    job.stage = 'bundling';
    job.progress = 5;

    const entryPoint = path.join(SRC_DIR, 'index.js');
    await fs.access(entryPoint);

    bundleLocation = await bundle({
      entryPoint,
      webpackOverride: (config) => config,
    });

    console.log(`[${jobId}] Bundle created`);
    job.progress = 15;
    job.stage = 'loading composition';

    const compositions = await getCompositions(bundleLocation, {
      inputProps,
    });

    const composition = compositions.find(c => c.id === 'VideoComposition');
    if (!composition) {
      throw new Error('VideoComposition not found');
    }

    console.log(`[${jobId}] Starting render`);
    job.status = 'rendering';
    job.stage = 'rendering frames';
    job.progress = 20;

    // CRITICAL: Memory-optimized settings for Railway
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,
      
      // MEMORY OPTIMIZATION
      concurrency: 1, // Single thread only
      imageFormat: 'jpeg', // Use JPEG instead of PNG (less memory)
      jpegQuality: 80, // Lower quality = less memory
      scale: 1, // Don't upscale
      chromiumOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Critical for low memory
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--single-process', // Critical for Railway
          '--no-zygote',
          '--disable-web-security',
        ],
      },
      
      // Lower encoding quality to reduce memory
      crf: 23, // Higher = lower quality, less memory (default 18)
      
      verbose: false, // Reduce log output
      
      onProgress: ({ progress, renderedFrames, encodedFrames, stitchStage }) => {
        const percent = Math.round(progress * 100);
        
        // Update job progress
        job.progress = 20 + (percent * 0.75); // 20-95% range
        
        if (stitchStage) {
          job.stage = `encoding video (${stitchStage})`;
        } else if (encodedFrames > 0) {
          job.stage = `encoding frames (${encodedFrames}/${renderedFrames})`;
        } else {
          job.stage = `rendering frames (${renderedFrames})`;
        }
        
        console.log(`[${jobId}] ${job.stage} - ${percent}%`);
      },
      
      onBrowserLog: () => {}, // Disable browser logs to save memory
    });

    console.log(`[${jobId}] Render complete`);
    job.progress = 100;
    job.stage = 'complete';

    await fs.access(outputPath);
    job.status = 'done';

    // Cleanup
    if (bundleLocation) {
      await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    }

    try {
      await execAsync('pkill -f chromium || true');
    } catch (e) {}

  } catch (error) {
    console.error(`[${jobId}] Render error:`, error);
    job.status = 'failed';
    job.error = error.message;
    job.stage = 'failed';

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
  await ensureRemotionFiles();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Max concurrent renders: ${MAX_CONCURRENT}`);
  });
}

startServer();
