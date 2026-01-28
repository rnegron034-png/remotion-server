import express from 'express';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { bundle } from '@remotion/bundler';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFilePromise = promisify(execFile);
const app = express();

const jobStatuses = new Map();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    activeJobs: jobStatuses.size
  });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'Remotion Renderer',
    version: '1.0.0',
    status: 'ready',
    endpoints: {
      health: 'GET /health',
      render: 'POST /remotion-render',
      status: 'GET /status/:jobId',
      download: 'GET /download/:jobId',
      jobs: 'GET /jobs'
    }
  });
});

app.get('/jobs', (req, res) => {
  const jobs = Array.from(jobStatuses.entries()).map(([jobId, status]) => ({
    jobId,
    ...status
  }));
  res.json({ jobs, total: jobs.length });
});

app.post('/remotion-render', async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { scenes, subtitles = [] } = req.body;
    
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ 
        error: 'scenes must be non-empty array',
        example: { scenes: [{ src: 'https://...', durationInFrames: 300 }] }
      });
    }
    
    if (scenes.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 scenes allowed' });
    }
    
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!scene.src && !scene.url) {
        return res.status(400).json({ error: `Scene ${i} missing src/url` });
      }
      if (!scene.durationInFrames) {
        return res.status(400).json({ error: `Scene ${i} missing durationInFrames` });
      }
    }
    
    res.status(202).json({ 
      jobId, 
      status: 'accepted',
      sceneCount: scenes.length,
      checkStatus: `/status/${jobId}`,
      download: `/download/${jobId}`
    });
    
    processRenderJob(jobId, scenes, subtitles).catch(err => {
      console.error(`[${jobId}] FAILED:`, err.message);
    });
    
  } catch (error) {
    console.error('Endpoint error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = jobStatuses.get(jobId);
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found', jobId });
  }
  
  res.json({ jobId, ...status });
});

