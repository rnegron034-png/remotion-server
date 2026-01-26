import express from "express";
import { renderMedia } from "@remotion/renderer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

app.post("/render", async (req, res) => {
  try {
    const { clips, audio, subtitles, title } = req.body;

    const out = `/tmp/${Date.now()}.mp4`;

    await renderMedia({
      entryPoint: path.resolve("./video/index.jsx"),
      composition: "Short",
      serveUrl: "https://remotionbundle.vercel.app",
      codec: "h264",
      outputLocation: out,
      inputProps: { clips, audio, subtitles, title }
    });

    res.json({ url: out });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(3000, () => console.log("Remotion server running"));
