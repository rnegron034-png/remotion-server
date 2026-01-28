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
    status: 'ready'
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
        error: 'scenes must be non-empty array'
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
      checkStatus: `/status/${jobId}`
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
  
  res.download(status.outputPath, `render_${jobId}.mp4`);
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
    
    console.log(`[${jobId}] Bundle created`);
    
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
      
      // ⚡ OPTIMIZED + MEMORY SAFE
      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: 'h264',
        outputLocation: sceneOutputPath,
        inputProps: { scene, subtitles },
        
        // 🔒 Let Remotion manage Chrome (it will download once and cache)
        // NO chromiumOptions.executablePath
        // NO browserExecutable
        
        chromiumOptions: {
          // Remove executablePath - let Remotion download Chrome
          headless: true, // Use default headless
          disableWebSecurity: false,
          ignoreCertificateErrors: false,
          gl: 'angle',
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
            '--mute-audio',
            '--no-first-run',
            '--max-old-space-size=512',
          ],
        },
        
        // ⚡ Speed optimizations
        concurrency: 1, // Safe for Railway
        
        // Encoding
        x264Preset: 'veryfast',
        crf: 23,
        pixelFormat: 'yuv420p',
        
        // Frame extraction
        imageFormat: 'jpeg',
        jpegQuality: 80,
        
        // Audio
        audioBitrate: '128k',
        audioCodec: 'aac',
        
        // Other
        muted: false,
        enforceAudioTrack: false,
        numberOfGifLoops: null,
        everyNthFrame: 1,
        frameRange: [0, scene.durationInFrames - 1],
        verbose: false,
        
        onProgress: ({ progress }) => {
          const sceneProgress = progressPercent + (progress * 0.8 / scenes.length);
          jobStatuses.set(jobId, { 
            ...jobStatuses.get(jobId), 
            progress: sceneProgress
          });
          
          if (progress % 0.25 < 0.01) {
            console.log(`[${jobId}] Scene ${i + 1}: ${(progress * 100).toFixed(0)}%`);
          }
        },
      });
      
      scenePaths.push(sceneOutputPath);
      console.log(`[${jobId}] Scene ${i + 1} complete`);
      
      if (!fs.existsSync(sceneOutputPath)) {
        throw new Error(`Scene ${i} output not created`);
      }
      
      const fileSize = fs.statSync(sceneOutputPath).size;
      console.log(`[${jobId}] Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    }
    
    // Concatenate
    jobStatuses.set(jobId, { 
      ...jobStatuses.get(jobId), 
      progress: 0.95, 
      status: 'concatenating'
    });
    
    const finalOutputPath = path.join(tempDir, `${jobId}_final.mp4`);
    console.log(`[${jobId}] Concatenating...`);
    
    await concatenateScenes(scenePaths, finalOutputPath);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const fileSize = fs.statSync(finalOutputPath).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
    
    jobStatuses.set(jobId, {
      ...jobStatuses.get(jobId),
      status: 'completed',
      progress: 1.0,
      outputPath: finalOutputPath,
      duration: `${duration}s`,
      fileSize: `${fileSizeMB} MB`,
      completedAt: Date.now()
    });
    
    console.log(`[${jobId}] ✅ COMPLETE in ${duration}s`);
    
    setTimeout(() => {
      scenePaths.forEach(p => {
        try { fs.unlinkSync(p); } catch (e) {}
      });
    }, 30000);
    
  } catch (error) {
    console.error(`[${jobId}] ❌ ERROR:`, error.message);
    
    jobStatuses.set(jobId, {
      ...jobStatuses.get(jobId),
      status: 'failed',
      error: error.message,
      errorDetails: error.stack,
      failedAt: Date.now()
    });
    
    scenePaths.forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });
  }
}

async function concatenateScenes(scenePaths, outputPath) {
  const concatFilePath = '/tmp/concat_list.txt';
  
  try {
    const concatContent = scenePaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatContent);
    
    await execFilePromise('ffmpeg', [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      '-y',
      outputPath,
    ], {
      maxBuffer: 50 * 1024 * 1024
    });
    
    console.log('Concat complete');
    return outputPath;
    
  } finally {
    try { fs.unlinkSync(concatFilePath); } catch (e) {}
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [jobId, status] of jobStatuses.entries()) {
    const age = now - status.startTime;
    if (status.status === 'completed' && age > 3600000) {
      if (status.outputPath) {
        try { fs.unlinkSync(status.outputPath); } catch (e) {}
      }
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
  console.log('═══════════════════════════════════════');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
