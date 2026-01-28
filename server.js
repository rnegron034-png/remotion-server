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

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const jobs = new Map();

app.use(express.json({ limit: '20mb' }));

app.get('/health', (_, res) => res.send('OK'));

app.post('/remotion-render', (req, res) => {
  const { scenes } = req.body;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes[] required' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  jobs.set(jobId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    currentScene: 0,
    sceneCount: scenes.length,
    output: null,
    error: null,
  });

  res.status(202).json({
    jobId,
    statusUrl: `/status/${jobId}`,
    downloadUrl: `/download/${jobId}`,
  });

  runJob(jobId, scenes).catch(err => {
    const job = jobs.get(jobId);
    job.status = 'failed';
    job.stage = 'failed';
    job.error = err.message;
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });

  res.json({
    jobId: req.params.jobId,
    ...job,
    progress: Math.round(job.progress * 100),
    downloadUrl:
      job.status === 'completed'
        ? `/download/${req.params.jobId}`
        : null,
  });
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'completed') {
    return res.status(400).json({ error: 'not ready' });
  }
  res.download(job.output);
});

async function runJob(jobId, scenes) {
  const job = jobs.get(jobId);
  const tmp = '/tmp';
  const sceneFiles = [];

  job.status = 'bundling';
  job.stage = 'bundling';

  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, 'src/index.jsx'),
  });

  for (let i = 0; i < scenes.length; i++) {
    job.currentScene = i + 1;
    job.stage = `rendering ${i + 1}/${scenes.length}`;

    const out = path.join(tmp, `${jobId}_scene_${i}.mp4`);

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'VideoComposition',
      inputProps: { scene: scenes[i] },
    });

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: out,
      inputProps: { scene: scenes[i] },

      concurrency: 1,
      imageFormat: 'jpeg',
      jpegQuality: 70,
      crf: 26,
      x264Preset: 'ultrafast',
      pixelFormat: 'yuv420p',

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

      everyNthFrame: 2,

      onProgress: ({ progress }) => {
        job.progress =
          i / scenes.length + progress / scenes.length;
      },
    });

    sceneFiles.push(out);
  }

  job.stage = 'concatenating';

  const concatFile = path.join(tmp, `${jobId}_concat.txt`);
  fs.writeFileSync(
    concatFile,
    sceneFiles.map(f => `file '${f}'`).join('\n')
  );

  const finalOut = path.join(tmp, `${jobId}_final.mp4`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatFile,
    '-c',
    'copy',
    finalOut,
  ]);

  job.status = 'completed';
  job.stage = 'completed';
  job.progress = 1;
  job.output = finalOut;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Render server running on ${PORT}`)
);
