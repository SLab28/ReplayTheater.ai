import "dotenv/config";
import express from "express";
import { Runware } from "@runware/sdk-js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// Lazy-init Runware client
let runware = null;
async function getRunware() {
  if (!runware) {
    runware = new Runware({ apiKey: process.env.RUNWARE_API_KEY });
    await runware.ensureConnection();
  }
  return runware;
}

// Generate video from a prompt
app.post("/api/generate-video", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const rw = await getRunware();
    const results = await rw.videoInference({
      positivePrompt: prompt,
      model: "google:3@1",
      duration: 8,
      width: 1280,
      height: 720,
      outputFormat: "mp4",
      numberResults: 1,
      includeCost: true,
    });

    const video = results[0];
    res.json({
      videoURL: video.videoURL,
      cost: video.cost,
    });
  } catch (err) {
    console.error("Video generation error:", err);
    res.status(500).json({ error: err.message || "Video generation failed" });
  }
});

// Build the scene prompt from user story answers
app.post("/api/build-prompt", (req, res) => {
  const { answers } = req.body;

  if (!answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: "answers array is required" });
  }

  // Combine answers into a rich scene description for video generation
  const moment = answers[0] || "";
  const feeling = answers[1] || "";
  const detail = answers[2] || "";
  const release = answers[3] || "";

  const videoPrompt = [
    "Artistic watercolour animation, warm muted palette, soft painterly style, intimate and gentle.",
    `Scene: ${moment}.`,
    feeling ? `The mood is ${feeling}.` : "",
    detail ? `Visual details: ${detail}.` : "",
    release ? `The scene transitions toward a feeling of ${release}, with light breaking through.` : "",
    "Slow camera movement, dreamy atmospheric lighting, floating particles, no text, no faces in sharp focus.",
  ]
    .filter(Boolean)
    .join(" ");

  res.json({ prompt: videoPrompt });
});

app.listen(PORT, () => {
  console.log(`ReplayTheatre.ai running at http://localhost:${PORT}`);
});
