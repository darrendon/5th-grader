// Sound cues for the game. Audio files live in the sounds/ folder.
// Change the file names in SOUND_FILES to swap which sound plays when.
// If a file is missing, the short cues (reveal, correct, wrong, flunk, winner)
// fall back to a simple built-in tone, and the music cues are just skipped.
// Press "M" during a game to mute.

const SOUND_FILES = {
  theme: "theme.mp3", // title screen and player setup (loops)
  question: "think.mp3", // while a question is on screen (loops)
  reveal: "reveal.mp3", // the answer is revealed
  correct: "correct.mp3", // host marks a player right
  wrong: "wrong.mp3", // host marks a player wrong
  flunk: "flunk.mp3", // a player flunks out
  million: "million.mp3", // the million-dollar subject is revealed (loops)
  winner: "winner.mp3", // final results
};

const LOOPING = new Set(["theme", "question", "million"]);

let current = null;
let muted = false;
let ctx = null;
const missing = new Set();

export function mediaUrl(path) {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return path.replace(/^\/+/, "");
}

export function playSound(name) {
  stopSound();
  if (muted) return;
  const file = SOUND_FILES[name];
  if (!file || missing.has(name)) {
    synth(name);
    return;
  }
  const audio = new Audio(`sounds/${file}`);
  audio.loop = LOOPING.has(name);
  current = audio;
  audio.addEventListener(
    "error",
    () => {
      missing.add(name);
      if (current === audio) {
        current = null;
        synth(name);
      }
    },
    { once: true }
  );
  // A blocked autoplay just fails quietly.
  audio.play().catch(() => {});
}

export function stopSound() {
  if (current) {
    current.pause();
    current = null;
  }
}

export function toggleMute() {
  muted = !muted;
  if (muted) stopSound();
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  if (muted) stopSound();
}

export function isMuted() {
  return muted;
}

// Built-in fallback tones: [frequency in Hz, start time, length] per note.
const TONES = {
  reveal: [[660, 0, 0.12], [880, 0.1, 0.25]],
  correct: [[784, 0, 0.1], [1047, 0.09, 0.22]],
  wrong: [[180, 0, 0.35]],
  flunk: [[392, 0, 0.3], [370, 0.32, 0.3], [349, 0.64, 0.3], [311, 0.96, 0.8]],
  winner: [[523, 0, 0.15], [659, 0.15, 0.15], [784, 0.3, 0.15], [1047, 0.45, 0.6]],
};

function synth(name) {
  const notes = TONES[name];
  if (!notes || muted) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime + 0.02;
    const harsh = name === "wrong";
    for (const [freq, start, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = harsh ? "sawtooth" : name === "flunk" ? "triangle" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(harsh ? 0.12 : 0.25, t0 + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.05);
    }
  } catch {
    // No audio available; ignore.
  }
}
