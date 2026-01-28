import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  bundle,
  getCompositions,
  renderMedia,
} from '@remotion/renderer';

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ────────────────────────────────────────────── */
/* GLOBAL SAFETY LIMITS (CRITICAL)                 */
/* ────────────────────────────────────────────── */

process.env.UV_THREADPOOL_SIZE = '2';
process.env.FFMPEG_LOGLEVEL = 'warning';
process.env.AV_LOG_FORCE_NOCOLOR = '1';

const PORT = process.env.PORT || 3000;
const TMP = os.tmpdir();
const JOBS = new Map();

/* ────────────────────────────────────────────── */
/* HEALTH                                         */
/* ────────────────────────────────────────────── */

app.get('/health', (_, res) => {
  res.json({ ok: true, memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
});

/* ────────────────────────────────────────────── */
/* START RENDER                                   */
/* ────────────────────────────────────────────── */

app.post('/remotion-render', async (req, res) => {
  const { scenes, subtitles } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes[] required' });
  }

  for (const s of scenes) {
    if (!s.src || !s.durationInFrames) {
      return res.status(400).json({ error: 'Each scene requires src + durationInFrames' });
    }
  }

  const jobId = `job_${Date.now()}_${uuidv4().slice(0, 8)}`;
  JOBS.set(jobId, {
    status: 'queued',
    progress: 0,
    logs: [],
    startedAt: Date.now(),
  });

  res.status(202).json({ jobId });

  runJob(jobId, scenes, subtitles).catch(err => {
    failJob(jobId, err);
  });
});

/* ────────────────────────────────────────────── */
/* JOB RUNNER                                     */
/* ────────────────────────────────────────────── */

async function runJob(jobId, scenes, subtitles) {
  const job = JOBS.get(jobId);
  const workDir = path.join(TMP, jobId);
  await fsPromises.mkdir(workDir, { recursive: true });

  try {
    job.status = 'bundling';

    const serveUrl = await bundle({
      entryPoint: path.resolve('./src/index.jsx'),
      outDir: path.join(workDir, 'bundle'),
    });

    const comps = await getCompositions(serveUrl);
    const composition = comps.find(c => c.id === 'Video');

    if (!composition) {
      throw new Error('Composition "Video" not found');
    }

    const sceneFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      job.status = `rendering_scene_${i + 1}`;
      job.progress = Math.round((i / scenes.length) * 80);

      const out = path.join(workDir, `scene_${i}.mp4`);

      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: out,
        inputProps: {
          scene: scenes[i],
          subtitles,
        },

        concurrency: 1,
        imageFormat: 'jpeg',
        jpegQuality: 80,
        crf: 23,
        x264Preset: 'veryfast',

        // 🔥 OOM FIX — DO NOT REMOVE
        x264Params: [
          'threads=2',
          'lookahead-threads=1',
          'sliced-threads=0',
          'sync-lookahead=0',
          'rc-lookahead=10',
        ],

        chromiumOptions: {
          headless: true,
          gl: 'angle',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
          ],
        },
      });

      sceneFiles.push(out);
      await watchdog(jobId);
    }

    job.status = 'concatenating';
    job.progress = 90;

    const concatList = path.join(workDir, 'concat.txt');
    await fsPromises.writeFile(
      concatList,
      sceneFiles.map(f => `file '${f}'`).join('\n')
    );

    const finalOut = path.join(workDir, 'final.mp4');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      finalOut,
    ]);

    job.status = 'completed';
    job.progress = 100;
    job.output = finalOut;
  } catch (err) {
    throw err;
  }
}

/* ────────────────────────────────────────────── */
/* WATCHDOG (STUCK JOB KILLER)                     */
/* ────────────────────────────────────────────── */

async function watchdog(jobId) {
  const job = JOBS.get(jobId);
  const elapsed = Date.now() - job.startedAt;

  if (elapsed > 15 * 60 * 1000) {
    throw new Error('Render timeout exceeded');
  }

  const memMB = process.memoryUsage().rss / 1024 / 1024;
  if (memMB > 420) {
    throw new Error('Memory safety threshold exceeded');
  }
}

/* ────────────────────────────────────────────── */
/* FAIL JOB                                       */
/* ────────────────────────────────────────────── */

function failJob(jobId, err) {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.status = 'failed';
  job.error = err.message;
}

/* ────────────────────────────────────────────── */
/* STATUS / DOWNLOAD                              */
/* ────────────────────────────────────────────── */

app.get('/status/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.get('/download/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job || job.status !== 'completed') {
    return res.status(404).json({ error: 'not ready' });
  }
  res.download(job.output);
});

/* ────────────────────────────────────────────── */
/* START SERVER                                   */
/* ────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`Render service running on :${PORT}`);
});