app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = jobStatuses.get(jobId);
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (status.status !== 'completed') {
    return res.status(400).json({ 
      error: 'Job not completed', 
      currentStatus: status.status 
    });
  }
  
  if (!status.outputPath || !fs.existsSync(status.outputPath)) {
    return res.status(404).json({ error: 'Output file not found' });
  }
  
  res.download(status.outputPath, `render_${jobId}.mp4`, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

async function processRenderJob(jobId, scenes, subtitles) {
  const startTime = Date.now();
  
  jobStatuses.set(jobId, {
    status: 'processing',
    progress: 0,
    sceneCount: scenes.length,
    currentScene: 0,
    startTime,
    error: null,
    outputPath: null,
  });
  
  console.log(`[${jobId}] Starting render with ${scenes.length} scenes`);
  
  let bundleLocation = null;
  const scenePaths = [];
  const tempDir = '/tmp';
  
  try {
    jobStatuses.set(jobId, { ...jobStatuses.get(jobId), progress: 0.05, status: 'bundling' });
    
    console.log(`[${jobId}] Bundling Remotion...`);
    
    const entryPoint = path.join(__dirname, 'src', 'index.jsx');
    
    if (!fs.existsSync(entryPoint)) {
      throw new Error(`Entry point not found: ${entryPoint}`);
    }
    
    bundleLocation = await bundle({
      entryPoint: entryPoint,
      webpackOverride: (config) => config,
    });
    
    console.log(`[${jobId}] Bundle created: ${bundleLocation}`);
    
    jobStatuses.set(jobId, { ...jobStatuses.get(jobId), progress: 0.1, status: 'rendering' });
    
    // Render each scene
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneOutputPath = path.join(tempDir, `${jobId}_scene_${i}.mp4`);
      
      const progressPercent = 0.1 + ((i / scenes.length) * 0.8);
      
      jobStatuses.set(jobId, { 
        ...jobStatuses.get(jobId), 
        progress: progressPercent,
        currentScene: i + 1,
        message: `Rendering scene ${i + 1}/${scenes.length}`
      });
      
      console.log(`[${jobId}] Rendering scene ${i + 1}/${scenes.length}...`);
      
      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'VideoComposition',
        inputProps: { scene, subtitles },
      });
      
      // ✅ FIXED: Proper renderMedia config
      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: sceneOutputPath,
        inputProps: { scene, subtitles },
        
        // 🔒 Chromium config
        chromiumOptions: {
          executablePath: '/usr/bin/chromium',
          disableWebSecurity: false,
          ignoreCertificateErrors: false,
          gl: 'swiftshader',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--max-old-space-size=512',
          ],
        },
        
        // 🔒 CRITICAL: Proper FFmpeg settings (NO ffmpegOverride)
        concurrency: 1,
        muted: false,
        enforceAudioTrack: false,
        pixelFormat: 'yuv420p',
        codec: 'h264',
        videoBitrate: '2000k',
        audioBitrate: '128k',
        
        // ✅ REMOVED ffmpegOverride - let Remotion handle it correctly
        // The issue was our override was putting encoding options on input side
        
        onProgress: ({ progress }) => {
          const sceneProgress = progressPercent + (progress * 0.8 / scenes.length);
          jobStatuses.set(jobId, { ...jobStatuses.get(jobId), progress: sceneProgress });
        },
        
        // ✅ Add these to prevent memory issues
        numberOfGifLoops: null,
        everyNthFrame: 1,
        
        // ✅ Ensure proper frame range
        frameRange: [0, scene.durationInFrames - 1],
      });
      
      scenePaths.push(sceneOutputPath);
      console.log(`[${jobId}] Scene ${i + 1} complete: ${sceneOutputPath}`);
      
      // ✅ Verify file was created
      if (!fs.existsSync(sceneOutputPath)) {
        throw new Error(`Scene ${i} output file not created: ${sceneOutputPath}`);
      }
      
      const fileSize = fs.statSync(sceneOutputPath).size;
      console.log(`[${jobId}] Scene ${i + 1} size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    }
    
    // Concatenate
    jobStatuses.set(jobId, { 
      ...jobStatuses.get(jobId), 
      progress: 0.95, 
      status: 'concatenating',
      message: 'Merging scenes...'
    });
    
    const finalOutputPath = path.join(tempDir, `${jobId}_final.mp4`);
    console.log(`[${jobId}] Concatenating ${scenePaths.length} scenes...`);
    
    await concatenateScenes(scenePaths, finalOutputPath);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const fileSize = fs.statSync(finalOutputPath).size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    
    jobStatuses.set(jobId, {
      ...jobStatuses.get(jobId),
      status: 'completed',
      progress: 1.0,
      outputPath: finalOutputPath,
      duration: `${duration}s`,
      fileSize: `${fileSizeMB} MB`,
      completedAt: Date.now(),
      message: 'Render complete'
    });
    
    console.log(`[${jobId}] ✅ COMPLETE in ${duration}s (${fileSizeMB} MB)`);
    
    // Cleanup temp scene files after 30 seconds
    setTimeout(() => {
      console.log(`[${jobId}] Cleaning up temp scene files...`);
      scenePaths.forEach(p => {
        try { 
          fs.unlinkSync(p);
          console.log(`[${jobId}] Deleted: ${path.basename(p)}`);
        } catch (e) {
          console.error(`[${jobId}] Failed to delete ${p}:`, e.message);
        }
      });
    }, 30000);
    
  } catch (error) {
    console.error(`[${jobId}] ❌ ERROR:`, error.message);
    console.error(error.stack);
    
    jobStatuses.set(jobId, {
      ...jobStatuses.get(jobId),
      status: 'failed',
      error: error.message,
      errorDetails: error.stack,
      failedAt: Date.now()
    });
    
    // Cleanup on failure
    scenePaths.forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });
  }
}

async function concatenateScenes(scenePaths, outputPath) {
  const concatFilePath = '/tmp/concat_list.txt';
  
  try {
    // Verify all scene files exist
    for (const scenePath of scenePaths) {
      if (!fs.existsSync(scenePath)) {
        throw new Error(`Scene file missing: ${scenePath}`);
      }
    }
    
    const concatContent = scenePaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatContent);
    
    console.log('FFmpeg concat file content:', concatContent);
    
    // ✅ CRITICAL: Proper FFmpeg concat with explicit codec copy
    await execFilePromise('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c:v', 'copy',  // Copy video stream
      '-c:a', 'copy',  // Copy audio stream
      '-y',
      outputPath,
    ], {
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer for logs
    });
    
    console.log('FFmpeg concat complete');
    
    // Verify output
    if (!fs.existsSync(outputPath)) {
      throw new Error('Concat output file not created');
    }
    
    return outputPath;
    
  } catch (error) {
    console.error('FFmpeg concat error:', error);
    throw new Error(`Concatenation failed: ${error.message}`);
  } finally {
    try { 
      fs.unlinkSync(concatFilePath); 
    } catch (e) {
      console.error('Failed to cleanup concat file:', e.message);
    }
  }
}

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 3600000; // 1 hour
  
  for (const [jobId, status] of jobStatuses.entries()) {
    const age = now - status.startTime;
    
    if (status.status === 'completed' && age > maxAge) {
      console.log(`Cleaning up old job: ${jobId} (${(age/60000).toFixed(0)} min old)`);
      
      if (status.outputPath) {
        try { 
          fs.unlinkSync(status.outputPath);
          console.log(`Deleted output: ${jobId}`);
        } catch (e) {
          console.error(`Failed to delete ${jobId}:`, e.message);
        }
      }
      
      jobStatuses.delete(jobId);
    }
    
    // Delete failed jobs older than 10 minutes
    if (status.status === 'failed' && age > 600000) {
      console.log(`Removing old failed job: ${jobId}`);
      jobStatuses.delete(jobId);
    }
  }
}, 600000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════');
  console.log('✅ Remotion Render Server READY');
  console.log('═══════════════════════════════════════');
  console.log(`Port: ${PORT}`);
  console.log(`Node: ${process.version}`);
  console.log(`Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log('═══════════════════════════════════════');
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Render: POST http://localhost:${PORT}/remotion-render`);
  console.log('═══════════════════════════════════════');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  // Don't exit - log and continue
});
