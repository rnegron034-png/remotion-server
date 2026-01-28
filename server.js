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

// Job status storage (in-memory)
const jobStatuses = new Map();

// ✅ SYNC ONLY - No async before listen
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS (if needed for web access)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check for Railway
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

// List all jobs (for debugging)
app.get('/jobs', (req, res) => {
  const jobs = Array.from(jobStatuses.entries()).map(([jobId, status]) => ({
    jobId,
    ...status
  }));
  res.json({ jobs, total: jobs.length });
});

// Main render endpoint
app.post('/remotion-render', async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // ✅ Input validation
    const { scenes, subtitles = [], audio = null } = req.body;
    
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ 
        error: 'scenes must be non-empty array',
        example: { 
          scenes: [{ 
            src: 'https://example.com/video.mp4', 
            durationInFrames: 300 
          }],
          subtitles: [],
          audio: null
        }
      });
    }
    
    if (scenes.length > 10) {
      return res.status(400).json({ 
        error: 'Maximum 10 scenes allowed per job' 
      });
    }
    
    // Validate each scene
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      
      if (!scene.src && !scene.url) {
        return res.status(400).json({ 
          error: `Scene ${i} missing src/url property`,
          scene: scene
        });
      }
      
      if (!scene.durationInFrames) {
        return res.status(400).json({ 
          error: `Scene ${i} missing durationInFrames`,
          hint: 'durationInFrames = seconds * 30 (for 30fps)',
          scene: scene
        });
      }
      
      if (typeof scene.durationInFrames !== 'number' || scene.durationInFrames <= 0) {
        return res.status(400).json({ 
          error: `Scene ${i} durationInFrames must be positive number`,
          received: scene.durationInFrames
        });
      }
    }
    
    // ✅ Return jobId immediately (202 Accepted)
    res.status(202).json({ 
      jobId, 
      status: 'accepted',
      message: 'Job queued for processing',
      sceneCount: scenes.length,
      checkStatus: `/status/${jobId}`,
      download: `/download/${jobId}`
    });
    
    // ✅ Process async (don't block response)
    processRenderJob(jobId, scenes, subtitles, audio).catch(err => {
      console.error(`[${jobId}] FAILED:`, err.message);
      console.error(err.stack);
    });
    
  } catch (error) {
    console.error('Endpoint error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Status check endpoint
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  const status = jobStatuses.get(jobId);
  
  if (!status) {
    return res.status(404).json({ 
      error: 'Job not found',
      jobId,
      hint: 'Job may have expired or never existed'
    });
  }
  
  res.json({
    jobId,
    ...status,
    endpoints: {
      status: `/status/${jobId}`,
      download: status.status === 'completed' ? `/download/${jobId}` : null
    }
  });
});

