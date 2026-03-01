import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ── Runware REST API (matches MCP server pattern) ──
const RUNWARE_API = "https://api.runware.ai/v1";
const POLL_INTERVAL_MS = 2000;

async function runwareRequest(payload) {
  const res = await fetch(RUNWARE_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([payload]),
  });

  const result = await res.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || "Runware API error");
  }

  return result;
}

async function pollVideoCompletion(taskUUID) {
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const result = await runwareRequest({
      taskType: "getResponse",
      taskUUID,
    });

    if (result.data && result.data.length > 0) {
      const videoData = result.data[0];
      if (videoData.status !== "processing") {
        return result;
      }
    }
  }
}

// ── Anthropic client (lazy-init, optional) ──
let anthropic = null;
async function getAnthropic() {
  if (anthropic) return anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────
//  POST /api/generate-video
//  Generate an abstract video via Runware REST API + async polling
// ──────────────────────────────────────
app.post("/api/generate-video", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Disable Express request timeout for this long-running route
  req.setTimeout(0);
  res.setTimeout(0);

  try {
    const taskUUID = randomUUID();

    // Submit video inference job (async delivery)
    const submitResult = await runwareRequest({
      taskType: "videoInference",
      taskUUID,
      positivePrompt: prompt,
      model: "google:3@1",
      duration: 8,
      width: 1280,
      height: 720,
      outputFormat: "mp4",
      deliveryMethod: "async",
      includeCost: true,
    });

    // Extract taskUUID from response (may differ from ours)
    let pollUUID = taskUUID;
    if (
      submitResult.data &&
      submitResult.data.length > 0 &&
      submitResult.data[0].taskUUID
    ) {
      pollUUID = submitResult.data[0].taskUUID;
    }

    // Poll until video is ready
    const videoResult = await pollVideoCompletion(pollUUID);

    if (videoResult.data && videoResult.data.length > 0) {
      const video = videoResult.data[0];
      res.json({ videoURL: video.videoURL, cost: video.cost });
    } else {
      throw new Error("No video data in response");
    }
  } catch (err) {
    console.error("Video generation error:", err);
    res.status(500).json({ error: err.message || "Video generation failed" });
  }
});

// ──────────────────────────────────────
//  POST /api/build-prompt
//  Build an abstract video-generation prompt from a user story
// ──────────────────────────────────────
app.post("/api/build-prompt", (req, res) => {
  const { story } = req.body;
  if (!story) return res.status(400).json({ error: "story is required" });

  const videoPrompt = [
    "Abstract artistic watercolour animation, warm muted palette, soft painterly impressionistic style.",
    "Characters are abstract silhouettes without detailed faces, rendered as gentle shapes and forms.",
    "Minimal background with soft washes of colour, focus on the emotional essence rather than literal detail.",
    `Scene inspired by this memory: ${story}`,
    "Slow deliberate camera movement, dreamy atmospheric lighting, floating particles of light.",
    "Soft focus throughout, no sharp facial details, ethereal and dreamlike quality.",
    "No text overlays, no UI elements, pure abstract visual storytelling.",
  ].join(" ");

  res.json({ prompt: videoPrompt });
});

// ──────────────────────────────────────
//  POST /api/generate-holding-message
//  Generate a warm, empathetic acknowledgment of the user's story.
//  Uses Anthropic if available, otherwise returns a template.
// ──────────────────────────────────────
const FALLBACK_MESSAGES = [
  "Thank you for sharing that with me. What you've described sounds like a deeply meaningful experience. Let's take a moment to explore it together through something visual.",
  "I appreciate you opening up about this moment. It clearly carries a lot of significance for you. Let me create something that might help you see it in a new light.",
  "That sounds like a profound experience. Thank you for trusting this space with it. Let's see what emerges when we give it a visual form.",
];

app.post("/api/generate-holding-message", async (req, res) => {
  const { story } = req.body;
  if (!story) return res.status(400).json({ error: "story is required" });

  const client = await getAnthropic();

  if (!client) {
    const msg =
      FALLBACK_MESSAGES[Math.floor(Math.random() * FALLBACK_MESSAGES.length)];
    return res.json({ message: msg });
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: [
            "A person has shared a personal memory in a therapeutic digital theatre experience.",
            `Their story: "${story}"`,
            "",
            "Write a brief (2–3 sentences) warm, empathetic acknowledgment.",
            "Be gentle and validating. Do not give advice or ask questions.",
            "Acknowledge what they shared and express appreciation for their openness.",
            "End by gently transitioning toward showing them a visual interpretation of their experience.",
            "Tone: calm, respectful, reassuring.",
          ].join("\n"),
        },
      ],
    });

    res.json({ message: response.content[0].text });
  } catch (err) {
    console.error("Holding message error:", err);
    const msg =
      FALLBACK_MESSAGES[Math.floor(Math.random() * FALLBACK_MESSAGES.length)];
    res.json({ message: msg });
  }
});

app.listen(PORT, () => {
  console.log(`ReplayTheatre.ai running at http://localhost:${PORT}`);
});
