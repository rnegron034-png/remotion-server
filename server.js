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

// ✅ SYNC ONLY - No async before listen
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    memory: process.memoryUsage()
  });
});

app.get('/', (req, res) => {
  res.json({ 
    service: 'Remotion Renderer',
    status: 'ready',
    endpoints: ['/health', '/remotion-render']
  });
});

// Main render endpoint
app.post('/remotion-render', async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // ✅ Input validation
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
      if (!scenes[i].src && !scenes[i].url) {
        return res.status(400).json({ 
          error: `Scene ${i} missing src/url property` 
        });
      }
      if (!scenes[i].durationInFrames) {
        return res.status(400).json({ 
          error: `Scene ${i} missing durationInFrames` 
        });
      }
    }
    
    // ✅ Return jobId immediately (202 Accepted)
    res.status(202).json({ 
      jobId, 
      status: 'processing',
      sceneCount: scenes.length 
    });
    
    // ✅ Process async (don't block response)
    processRenderJob(jobId, scenes, subtitles).catch(err => {
      console.error(`[${jobId}] FAILED:`, err.message);
      console.error(err.stack);
    });
    
  } catch (error) {
    console.error('Endpoint error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ✅ Async render logic (called after response sent)
async function processRenderJob(jobId, scenes, subtitles) {
  const startTime = Date.now();
  console.log(`[${jobId}] Starting render with ${scenes.length} scenes`);
  
  let bundleLocation = null;
  const scenePaths = [];
  const tempDir = '/tmp';
  
  try {
    // Step 1: Bundle Remotion (only once)
    console.log(`[${jobId}] Bundling Remotion...`);
    bundleLocation = await bundle({
      entryPoint: path.join(__dirname, 'src/index.jsx'), // or your entry
      webpackOverride: (config) => config,
    });
    console.log(`[${jobId}] Bundle created at ${bundleLocation}`);
    
    // Step 2: Render each scene separately
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneOutputPath = path.join(tempDir, `${jobId}_scene_${i}.mp4`);
      
      console.log(`[${jobId}] Rendering scene ${i}/${scenes.length}...`);
      
      // ✅ Get composition
      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: 'VideoComposition', // Must match your composition ID
        inputProps: {
          scene,
          subtitles: subtitles.filter(sub => {
            // Filter subtitles for this scene's timerange if needed
            return true; // Or implement time-based filtering
          }),
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
        
        // FFmpeg overrides
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
          if (progress % 0.1 < 0.01) { // Log every 10%
            console.log(`[${jobId}] Scene ${i} progress: ${(progress * 100).toFixed(0)}%`);
          }
        },
      });
      
      scenePaths.push(sceneOutputPath);
      console.log(`[${jobId}] Scene ${i} complete: ${sceneOutputPath}`);
    }
    
    // Step 3: Concatenate scenes
    const finalOutputPath = path.join(tempDir, `${jobId}_final.mp4`);
    console.log(`[${jobId}] Concatenating ${scenePaths.length} scenes...`);
    
    await concatenateScenes(scenePaths, finalOutputPath);
    
    // Step 4: Success
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${jobId}] ✅ COMPLETE in ${duration}s: ${finalOutputPath}`);
    
    // TODO: Upload to storage (Bunny.net, S3, etc.)
    // For now, file is at finalOutputPath
    
    // Cleanup temp files
    setTimeout(() => {
      scenePaths.forEach(p => {
        try { fs.unlinkSync(p); } catch (e) {}
      });
      // Keep final for a while, then clean
    }, 300000); // 5 min
    
  } catch (error) {
    console.error(`[${jobId}] ❌ ERROR:`, error.message);
    console.error(error.stack);
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
    
    console.log('FFmpeg concat complete');
    return outputPath;
    
  } finally {
    // Cleanup concat file
    try { fs.unlinkSync(concatFilePath); } catch (e) {}
  }
}

// ✅ Start server synchronously
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server ready on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Render: POST http://localhost:${PORT}/remotion-render`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