// Download completed video
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  const status = jobStatuses.get(jobId);
  
  if (!status) {
    return res.status(404).json({ 
      error: 'Job not found',
      jobId 
    });
  }
  
  if (status.status !== 'completed') {
    return res.status(400).json({ 
      error: 'Job not completed yet',
      currentStatus: status.status,
      progress: status.progress,
      checkStatus: `/status/${jobId}`
    });
  }
  
  if (!status.outputPath || !fs.existsSync(status.outputPath)) {
    return res.status(404).json({ 
      error: 'Output file not found or already deleted',
      hint: 'Files are automatically deleted after 1 hour'
    });
  }
  
  // Stream the file
  const filename = `render_${jobId}.mp4`;
  res.download(status.outputPath, filename, (err) => {
    if (err) {
      console.error(`[${jobId}] Download error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    }
  });
});

// ✅ Async render logic (called after response sent)
async function processRenderJob(jobId, scenes, subtitles, audio) {
  const startTime = Date.now();
  
  // Initialize status
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
    // Step 1: Bundle Remotion (only once)
    jobStatuses.set(jobId, { 
      ...jobStatuses.get(jobId), 
      progress: 0.05, 
      status: 'bundling' 
    });
    
    console.log(`[${jobId}] Bundling Remotion...`);
    bundleLocation = await bundle({
      entryPoint: path.join(__dirname, 'src/index.jsx'),
      webpackOverride: (config) => config,
    });
    console.log(`[${jobId}] Bundle created at ${bundleLocation}`);
    
    jobStatuses.set(jobId, { 
      ...jobStatuses.get(jobId), 
      progress: 0.1, 
      status: 'rendering' 
    });
    
    // Step 2: Render each scene separately
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneOutputPath = path.join(tempDir, `${jobId}_scene_${i}.mp4`);
      
      // Calculate progress (10% for bundle, 80% for rendering, 10% for concat)
      const progressPercent = 0.1 + ((i / scenes.length) * 0.8);
      
      jobStatuses.set(jobId, { 
        ...jobStatuses.get(jobId), 
        progress: progressPercent,
        currentScene: i + 1,
        status: 'rendering',
        message: `Rendering scene ${i + 1}/${scenes.length}`
      });
      
      console.log(`[${jobId}] Rendering scene ${i + 1}/${scenes.length}...`);
      
      // ✅ Get composition
      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'VideoComposition', // Must match your composition ID
        inputProps: {
          scene,
          subtitles: subtitles,
        },
      });
      
      // ✅ Render with memory constraints
      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: sceneOutputPath,
        inputProps: {
          scene,
          subtitles,
        },
        
        // 🔒 CRITICAL: Chromium config
        chromiumOptions: {
          executablePath: '/usr/bin/chromium', // Force system Chromium
          disableWebSecurity: false,
          ignoreCertificateErrors: false,
          gl: 'swiftshader', // Software rendering
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Use /tmp instead of /dev/shm
            '--disable-gpu',
            '--single-process', // Critical for low RAM
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
        
        // 🔒 CRITICAL: FFmpeg config
        concurrency: 1, // One frame at a time
        frameRange: [0, scene.durationInFrames - 1],
        
        codec: 'h264',
        videoCodec: 'libx264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        
        // Custom FFmpeg flags
        ffmpegOverride: ({ args }) => {
          return [
            '-threads', '1', // Single thread to avoid OOM
            '-preset', 'ultrafast', // Fast encoding
            '-crf', '28', // Balance quality/size
            ...args,
          ];
        },
        
        onProgress: ({ progress }) => {
          // Update sub-progress within current scene
          const sceneProgress = progressPercent + (progress * 0.8 / scenes.length);
          jobStatuses.set(jobId, {
            ...jobStatuses.get(jobId),
            progress: sceneProgress
          });
        },
      });
      
      scenePaths.push(sceneOutputPath);
      console.log(`[${jobId}] Scene ${i + 1} complete: ${sceneOutputPath}`);
    }
    
    // Step 3: Concatenate scenes
    jobStatuses.set(jobId, { 
      ...jobStatuses.get(jobId), 
      progress: 0.95, 
      status: 'concatenating',
      message: 'Merging scenes into final video'
    });
    
    const finalOutputPath = path.join(tempDir, `${jobId}_final.mp4`);
    console.log(`[${jobId}] Concatenating ${scenePaths.length} scenes...`);
    
    await concatenateScenes(scenePaths, finalOutputPath);
    
    // Step 4: Success
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
    
    console.log(`[${jobId}] ✅ COMPLETE in ${duration}s (${fileSizeMB} MB): ${finalOutputPath}`);
    
    // Cleanup temp scene files (keep final for download)
    setTimeout(() => {
      scenePaths.forEach(p => {
        try { 
          fs.unlinkSync(p); 
          console.log(`[${jobId}] Cleaned up temp file: ${p}`);
        } catch (e) {
          console.error(`[${jobId}] Failed to cleanup ${p}:`, e.message);
        }
      });
    }, 10000); // Clean after 10 seconds
    
  } catch (error) {
    console.error(`[${jobId}] ❌ ERROR:`, error.message);
    console.error(error.stack);
    
    // Update status with error
    jobStatuses.set(jobId, {
      ...jobStatuses.get(jobId),
      status: 'failed',
      error: error.message,
      errorDetails: error.stack,
      failedAt: Date.now()
    });
    
    throw error;
  }
}

// ✅ FFmpeg concat with stream copy (no re-encode)
async function concatenateScenes(scenePaths, outputPath) {
  const concatFilePath = '/tmp/concat_list.txt';
  
  try {
    // Create concat file
    const concatContent = scenePaths
      .map(p => `file '${p}'`)
      .join('\n');
    
    fs.writeFileSync(concatFilePath, concatContent);
    
    console.log('FFmpeg concat file created:', concatFilePath);
    console.log('Concat content:', concatContent);
    
    // Run FFmpeg concat
    const { stdout, stderr } = await execFilePromise('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy', // 🔒 CRITICAL: Stream copy only
      '-threads', '1',
      '-y',
      outputPath,
    ]);
    
    console.log('FFmpeg concat complete:', outputPath);
    if (stderr) console.log('FFmpeg stderr:', stderr);
    
    return outputPath;
    
  } catch (error) {
    console.error('FFmpeg concat error:', error);
    throw new Error(`Concatenation failed: ${error.message}`);
  } finally {
    // Cleanup concat file
    try { 
      fs.unlinkSync(concatFilePath); 
    } catch (e) {
      console.error('Failed to cleanup concat file:', e.message);
    }
  }
}

// ✅ Automatic cleanup of old completed jobs
setInterval(() => {
  const now = Date.now();
  const maxAge = 3600000; // 1 hour
  
  for (const [jobId, status] of jobStatuses.entries()) {
    const age = now - status.startTime;
    
    // Delete completed jobs older than 1 hour
    if (status.status === 'completed' && age > maxAge) {
      console.log(`[${jobId}] Cleaning up old job (${(age/60000).toFixed(0)} min old)`);
      
      // Delete output file
      if (status.outputPath) {
        try { 
          fs.unlinkSync(status.outputPath);
          console.log(`[${jobId}] Deleted output file`);
        } catch (e) {
          console.error(`[${jobId}] Failed to delete output:`, e.message);
        }
      }
      
      // Remove from memory
      jobStatuses.delete(jobId);
    }
    
    // Delete failed jobs older than 10 minutes
    if (status.status === 'failed' && age > 600000) {
      console.log(`[${jobId}] Removing old failed job`);
      jobStatuses.delete(jobId);
    }
  }
}, 600000); // Run every 10 minutes

// ✅ Start server synchronously
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('✅ Remotion Render Server READY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Port: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Render: POST http://localhost:${PORT}/remotion-render`);
  console.log(`Status: GET http://localhost:${PORT}/status/:jobId`);
  console.log(`Download: GET http://localhost:${PORT}/download/:jobId`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`Node: ${process.version}`);
  console.log(`Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log('═══════════════════════════════════════════════════');
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  server.close(() => {
    console.log('HTTP server closed');
    
    // Clean up all temp files
    for (const [jobId, status] of jobStatuses.entries()) {
      if (status.outputPath && fs.existsSync(status.outputPath)) {
        try {
          fs.unlinkSync(status.outputPath);
          console.log(`Cleaned up ${jobId}`);
        } catch (e) {
          console.error(`Failed to cleanup ${jobId}:`, e.message);
        }
      }
    }
    
    console.log('Cleanup complete. Exiting.');
    process.exit(0);
  });
  
  // Force exit after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - log and continue
});

export default app;
