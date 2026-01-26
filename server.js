import express from "express";
import { bundle } from "@remotion/bundler";
import { renderMedia } from "@remotion/renderer";
import fs from "fs";

const app = express();
app.use(express.json());

app.post("/render", async (req, res) => {
  const { clips, audio, title } = req.body;

  const bundleLocation = await bundle({
    entryPoint: "./video/index.jsx",
  });

  const output = `/tmp/${title}.mp4`;

  await renderMedia({
    codec: "h264",
    serveUrl: bundleLocation,
    composition: "MainVideo",
    outputLocation: output,
    inputProps: {
      clips,
      audio
    }
  });

  res.sendFile(output);
});

app.listen(3000);
