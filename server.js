import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions } from '@remotion/renderer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// ============================
// STATE
// ============================
let busy = false;
const jobs = new Map();

const SRC_DIR = path.join(__dirname, 'src');
const RENDERS_DIR = path.join(__dirname, 'renders');

await fs.mkdir(RENDERS_DIR, { recursive: true });

// ============================
// HEALTH
// ============================
app.get('/', (_, res) => {
  res.json({
    status: 'ok',
    busy,
    uptime: Math.round(process.uptime()),
  });
});

// ============================
// RENDER
// ============================
app.post('/remotion-render', async (req, res) => {
  if (busy) {
    return res.status(429).json({ error: 'Renderer busy' });
  }

  const { scenes } = req.body;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes required' });
  }

  if (scenes.length > 12) {
    return res.status(400).json({ error: 'Max 12 scenes' });
  }

  for (const s of scenes) {
    if (!s.src || !s.src.endsWith('.mp4')) {
      return res.status(400).json({ error: 'Invalid scene src' });
    }
  }

  const jobId = `job_${Date.now()}`;
  const output = path.join(RENDERS_DIR, `${jobId}.mp4`);

  jobs.set(jobId, { status: 'queued' });
  res.json({ jobId }); // respond immediately

  busy = true;

  try {
    const bundleLocation = await bundle({
      entryPoint: path.join(SRC_DIR, 'index.js'),
    });

    const compositions = await getCompositions(bundleLocation);
    const composition = compositions.find(c => c.id === 'VideoComposition');
    if (!composition) throw new Error('Composition missing');

    const parts = [];

    for (let i = 0; i < scenes.length; i++) {
      const part = output.replace('.mp4', `_part${i}.mp4`);
      parts.push(part);

      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        outputLocation: part,
        codec: 'h264',
        inputProps: {
          scenes: [scenes[i]],
        },
        concurrency: 1,
        crf: 22,
        x264Preset: 'veryfast',
        pixelFormat: 'yuv420p',
        chromiumOptions: {
          args: ['--no-sandbox', '--disable-gpu'],
        },
      });
    }

    const listFile = output.replace('.mp4', '.txt');
    await fs.writeFile(
      listFile,
      parts.map(p => `file '${p}'`).join('\n')
    );

    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${output}"`
    );

    jobs.set(jobId, { status: 'done', output });
  } catch (err) {
    console.error(err);
    jobs.set(jobId, { status: 'failed', error: err.message });
  } finally {
    busy = false;
  }
});

// ============================
// STATUS
// ============================
app.get('/status/:id', (req, res) => {
  res.json(jobs.get(req.params.id) || { status: 'unknown' });
});

// ============================
// DOWNLOAD
// ============================
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') {
    return res.status(404).end();
  }
  res.download(job.output);
});

// ============================
// START
// ============================
app.listen(PORT, () => {
  console.log('✓ Production renderer running on port', PORT);
});
