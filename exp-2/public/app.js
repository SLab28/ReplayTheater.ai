// ── Guided prompts (conductor questions) ──
const PROMPTS = [
  "Take a moment to settle in. When you're ready, think of a moment from your life that stayed with you.",
  "Tell me about that moment. What happened?",
  "What did you feel in that moment?",
  "If you could let go of something from that experience, what would it be?",
];

// ── State ──
let currentStep = 0;
const answers = [];

// ── DOM refs ──
const phases = {
  landing: document.getElementById("landing"),
  storyInput: document.getElementById("story-input"),
  hold: document.getElementById("hold"),
  playback: document.getElementById("playback"),
  error: document.getElementById("error"),
};

const promptText = document.getElementById("prompt-text");
const promptLabel = document.getElementById("prompt-label");
const answerBox = document.getElementById("answer-box");
const progressFill = document.getElementById("progress-fill");
const micStatus = document.getElementById("mic-status");
const replayVideo = document.getElementById("replay-video");
const errorMessage = document.getElementById("error-message");

// ── Phase transitions ──
function showPhase(name) {
  Object.values(phases).forEach((el) => el.classList.remove("active"));
  phases[name].classList.add("active");
}

// ── Landing → Story input ──
document.getElementById("btn-enter").addEventListener("click", () => {
  showPhase("storyInput");
  showPrompt(0);
});

// ── Show a conductor prompt ──
function showPrompt(index) {
  currentStep = index;
  promptText.style.opacity = 0;
  setTimeout(() => {
    promptText.textContent = PROMPTS[index];
    promptText.style.opacity = 1;
  }, 300);
  answerBox.value = "";
  answerBox.focus();
  progressFill.style.width = `${((index + 1) / PROMPTS.length) * 100}%`;
  promptLabel.textContent =
    index === 0 ? "The Conductor" : `Question ${index} of ${PROMPTS.length - 1}`;
}

// ── Next / Submit ──
document.getElementById("btn-next").addEventListener("click", handleNext);
answerBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleNext();
  }
});

function handleNext() {
  const text = answerBox.value.trim();
  if (!text) return;

  answers.push(text);

  if (currentStep < PROMPTS.length - 1) {
    showPrompt(currentStep + 1);
  } else {
    generateReplay();
  }
}

// ── Speech-to-text (Web Speech API) ──
let recognition = null;
let isRecording = false;

if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    answerBox.value = transcript;
  };

  recognition.onend = () => {
    isRecording = false;
    document.getElementById("btn-mic").classList.remove("recording");
    micStatus.textContent = "";
  };

  recognition.onerror = (event) => {
    isRecording = false;
    document.getElementById("btn-mic").classList.remove("recording");
    micStatus.textContent =
      event.error === "not-allowed"
        ? "Microphone access denied. Please allow mic access."
        : "";
  };
} else {
  // Hide mic button if not supported
  document.getElementById("btn-mic").style.display = "none";
}

document.getElementById("btn-mic").addEventListener("click", () => {
  if (!recognition) return;

  if (isRecording) {
    recognition.stop();
  } else {
    answerBox.value = "";
    recognition.start();
    isRecording = true;
    document.getElementById("btn-mic").classList.add("recording");
    micStatus.textContent = "Listening...";
  }
});

// ── Generate replay (build prompt → call Runware) ──
async function generateReplay() {
  showPhase("hold");

  try {
    // Step 1: Build the video prompt from answers
    const promptRes = await fetch("/api/build-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const { prompt } = await promptRes.json();
    console.log("Video prompt:", prompt);

    // Step 2: Generate the video via Runware
    const videoRes = await fetch("/api/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!videoRes.ok) {
      const err = await videoRes.json();
      throw new Error(err.error || "Video generation failed");
    }

    const { videoURL } = await videoRes.json();
    console.log("Video URL:", videoURL);

    // Step 3: Show the video
    replayVideo.src = videoURL;
    showPhase("playback");
  } catch (err) {
    console.error(err);
    errorMessage.textContent = err.message || "Something went wrong. Please try again.";
    showPhase("error");
  }
}

// ── Playback controls ──
document.getElementById("btn-replay").addEventListener("click", () => {
  replayVideo.currentTime = 0;
  replayVideo.play();
});

document.getElementById("btn-restart").addEventListener("click", () => {
  answers.length = 0;
  currentStep = 0;
  replayVideo.src = "";
  showPhase("landing");
});

document.getElementById("btn-retry").addEventListener("click", () => {
  generateReplay();
});
