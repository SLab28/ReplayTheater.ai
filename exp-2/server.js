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

// ── Video prompt building blocks ──
const VIDEO_STYLE_PREFIX = [
  "Abstract artistic watercolour animation, warm muted palette, soft painterly impressionistic style.",
  "Characters are abstract silhouettes without detailed faces, rendered as gentle shapes and forms.",
  "Minimal background with soft washes of colour, focus on the emotional essence rather than literal detail.",
].join(" ");

const VIDEO_STYLE_SUFFIX = [
  "Slow deliberate camera movement, dreamy atmospheric lighting.",
  "Soft focus throughout, no sharp facial details, ethereal and dreamlike quality.",
  "No text overlays, no UI elements, pure abstract visual storytelling.",
  "Only one scene, no transitioning between scenes."
].join(" ");

const SCENE_SCRIPT_SYSTEM_PROMPT = [
  "You are a visual script interpreter for a digital playback theatre.",
  "You convert personal memories into concise abstract animation scene descriptions.",
  "",
  "Rules:",
  "- Output ONLY the scene description, 3-4 sentences.",
  '- Identify characters by body type: use "masculine figure" for male-presenting characters (dad, grandfather, brother, boyfriend, husband, man, boy, he). Use "feminine figure" for female-presenting characters (mom, grandmother, sister, girlfriend, wife, woman, girl, she). Use "small child figure" for children. Use "abstract human silhouette" when gender is unclear.',
  "- Describe specific body language: reaching hands, bowed heads, open arms, turned backs, leaning together, running, dancing, embracing.",
  "- Describe emotional energy: tender, joyful, grieving, anxious, peaceful, longing, hopeful.",
  "- Specify spatial relationships: facing each other, side by side, one departing, circling, standing apart.",
  "- Every character should feel alive with posture, gesture, or subtle movement.",
  "- Write speech script for relevant characters. Characters should speak with each other based on the prompt. The character voice should be based on the character's specified gender.",
  "- Do NOT include artistic style directions (watercolor, palette, lighting, camera).",
  "- Do NOT include any meta-commentary or explanations.",
  "- Write in present tense, descriptive, visual language.",
].join("\n");

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

// ── Generate a structured scene script from a user story via Claude ──
async function generateSceneScript(story) {
  const client = await getAnthropic();
  if (!client) return null;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SCENE_SCRIPT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Memory: "${story}"\n\nWrite the scene description.`,
        },
      ],
    });

    const script = response.content[0].text.trim();
    if (!script) return null;
    return script;
  } catch (err) {
    console.error("Scene script generation error:", err);
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
      model: "vidu:4@2",
      duration: 8,
      width: 960,
      height: 528,
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
//  Build an abstract video-generation prompt from a user story.
//  Uses Claude to generate a structured scene script with gendered
//  characters, movement, and emotion. Falls back to a static
//  template if no LLM is available.
// ──────────────────────────────────────
app.post("/api/build-prompt", async (req, res) => {
  const { story } = req.body;
  if (!story) return res.status(400).json({ error: "story is required" });

  // Try LLM-enhanced scene script
  const sceneScript = await generateSceneScript(story);

  let videoPrompt;
  if (sceneScript) {
    // Sandwich: our style directives wrap the LLM's scene interpretation
    videoPrompt = `${VIDEO_STYLE_PREFIX} ${sceneScript} ${VIDEO_STYLE_SUFFIX}`;
    console.log("Scene script (LLM):", sceneScript);
  } else {
    // Fallback: static template (no Anthropic key or API failure)
    videoPrompt = `${VIDEO_STYLE_PREFIX} Scene inspired by this memory: ${story} ${VIDEO_STYLE_SUFFIX}`;
    console.log("Scene script (fallback): using static template");
  }

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
      max_tokens: 1024,
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

// ──────────────────────────────────────
//  POST /api/generate-speech
//  Convert text to speech via Runware audioInference.
//  Returns { audioURL } on success.
// ──────────────────────────────────────
app.post("/api/generate-speech", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  try {
    const taskUUID = randomUUID();

    const submitResult = await runwareRequest({
      taskType: "audioInference",
      taskUUID,
      outputFormat: "MP3",
      numberResults: 1,
      includeCost: true,
      audioSettings: {
        bitrate: 128,
        sampleRate: 32000,
        channels: 2,
      },
      speech: {
        text,
        voice: "English_CalmWoman",
        speed: 1,
        volume: 1,
        pitch: 0,
      },
      settings: {
        languageBoost: "auto",
        turbo: true,
      },
      outputType: ["URL"],
      model: "minimax:speech@2.8",
    });

    // Audio may come back inline or need polling
    if (submitResult.data && submitResult.data.length > 0) {
      const audio = submitResult.data[0];
      if (audio.audioURL) {
        return res.json({ audioURL: audio.audioURL, cost: audio.cost });
      }
      // If async, poll for completion
      if (audio.taskUUID) {
        const pollResult = await pollVideoCompletion(audio.taskUUID);
        if (pollResult.data && pollResult.data.length > 0) {
          const result = pollResult.data[0];
          return res.json({ audioURL: result.audioURL, cost: result.cost });
        }
      }
    }

    throw new Error("No audio data in response");
  } catch (err) {
    console.error("Speech generation error:", err);
    res.status(500).json({ error: err.message || "Speech generation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`ReplayTheatre.ai running at http://localhost:${PORT}`);
});
