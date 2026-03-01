/* ──────────────────────────────────────
   ReplayTheatre.ai — Front-end
   ────────────────────────────────────── */

// ── State ──
let userStory = "";
let videoURL = "";
let currentPhase = "landing";

// ── Shorthand ──
const $ = (id) => document.getElementById(id);

const phases = {
  landing: $("landing"),
  prompt: $("prompt"),
  acceptance: $("acceptance"),
  playback: $("playback"),
  reflection: $("reflection"),
  ending: $("ending"),
  error: $("error"),
};

// ──────────────────────────────────────
//  Phase Transitions
// ──────────────────────────────────────
function showPhase(name, { zoom = false, unfold = false } = {}) {
  const prev = phases[currentPhase];
  const next = phases[name];

  // Exit current phase
  if (zoom) {
    prev.classList.add("zoom-exit");
    prev.classList.remove("active");
    setTimeout(() => prev.classList.remove("zoom-exit"), 900);
  } else {
    prev.classList.remove("active");
  }

  // Enter next phase (with optional delay for zoom overlap)
  const delay = zoom ? 500 : 120;
  setTimeout(() => {
    if (unfold) {
      next.classList.add("active", "unfold-enter");
      next.addEventListener(
        "animationend",
        () => next.classList.remove("unfold-enter"),
        { once: true }
      );
    } else {
      next.classList.add("active");
    }
  }, delay);

  currentPhase = name;
}

// ──────────────────────────────────────
//  Breath-text Animation
//  Text fades in, holds, fades out,
//  then the prompt body fades in.
// ──────────────────────────────────────
function playBreathText(textEl, bodyEl) {
  bodyEl.classList.remove("visible");
  textEl.classList.remove("visible");

  // Fade in the breath text after a beat
  setTimeout(() => textEl.classList.add("visible"), 300);

  // Fade it out
  setTimeout(() => textEl.classList.remove("visible"), 4200);

  // Fade in the prompt body
  setTimeout(() => bodyEl.classList.add("visible"), 6000);
}

// ──────────────────────────────────────
//  LANDING
// ──────────────────────────────────────
$("btn-enter").addEventListener("click", () => {
  showPhase("prompt", { zoom: true, unfold: true });
  playBreathText($("breath-text"), $("prompt-body"));
});

// ──────────────────────────────────────
//  STORY PROMPT
// ──────────────────────────────────────
const storyBox = $("story-box");

$("btn-submit").addEventListener("click", submitStory);
storyBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitStory();
  }
});

function submitStory() {
  const text = storyBox.value.trim();
  if (!text) return;
  userStory = text;
  generateReplay();
}

// ──────────────────────────────────────
//  ACCEPTANCE STATE + VIDEO GENERATION
//
//  Flow:
//  1. Immediately show "Thank you for sharing..." + play ThankYou.mp3
//  2. In background: fire LLM holding message + prompt build + video gen
//  3. When LLM message ready → generate speech via Runware
//  4. When speech ready → display text + play audio
//  5. When video ready → transition to playback
// ──────────────────────────────────────
async function generateReplay() {
  const msgEl = $("acceptance-msg");
  msgEl.textContent = "Thank you for sharing your story...";
  msgEl.classList.add("visible");
  showPhase("acceptance");

  // Play the pre-recorded thank-you audio immediately
  const thankYouAudio = new Audio("/ThankYou.mp3");
  thankYouAudio.volume = 0.75;
  thankYouAudio.play().catch(() => {});

  try {
    // Fire holding message + prompt build in parallel (while thank-you plays)
    const [holdRes, promptRes] = await Promise.all([
      fetch("/api/generate-holding-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story: userStory }),
      }).then((r) => r.json()),
      fetch("/api/build-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story: userStory }),
      }).then((r) => r.json()),
    ]);

    // Start video generation immediately (long-running, runs in background)
    const videoPromise = fetch("/api/generate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptRes.prompt }),
    });

    // Generate speech audio for the LLM holding message via Runware
    let speechAudioURL = null;
    try {
      const speechRes = await fetch("/api/generate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: holdRes.message }),
      });
      if (speechRes.ok) {
        const speechData = await speechRes.json();
        speechAudioURL = speechData.audioURL;
      }
    } catch (e) {
      console.warn("Speech generation failed, showing text only:", e);
    }

    // Wait for thank-you audio to finish before showing LLM message
    await waitForAudioEnd(thankYouAudio);

    // Fade out the thank-you text
    msgEl.classList.remove("visible");
    await sleep(1200); // match the CSS transition duration

    // Swap text and fade back in
    msgEl.textContent = holdRes.message;
    msgEl.classList.add("visible");
    await sleep(1200);

    // Play the Runware-generated speech if available
    if (speechAudioURL) {
      const holdingAudio = new Audio(speechAudioURL);
      holdingAudio.volume = 0.75;
      holdingAudio.play().catch(() => {});
      // Wait for it to finish before moving on
      await waitForAudioEnd(holdingAudio);
    }

    // Now wait for video generation to complete
    const videoRes = await videoPromise;

    if (!videoRes.ok) {
      const err = await videoRes.json();
      throw new Error(err.error || "Video generation failed");
    }

    const data = await videoRes.json();
    videoURL = data.videoURL;

    // Brief pause to let the user absorb
    await sleep(1500);

    // Transition to video
    openPlayback();
  } catch (err) {
    console.error(err);
    $("error-message").textContent =
      err.message || "Something went wrong. Please try again.";
    showPhase("error");
  }
}

