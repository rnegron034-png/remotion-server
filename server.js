import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions } from '@remotion/renderer';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/* ────────────────────────────────────────────── */
/* GLOBAL SAFETY LIMITS (CRITICAL)                */
/* ────────────────────────────────────────────── */

process.env.UV_THREADPOOL_SIZE = '2';
process.env.FFMPEG_LOGLEVEL = 'warning';
process.env.AV_LOG_FORCE_NOCOLOR = '1';

/* ────────────────────────────────────────────── */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

/* ────────────────────────────────────────────── */
/* HEALTHCHECK (RAILWAY SAFE)                     */
/* ────────────────────────────────────────────── */

app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

app.get('/', (_, res) => {
  res.send('Remotion render service alive');
});

/* ────────────────────────────────────────────── */

const jobs = new Map();
let activeRenders = 0;
const MAX_CONCURRENT = 1;

const RENDERS_DIR = path.join(__dirname, 'renders');
const SRC_DIR = path.join(__dirname, 'src');

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/* ────────────────────────────────────────────── */
/* CREATE REMOTION FILES (9:16 SHORTS MODE)       */
/* ────────────────────────────────────────────── */

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
      width={1080}
      height={1920}
    />
  );
};
`.trim();

  const sequenceContent = `
import React from 'react';
import { Series, Video, Audio } from 'remotion';

export const VideoSequence = ({ scenes = [], audio = null }) => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 64
      }}>
        No scenes
      </div>
    );
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => (
          <Series.Sequence key={index} durationInFrames={scene.durationInFrames || 150}>
            <Video src={scene.src} />
          </Series.Sequence>
        ))}
      </Series>

      {audio?.src && <Audio src={audio.src} />}
    </>
  );
};
`.trim();

  await fs.writeFile(path.join(SRC_DIR, 'index.js'), indexContent);
  await fs.writeFile(path.join(SRC_DIR, 'VideoComposition.js'), compositionContent);
  await fs.writeFile(path.join(SRC_DIR, 'VideoSequence.js'), sequenceContent);

  console.log('✓ Remotion source files ready (1080x1920)');
}

/* ────────────────────────────────────────────── */
/* POST /remotion-render                          */
/* ────────────────────────────────────────────── */

app.post('/remotion-render', async (req, res) => {
  const { scenes, audio } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes[] required' });
  }

  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy' });
  }

  const jobId = generateJobId();
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);

  jobs.set(jobId, {
    status: 'queued',
    progress: 0,
    stage: 'queued',
    outputPath,
    createdAt: new Date().toISOString(),
  });

  activeRenders++;

  renderVideo(jobId, { scenes, audio }, outputPath)
    .catch(err => {
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

/* ────────────────────────────────────────────── */
/* STATUS / DOWNLOAD                              */
/* ────────────────────────────────────────────── */

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done') {
    return res.status(400).json({ error: 'Not ready' });
  }
  res.download(job.outputPath);
});

/* ────────────────────────────────────────────── */
/* RENDER FUNCTION (OOM SAFE)                     */
/* ────────────────────────────────────────────── */

async function renderVideo(jobId, inputProps, outputPath) {
  const job = jobs.get(jobId);
  let bundleLocation;

  try {
    job.status = 'bundling';
    job.progress = 5;

    bundleLocation = await bundle({
      entryPoint: path.join(SRC_DIR, 'index.js'),
    });

    const compositions = await getCompositions(bundleLocation, {
      inputProps,
    });

    const composition = compositions.find(c => c.id === 'VideoComposition');
    if (!composition) throw new Error('Composition not found');

    job.status = 'rendering';
    job.progress = 15;

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,

      concurrency: 1,
      imageFormat: 'jpeg',
      jpegQuality: 75,
      crf: 25,
      x264Preset: 'ultrafast',
      pixelFormat: 'yuv420p',

      // 🔥 OOM FIX (MANDATORY)
      x264Params: [
        'threads=2',
        'lookahead-threads=1',
        'sliced-threads=0',
        'sync-lookahead=0',
        'rc-lookahead=10',
      ],

      chromiumOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
          '--no-zygote',
        ],
      },

      onProgress: ({ progress }) => {
        job.progress = Math.round(15 + progress * 80);
      },
    });

    job.status = 'done';
    job.progress = 100;

    await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    await execAsync('pkill -f chromium || true').catch(() => {});
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    if (bundleLocation) {
      await fs.rm(bundleLocation, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

/* ────────────────────────────────────────────── */
/* START SERVER                                  */
/* ────────────────────────────────────────────── */

async function startServer() {
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  await ensureRemotionFiles();

  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log('✓ Mode: 1080x1920 vertical Shorts');
    console.log(`✓ Max concurrent renders: ${MAX_CONCURRENT}`);
  });
}

startServer();
