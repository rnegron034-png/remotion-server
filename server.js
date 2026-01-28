import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.UV_THREADPOOL_SIZE = '2';
process.env.FFMPEG_LOGLEVEL = 'warning';

const execAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const jobs = new Map();
app.use(express.json());

app.get('/health', (_, res) => res.send('OK'));

app.post('/remotion-render', (req, res) => {
  const { scenes, subtitles = [] } = req.body;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

  jobs.set(jobId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    currentScene: 0,
    sceneCount: scenes.length,
    output: null,
    renderTime: null,
    error: null,
  });

  res.status(202).json({ jobId, statusUrl: `/status/${jobId}`, downloadUrl: `/download/${jobId}` });
  runJob(jobId, scenes, subtitles);
});

app.get('/status/:jobId', (req,res)=>{
  const job = jobs.get(req.params.jobId);
  res.json({ ...job, progress: Math.round(job.progress*100) });
});

app.get('/download/:jobId',(req,res)=>{
  const job = jobs.get(req.params.jobId);
  if(job.status!=='completed') return res.status(400).json({error:'not ready'});
  res.download(job.output);
});

async function runJob(jobId, scenes, subtitles){
  const job = jobs.get(jobId);
  const start = Date.now();
  const tmp = '/tmp';
  const files = [];

  const bundleLoc = await bundle({ entryPoint: path.join(__dirname,'src/index.jsx') });

  for(let i=0;i<scenes.length;i++){
    job.currentScene=i+1;
    job.stage=`rendering ${i+1}/${scenes.length}`;

    const comp = await selectComposition({
      serveUrl: bundleLoc,
      id:'VideoComposition',
      inputProps:{scene:scenes[i],subtitles},
      durationInFrames: scenes[i].durationInFrames,
    });

    const out = `${tmp}/${jobId}_${i}.mp4`;

    await renderMedia({
      composition: comp,
      serveUrl: bundleLoc,
      codec:'h264',
      outputLocation: out,
      inputProps:{scene:scenes[i],subtitles},
      concurrency:1,
      audioCodec:'aac',
      audioBitrate:'96k',
      x264Preset:'ultrafast',
      crf:26,
      x264Params:['threads=2','lookahead-threads=1'],
      chromiumOptions:{args:['--no-sandbox','--disable-dev-shm-usage']},
      onProgress:({progress})=>{
        job.progress=i/scenes.length + progress/scenes.length;
      }
    });

    files.push(out);
  }

  const list = `${tmp}/${jobId}.txt`;
  fs.writeFileSync(list, files.map(f=>`file '${f}'`).join('\n'));
  const finalOut = `${tmp}/${jobId}_final.mp4`;

  await execAsync('ffmpeg',['-y','-f','concat','-safe','0','-i',list,'-c','copy',finalOut]);

  job.status='completed';
  job.stage='completed';
  job.progress=1;
  job.output=finalOut;
  job.renderTime=((Date.now()-start)/1000).toFixed(2)+'s';
}

app.listen(process.env.PORT||3000);
