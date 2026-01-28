import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const jobs = new Map();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_, res) => res.send('OK'));

app.post('/remotion-render', (req, res) => {
  const { scenes, subtitles = [] } = req.body;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

  jobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: 0,
    output: null,
  });

  res.json({ jobId, statusUrl: `/status/${jobId}`, downloadUrl: `/download/${jobId}` });

  run(jobId, scenes, subtitles);
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  res.json(job);
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  res.download(job.output);
});

/* Download helper */
function download(url, dest) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => res.pipe(file).on('finish', () => file.close(resolve)));
  });
}

async function run(jobId, scenes, subtitles) {
  const job = jobs.get(jobId);
  const tmp = '/tmp';

  const bundleLoc = await bundle({ entryPoint: path.join(__dirname, 'src/index.jsx') });
  const merged = [];

  for (let i = 0; i < scenes.length; i++) {
    job.progress = i / scenes.length;

    const bunny = `${tmp}/${jobId}_video_${i}.mp4`;
    const audio = `${tmp}/${jobId}_audio_${i}.mp3`;
    const subs = `${tmp}/${jobId}_subs_${i}.mp4`;

    await download(scenes[i].src, bunny);
    await download(scenes[i].audio, audio);

    const comp = await selectComposition({
      serveUrl: bundleLoc,
      id: 'VideoComposition',
      inputProps: { subtitles },
      durationInFrames: scenes[i].durationInFrames,
    });

    await renderMedia({
      composition: comp,
      serveUrl: bundleLoc,
      codec: 'h264',
      pixelFormat: 'yuva420p',
      outputLocation: subs,
      inputProps: { subtitles },
    });

    const mergedOut = `${tmp}/${jobId}_merged_${i}.mp4`;

    await exec('ffmpeg', [
      '-y',
      '-i', bunny,
      '-i', subs,
      '-i', audio,
      '-filter_complex', 'overlay',
      '-map', '0:v',
      '-map', '2:a',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
      mergedOut,
    ]);

    merged.push(mergedOut);
  }

  const list = `${tmp}/${jobId}_list.txt`;
  fs.writeFileSync(list, merged.map(f => `file '${f}'`).join('\n'));

  const final = `${tmp}/${jobId}_final.mp4`;
  await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);

  job.status = 'completed';
  job.progress = 1;
  job.output = final;
}

app.listen(3000);
