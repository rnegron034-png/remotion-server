import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, getCompositions } from '@remotion/renderer';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 🚫 NOTHING ASYNC ABOVE THIS LINE
app.use(express.json({ limit: '10mb' }));

// ============================
// STATE (SIMPLE, SAFE)
// ============================
let busy = false;
const jobs = new Map();

const RENDERS_DIR = path.join(__dirname, 'renders');
const SRC_DIR = path.join(__dirname, 'src');

// ============================
// BOOT (SYNC ONLY)
// ============================
await fs.mkdir(RENDERS_DIR, { recursive: true });

// ============================
// HEALTH CHECK (IMPORTANT)
// ============================
app.get('/', (_, res) => {
  res.json({ ok: true });
});

// ============================
// POST /remotion-render
// ============================
app.post('/remotion-render', async (req, res) => {
  try {
    if (busy) {
      return res.status(429).json({ error: 'Renderer busy' });
    }

    const { scenes } = req.body;
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: 'scenes required' });
    }

    busy = true;
    const jobId = `job_${Date.now()}`;
    const output = path.join(RENDERS_DIR, `${jobId}.mp4`);

    jobs.set(jobId, { status: 'starting' });

    res.json({ jobId }); // 🚨 respond EARLY

    // ============================
    // EVERYTHING BELOW CAN FAIL
    // ============================

    const bundleLocation = await bundle({
      entryPoint: path.join(SRC_DIR, 'index.js'),
    });

    const compositions = await getCompositions(bundleLocation);
    const composition = compositions.find(c => c.id === 'VideoComposition');
    if (!composition) throw new Error('Composition not found');

    const parts = [];

    for (let i = 0; i < scenes.length; i++) {
      const part = output.replace('.mp4', `_${i}.mp4`);
      parts.push(part);

      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        outputLocation: part,
        codec: 'h264',
        inputProps: { scenes: [scenes[i]] },
        concurrency: 1,
        crf: 23,
        x264Preset: 'veryfast',
        chromiumOptions: {
          args: ['--no-sandbox', '--disable-gpu'],
        },
      });
    }

    const list = parts.map(p => `file '${p}'`).join('\n');
    const listFile = output.replace('.mp4', '.txt');
    await fs.writeFile(listFile, list);

    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${output}"`
    );

    jobs.set(jobId, { status: 'done', output });
    busy = false;

  } catch (err) {
    console.error('RENDER FAILED:', err);
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
// START (NEVER FAILS)
// ============================
app.listen(PORT, () => {
  console.log('✓ Server started on port', PORT);
});
