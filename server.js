import express from 'express';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { bundle } from '@remotion/bundler';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
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

const execFilePromise = promisify(execFile);
const app = express();
const jobStatuses = new Map();

app.use(express.json({ limit: '50mb' }));

/* ────────────────────────────────────────────── */
/* CORS                                          */
/* ────────────────────────────────────────────── */

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ────────────────────────────────────────────── */
/* HEALTHCHECK (RAILWAY SAFE)                     */
/* ────────────────────────────────────────────── */

app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

app.get('/', (_, res) => {
  res.json({ service: 'Remotion Renderer', status: 'ready' });
});

/* ────────────────────────────────────────────── */
/* START RENDER                                  */
/* ────────────────────────────────────────────── */

app.post('/remotion-render', (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { scenes, subtitles = [] } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes[] required' });
  }

  for (let i = 0; i < scenes.length; i++) {
    if (!scenes[i].src || !scenes[i].durationInFrames) {
      return res.status(400).json({
        error: `scene ${i} requires src + durationInFrames`,
      });
    }
  }

  jobStatuses.set(jobId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    sceneCount: scenes.length,
    currentScene: 0,
    startTime: Date.now(),
    outputPath: null,
    error: null,
  });

  res.status(202).json({
    jobId,
    statusUrl: `/status/${jobId}`,
    downloadUrl: `/download/${jobId}`,
  });

  processRenderJob(jobId, scenes, subtitles).catch(err => {
    console.error(`[${jobId}] fatal`, err);
  });
});

/* ────────────────────────────────────────────── */
/* STATUS                                       */
/* ────────────────────────────────────────────── */

app.get('/status/:jobId', (req, res) => {
  const job = jobStatuses.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: req.params.jobId,
    status: job.status,
    stage: job.stage,
    progress: Math.round((job.progress || 0) * 100),
    currentScene: job.currentScene,
    sceneCount: job.sceneCount,
    downloadUrl:
      job.status === 'completed'
        ? `/download/${req.params.jobId}`
        : null,
    error: job.error,
  });
});

/* ────────────────────────────────────────────── */
/* DOWNLOAD                                     */
/* ────────────────────────────────────────────── */

app.get('/download/:jobId', (req, res) => {
  const job = jobStatuses.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Job not completed' });
  }
  res.download(job.outputPath, `render_${req.params.jobId}.mp4`);
});

/* ────────────────────────────────────────────── */
/* RENDER PIPELINE (SCENE-BY-SCENE)               */
/* ────────────────────────────────────────────── */

async function processRenderJob(jobId, scenes, subtitles) {
  const job = jobStatuses.get(jobId);
  const tempDir = '/tmp';
  const scenePaths = [];
  let bundleLocation;

  try {
    job.status = 'bundling';
    job.stage = 'bundling';

    bundleLocation = await bundle({
      entryPoint: path.join(__dirname, 'src', 'index.jsx'),
    });

    job.status = 'rendering';

    for (let i = 0; i < scenes.length; i++) {
      job.currentScene = i + 1;
      job.stage = `rendering scene ${i + 1}/${scenes.length}`;

      const sceneOut = path.join(tempDir, `${jobId}_scene_${i}.mp4`);

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'VideoComposition',
        inputProps: { scene: scenes[i], subtitles },
      });

      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: sceneOut,
        inputProps: { scene: scenes[i], subtitles },

        concurrency: 1,
        imageFormat: 'jpeg',
        jpegQuality: 80,
        crf: 23,
        x264Preset: 'veryfast',
        pixelFormat: 'yuv420p',

        // 🔥 OOM FIX
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

        // ✅ PROGRESS FIX (THIS WAS MISSING)
        onProgress: ({ progress }) => {
          const base = i / scenes.length;
          const sceneContribution = progress / scenes.length;
          job.progress = Math.min(base + sceneContribution, 0.999);
        },
      });

      scenePaths.push(sceneOut);
    }

    /* CONCAT */
    job.stage = 'concatenating';

    const concatList = path.join(tempDir, `${jobId}_concat.txt`);
    fs.writeFileSync(
      concatList,
      scenePaths.map(p => `file '${p}'`).join('\n')
    );

    const finalOut = path.join(tempDir, `${jobId}_final.mp4`);

    await execFilePromise('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatList,
      '-c',
      'copy',
      finalOut,
    ]);

    job.status = 'completed';
    job.stage = 'completed';
    job.progress = 1;
    job.outputPath = finalOut;

    setTimeout(() => {
      scenePaths.forEach(p => fs.unlink(p, () => {}));
      fs.unlink(concatList, () => {});
    }, 30000);
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.error = err.message;
  }
}

/* ────────────────────────────────────────────── */
/* CLEANUP OLD JOBS                              */
/* ────────────────────────────────────────────── */

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobStatuses.entries()) {
    if (job.status === 'completed' && now - job.startTime > 60 * 60 * 1000) {
      try {
        if (job.outputPath) fs.unlinkSync(job.outputPath);
      } catch {}
      jobStatuses.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

/* ────────────────────────────────────────────── */
/* START SERVER                                  */
/* ────────────────────────────────────────────── */

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Remotion Render Server READY');
  console.log(`Listening on ${PORT}`);
});
