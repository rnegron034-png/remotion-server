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
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ────────────────────────────────────────────── */
/* CORS + PREFLIGHT                              */
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
  res.json({
    service: 'Remotion Renderer',
    status: 'ready',
    activeJobs: jobStatuses.size,
  });
});

/* ────────────────────────────────────────────── */
/* JOB LIST (DEBUG / INTERNAL)                   */
/* ────────────────────────────────────────────── */

app.get('/jobs', (_, res) => {
  res.json({
    total: jobStatuses.size,
    jobs: Array.from(jobStatuses.entries()).map(([jobId, v]) => ({
      jobId,
      status: v.status,
      progress: Math.round((v.progress || 0) * 100),
      stage: v.stage,
      createdAt: v.startTime,
    })),
  });
});

/* ────────────────────────────────────────────── */
/* START RENDER                                  */
/* ────────────────────────────────────────────── */

app.post('/remotion-render', async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { scenes, subtitles = [] } = req.body;

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes must be non-empty array' });
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
  });

  res.status(202).json({
    jobId,
    statusUrl: `/status/${jobId}`,
    downloadUrl: `/download/${jobId}`,
  });

  processRenderJob(jobId, scenes, subtitles).catch(err => {
    console.error(`[${jobId}] fatal error`, err);
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
    error: job.error || null,
  });
});

/* ────────────────────────────────────────────── */
/* DOWNLOAD                                     */
/* ────────────────────────────────────────────── */

app.get('/download/:jobId', (req, res) => {
  const job = jobStatuses.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'J