// ── Wait for an Audio element to finish playing ──
function waitForAudioEnd(audio) {
  return new Promise((resolve) => {
    if (audio.ended || audio.paused) return resolve();
    audio.addEventListener("ended", resolve, { once: true });
    audio.addEventListener("error", resolve, { once: true });
  });
}

// ──────────────────────────────────────
//  VIDEO PLAYBACK
// ──────────────────────────────────────
function openPlayback() {
  const stage = $("video-stage");
  const video = $("replay-video");
  const actions = $("playback-actions");

  // Reset visual states
  stage.classList.remove("unfolding", "revealed");
  actions.classList.remove("visible");
  video.src = videoURL;

  showPhase("playback");

  // Trigger the "unfold" reveal
  requestAnimationFrame(() => stage.classList.add("unfolding"));

  stage.addEventListener(
    "animationend",
    () => {
      stage.classList.remove("unfolding");
      stage.classList.add("revealed");
      video.play();
    },
    { once: true }
  );

  // Show replay / continue when video ends
  video.addEventListener(
    "ended",
    () => actions.classList.add("visible"),
    { once: true }
  );
}

$("btn-replay").addEventListener("click", () => {
  const video = $("replay-video");
  const actions = $("playback-actions");
  actions.classList.remove("visible");
  video.currentTime = 0;
  video.play();
  video.addEventListener(
    "ended",
    () => actions.classList.add("visible"),
    { once: true }
  );
});

$("btn-continue").addEventListener("click", () => {
  showPhase("reflection");
  playBreathText($("reflect-breath"), $("reflect-body"));
});

// ──────────────────────────────────────
//  REFLECTION
// ──────────────────────────────────────
const reflectBox = $("reflect-box");

$("btn-reflect-submit").addEventListener("click", submitReflection);
reflectBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitReflection();
  }
});

function submitReflection() {
  const text = reflectBox.value.trim();
  if (!text) return;
  showPhase("ending");
}

// ──────────────────────────────────────
//  RESTART
// ──────────────────────────────────────
$("btn-restart").addEventListener("click", () => {
  userStory = "";
  videoURL = "";
  storyBox.value = "";
  reflectBox.value = "";
  $("replay-video").src = "";
  $("acceptance-msg").textContent = "";
  $("acceptance-msg").classList.remove("visible");
  $("prompt-body").classList.remove("visible");
  $("reflect-body").classList.remove("visible");
  $("video-stage").classList.remove("unfolding", "revealed");
  $("playback-actions").classList.remove("visible");
  showPhase("landing");
});

// ── Error retry ──
$("btn-retry").addEventListener("click", () => {
  if (userStory) generateReplay();
});

// ──────────────────────────────────────
//  SPEECH-TO-TEXT (Web Speech API)
// ──────────────────────────────────────
let recognition = null;
let isRecording = false;
let recBtn = null;
let recArea = null;
let recStatus = null;

if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (e) => {
    let t = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      t += e.results[i][0].transcript;
    }
    if (recArea) recArea.value = t;
  };

  recognition.onend = () => {
    isRecording = false;
    if (recBtn) recBtn.classList.remove("recording");
    if (recStatus) recStatus.textContent = "";
  };

  recognition.onerror = (e) => {
    isRecording = false;
    if (recBtn) recBtn.classList.remove("recording");
    if (recStatus) {
      recStatus.textContent =
        e.error === "not-allowed" ? "Microphone access denied." : "";
    }
  };
} else {
  $("btn-mic").style.display = "none";
  $("btn-mic-reflect").style.display = "none";
}

function toggleMic(btn, textarea, status) {
  if (!recognition) return;
  if (isRecording) {
    recognition.stop();
    return;
  }
  recBtn = btn;
  recArea = textarea;
  recStatus = status;
  textarea.value = "";
  recognition.start();
  isRecording = true;
  btn.classList.add("recording");
  status.textContent = "Listening...";
}

$("btn-mic").addEventListener("click", () =>
  toggleMic($("btn-mic"), storyBox, $("mic-status"))
);
$("btn-mic-reflect").addEventListener("click", () =>
  toggleMic($("btn-mic-reflect"), reflectBox, $("mic-status-reflect"))
);

// ── Utility ──
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
