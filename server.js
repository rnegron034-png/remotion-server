import express from "express";
import cors from "cors";
import fs from "fs";
import { exec } from "child_process";
import util from "util";
import { v4 as uuidv4 } from "uuid";

const execAsync = util.promisify(exec);
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;

// Persistent job memory
const jobs = {};

// Ensure folders exist
fs.mkdirSync("jobs", { recursive: true });
fs.mkdirSync("videos", { recursive: true });

app.get("/", (req, res) => {
  res.send("Remotion Render Server Running");
});

/**
 * POST /render
 * Body:
 * {
 *   "clips": ["url1.mp4","url2.mp4"],
 *   "audio": "audio.mp3",
 *   "title": "test"
 * }
 */
app.post("/render", async (req, res) => {
  try {
    const { clips, audio } = req.body;

    // Strict validation
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "clips must be an array" });
    }
    if (!audio) {
      return res.status(400).json({ error: "audio required" });
    }

    const jobId = uuidv4();
    const jobDir = `jobs/${jobId}`;
    fs.mkdirSync(jobDir, { recursive: true });

    jobs[jobId] = { status: "processing", file: null };

    // Return immediately
    res.json({ jobId });

    // Background render
    (async () => {
      try {
        const videoFiles = [];

        // Download all clips
        for (let i = 0; i < clips.length; i++) {
          const file = `${jobDir}/clip${i}.mp4`;
          await execAsync(`curl -L "${clips[i]}" -o "${file}"`);
          videoFiles.push(file);
        }

        // Download audio
        const audioFile = `${jobDir}/audio.mp3`;
        await execAsync(`curl -L "${audio}" -o "${audioFile}"`);

        // Create concat list
        const listFile = `${jobDir}/list.txt`;
        fs.writeFileSync(
          listFile,
          videoFiles.map(f => `file '${f}'`).join("\n")
        );

        const output = `videos/${jobId}.mp4`;

        // Render
        await execAsync(
          `ffmpeg -y -f concat -safe 0 -i ${listFile} -i ${audioFile} \
-map 0:v -map 1:a -c:v libx264 -c:a aac -shortest ${output}`
        );

        jobs[jobId] = { status: "done", file: output };
        console.log("Rendered:", output);
      } catch (err) {
        console.error("Render error:", err);
        jobs[jobId] = { status: "error", error: err.message };
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /status/:id
 */
app.get("/status/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.json({ status: "unknown" });
  res.json(job);
});

/**
 * GET /download/:id
 */
app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") return res.sendStatus(404);
  res.download(job.file);
});

app.listen(PORT, () => {
  console.log("Remotion server listening on", PORT);
});
