import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.UV_THREADPOOL_SIZE = '2';
process.env.FFMPEG_LOGLEVEL = 'warning';

const execAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const jobs = new Map();

app.use(express.json({ limit: '50mb' }));

/* ───────── HEALTH ───────── */
app.get('/health', (_, res) => res.send('OK'));

/* ───────── START RENDER ───────── */
app.post('/remotion-render', (req, res) => {
  const { scenes, subtitles = [] } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes[] is required' });
  }

  for (let i = 0; i < scenes.length; i++) {
    if (!scenes[i].src || !scenes[i].durationInFrames) {
      return res.status(400).json({
        error: `scene ${i} must contain src and durationInFrames`,
      });
    }
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  jobs.set(jobId, {
    jobId,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    currentScene: 0,
    sceneCount: scenes.length,
    startTime: Date.now(),
    outputPath: null,
    renderTime: null,
    error: null,
  });

  res.status(202).json({
    jobId,
    statusUrl: `/status/${jobId}`,
    downloadUrl: `/download/${jobId}`,
  });

  runJob(jobId, scenes, subtitles).catch(err => {
    const job = jobs.get(jobId);
    job.status = 'failed';
    job.stage = 'failed';
    job.error = err.message;
  });
});

/* ───────── STATUS ───────── */
app.get('/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found', jobId });
  }

  res.json({
    jobId,
    status: job.status,
    stage: job.stage,
    progress: Math.round(job.progress * 100),
    currentScene: job.currentScene,
    sceneCount: job.sceneCount,
    renderTime: job.renderTime,
    error: job.error,
    downloadUrl:
      job.status === 'completed'
        ? `/download/${jobId}`
        : null,
  });
});

/* ───────── DOWNLOAD ───────── */
app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job || job.status !== 'completed') {
    return res.status(400).json({ error: 'Job not ready' });
  }

  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(job.outputPath, `render_${job.jobId}.mp4`);
});

/* ───────── RENDER PIPELINE ───────── */
async function runJob(jobId, scenes, subtitles) {
  const job = jobs.get(jobId);
  const start = Date.now();
  const tmp = '/tmp';
  const sceneFiles = [];

  job.status = 'bundling';
  job.stage = 'bundling';

  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, 'src/index.jsx'),
  });

  job.status = 'rendering';

  for (let i = 0; i < scenes.length; i++) {
    job.currentScene = i + 1;
    job.stage = `rendering ${i + 1}/${scenes.length}`;

    const sceneOut = path.join(tmp, `${jobId}_scene_${i}.mp4`);

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'VideoComposition',
      inputProps: { scene: scenes[i], subtitles },
      durationInFrames: scenes[i].durationInFrames,
    });

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: sceneOut,
      inputProps: { scene: scenes[i], subtitles },

      concurrency: 1,
      pixelFormat: 'yuv420p',
      x264Preset: 'ultrafast',
      crf: 26,
      audioCodec: 'aac',
      audioBitrate: '96k',

      x264Params: [
        'threads=2',
        'lookahead-threads=1',
        'rc-lookahead=10',
      ],

      chromiumOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
          '--no-zygote',
        ],
      },

      onProgress: ({ progress }) => {
        job.progress = i / scenes.length + progress / scenes.length;
      },
    });

    sceneFiles.push(sceneOut);
  }

  /* CONCAT */
  job.stage = 'concatenating';

  const concatList = path.join(tmp, `${jobId}_list.txt`);
  fs.writeFileSync(
    concatList,
    sceneFiles.map(f => `file '${f}'`).join('\n')
  );

  const finalOut = path.join(tmp, `${jobId}_final.mp4`);

  await execAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatList,
    '-c', 'copy',
    finalOut,
  ]);

  job.status = 'completed';
  job.stage = 'completed';
  job.progress = 1;
  job.outputPath = finalOut;
  job.renderTime = ((Date.now() - start) / 1000).toFixed(2) + 's';
}

/* ───────── CLEANUP ───────── */
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status === 'completed' && now - job.startTime > 60 * 60 * 1000) {
      try {
        if (job.outputPath) fs.unlinkSync(job.outputPath);
      } catch {}
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

/* ───────── START SERVER ───────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Remotion render server running on ${PORT}`)
);
