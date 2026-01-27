const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Job tracking
const jobs = new Map();
let activeRenders = 0;
const MAX_CONCURRENT = 1; // Railway memory limit

// Helpers
const RENDERS_DIR = path.join(__dirname, 'renders');
const PROPS_DIR = path.join(__dirname, 'props');

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================
// POST /remotion-render
// ============================
app.post('/remotion-render', async (req, res) => {
  const { scenes, audio } = req.body;

  // Validate required input
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes array is required' });
  }

  // Check concurrency limit
  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server is busy, try again later' });
  }

  const jobId = generateJobId();
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);
  const propsPath = path.join(PROPS_DIR, `${jobId}.json`);

  // Initialize job state
  jobs.set(jobId, {
    status: 'queued',
    outputPath,
    propsPath,
    error: null,
    createdAt: new Date().toISOString()
  });

  // Start render in background
  activeRenders++;
  renderVideo(jobId, { scenes, audio }, propsPath, outputPath)
    .catch(err => {
      console.error(`[${jobId}] Render failed:`, err);
      jobs.get(jobId).status = 'failed';
      jobs.get(jobId).error = err.message;
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
// Render Function
// ============================
async function renderVideo(jobId, props, propsPath, outputPath) {
  const job = jobs.get(jobId);
  
  try {
    console.log(`[${jobId}] Starting render`);
    job.status = 'rendering';

    // CRITICAL: Write props to disk BEFORE render
    // Why: Remotion CLI reads props from file, not stdin
    await fs.writeFile(propsPath, JSON.stringify(props, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Build Remotion CLI command
    // Why single-line: Railway shell can't handle heredocs
    const command = [
      'npx remotion render',
      'src/index.js',
      'VideoComposition',
      outputPath,
      `--props=${propsPath}`,
      '--codec=h264',
      '--concurrency=1',
      '--log=verbose'
    ].join(' ');

    console.log(`[${jobId}] Executing: ${command}`);

    // Execute render
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for logs
      cwd: __dirname
    });

    console.log(`[${jobId}] Render complete`);
    if (stdout) console.log(`[${jobId}] stdout:`, stdout);
    if (stderr) console.log(`[${jobId}] stderr:`, stderr);

    // Verify output exists
    await fs.access(outputPath);
    
    job.status = 'done';

    // Cleanup props file
    await fs.unlink(propsPath).catch(() => {});

  } catch (error) {
    console.error(`[${jobId}] Render error:`, error);
    job.status = 'failed';
    job.error = error.message;
    throw error;
  }
}

// ============================
// Server Start
// ============================
async function startServer() {
  // Ensure directories exist
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  await fs.mkdir(PROPS_DIR, { recursive: true });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Max concurrent renders: ${MAX_CONCURRENT}`);
  });
}

startServer();
