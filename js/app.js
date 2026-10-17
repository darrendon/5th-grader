import { playSound, stopSound, toggleMute, isMuted, mediaUrl } from "./sounds.js?v=__V__";
import {
  aud,
  loadAudience,
  startAudience,
  stopAudience,
  resetScores,
  newRoom,
  setOnChange,
  syncQuestion,
  standings as audStandings,
  questionStats,
  answerGroups,
  flipAnswers,
  playerCount,
  activeCount,
  currentPid,
  isRevealed,
  joinUrl,
  shortUrl,
  SUBJECTS,
  MAX_POINTS,
  MIN_POINTS,
  DROP_MS,
} from "./audience.js?v=__V__";
import qrcode from "./vendor/qrcode.mjs";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Bank after 1, 2, 3 ... 10 correct answers, then the million-dollar question.
const LADDER = [1000, 2000, 5000, 10000, 25000, 50000, 100000, 175000, 300000, 500000, 1000000];
const SAFE_LEVEL = 5; // after 5 correct answers, $25,000 is guaranteed
const SAFE_AMOUNT = 25000;
const CHEATS = {
  peek: { label: "Peek", icon: "👀", tip: "Look at the 5th grader's answer, then write your own" },
  copy: { label: "Copy", icon: "📝", tip: "Lock in the 5th grader's answer, right or wrong" },
  // Save is used after the reveal, on a player who was marked wrong, like the show applying it automatically.
  save: { label: "Save", icon: "🛟", tip: "You're wrong, but if the 5th grader is right, you're saved", afterReveal: true },
};
const STORE_KEY = "smarter5th.state.v1";
const CLASSMATE = "__classmate"; // key for the 5th grader's mark when they aren't a player
const QUESTIONS_PER_CLASSMATE = 2; // a new 5th grader is chosen every 2 questions

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = freshState();
let gameList = [];
let draftName = "";

function freshState() {
  return {
    screen: "loader", // loader | setup | board | question | millionIntro | results
    game: null,
    gameId: null,
    players: [],
    classmate: null, // current 5th grader: { playerId } for a player, or { name } for anyone else
    classmateBlock: -1, // which pair of questions the current 5th grader covers
    pastClassmates: [], // names of everyone who has been the 5th grader this game
    used: [],
    asked: 0,
    current: null,
    overlay: null,
    runId: Math.random().toString(36).slice(2, 7), // keeps play-along scores apart between games
  };
}

function save() {
  try {
    if (state.game && state.screen !== "loader") localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

function savedGame() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.game && s.screen !== "results" ? s : null;
  } catch {
    return null;
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (n) => "$" + Number(n).toLocaleString("en-US");
const levelValue = (level) => (level <= 0 ? 0 : LADDER[level - 1]);
const flunkValue = (level) => (level >= SAFE_LEVEL ? SAFE_AMOUNT : 0);
const ORDINALS = { 1: "1st", 2: "2nd", 3: "3rd" };
const gradeName = (g) => `${ORDINALS[g] || g + "th"} Grade`;
const playerById = (id) => state.players.find((p) => p.id === id);
const stillIn = () => state.players.filter((p) => p.status === "in");
const bankOf = (p) => (p.status === "in" ? levelValue(p.level) : p.bank);

function currentQuestion() {
  const c = state.current;
  if (!c) return null;
  return c.kind === "million" ? state.game.million : state.game.questions[c.tile];
}

// Everyone answers every question. Players who are out play for bragging rights:
// their correct answers only count toward the tiebreaker.
function participants() {
  return state.players.filter((p) => p.status !== "millionaire");
}

function playerIsLive(p) {
  const c = state.current;
  if (p.status !== "in") return false;
  if (c.kind === "million") return true; // nobody walks away from the million
  return !c.drops.includes(p.id);
}

function classmateName() {
  const m = state.classmate;
  if (!m) return "the 5th grader";
  if (m.playerId) return playerById(m.playerId)?.name || "the 5th grader";
  return m.name || "the 5th grader";
}

const isClassmate = (p) => !!state.classmate && state.classmate.playerId === p.id;

// The 5th grader's mark on the current question. If they're a player,
// their own mark doubles as the 5th grader's.
function classmateMark() {
  const c = state.current;
  const m = state.classmate;
  return m && m.playerId ? c.marks[m.playerId] : c.marks[CLASSMATE];
}

// A new 5th grader is needed at the start of each pair of questions.
function needsPick() {
  if (!state.game || state.used.every(Boolean)) return false;
  return state.classmateBlock !== Math.floor(state.asked / QUESTIONS_PER_CLASSMATE);
}

// The classmate only needs marking when it decides someone's result:
// a Copy, or a Save by a player who was marked wrong.
function needsClassmate() {
  const c = state.current;
  return participants().some((p) => {
    if (!playerIsLive(p)) return false;
    const cheat = c.cheats[p.id];
    return cheat === "copy" || (cheat === "save" && c.marks[p.id] === false);
  });
}

// The result that counts for a live player, after cheats.
function liveResult(p) {
  const c = state.current;
  const cheat = c.cheats[p.id];
  const mate = classmateMark();
  if (cheat === "copy") return mate;
  const mark = c.marks[p.id];
  if (mark === undefined) return undefined;
  if (!mark && cheat === "save") return mate === undefined ? undefined : mate;
  return mark;
}

function allMarked() {
  const c = state.current;
  if (needsClassmate() && classmateMark() === undefined) return false;
  return participants().every((p) => (playerIsLive(p) ? liveResult(p) : c.marks[p.id]) !== undefined);
}

// ---------------------------------------------------------------------------
// Loading games
// ---------------------------------------------------------------------------

function validateGame(g) {
  if (!g || !Array.isArray(g.questions) || g.questions.length === 0) throw new Error("The file needs a \"questions\" list.");
  g.questions.forEach((q, i) => {
    if (!q.question || q.answer === undefined) throw new Error(`Question ${i + 1} needs a "question" and an "answer".`);
  });
  if (g.million && (!g.million.question || g.million.answer === undefined))
    throw new Error('The "million" question needs a "question" and an "answer".');
  return g;
}

async function loadGameById(id) {
  const res = await fetch(`games/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't find games/${id}.json`);
  startSetup(validateGame(await res.json()), id);
}

function startSetup(game, id) {
  const keepPlayers = state.players.map((p) => p.name);
  state = freshState();
  state.game = game;
  state.gameId = id;
  state.used = game.questions.map(() => false);
  state.screen = "setup";
  keepPlayers.forEach(addPlayer);
  playSound("theme");
  render();
}

function addPlayer(name) {
  name = String(name).trim();
  if (!name) return;
  state.players.push({
    id: Math.random().toString(36).slice(2, 9),
    name,
    status: "in", // in | dropped | flunked | millionaire
    level: 0,
    bank: 0,
    correct: 0,
    cheats: { peek: true, copy: true, save: true },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions = {
  loadGame: async ({ id }) => {
    try {
      await loadGameById(id);
    } catch (e) {
      alert(e.message);
    }
  },
  resume: () => {
    const s = savedGame();
    if (!s) return;
    state = { ...freshState(), ...s };
    state.overlay = null;
    // Saves from before the 5th grader rotated stored a plain name.
    if (typeof state.classmate === "string") {
      state.classmate = null;
      state.classmateBlock = -1;
    }
    // A question whose results were already scored: move on from it.
    if (state.current?.phase === "done") return afterQuestion();
    render();
  },
  pickFile: () => document.getElementById("file-input")?.click(),

  addPlayer: () => {
    const input = document.getElementById("player-name");
    addPlayer(input ? input.value : draftName);
    draftName = "";
    render();
    document.getElementById("player-name")?.focus();
  },
  removePlayer: ({ id }) => {
    state.players = state.players.filter((p) => p.id !== id);
    render();
  },
  startGame: () => {
    if (state.players.length === 0) return;
    state.screen = "board";
    stopSound();
    render();
  },
  backToLoader: () => {
    stopSound();
    const keep = state.players;
    state = freshState();
    state.players = keep;
    clearSaved();
    render();
  },

  openTile: ({ tile }) => {
    const i = Number(tile);
    if (state.used[i] || needsPick()) return;
    state.current = { kind: "grade", tile: i, phase: "asking", marks: {}, cheats: {}, drops: [] };
    state.screen = "question";
    playSound("question");
    render();
  },
  backToBoard: () => {
    if (!state.current || state.current.phase !== "asking" || state.current.kind === "million") return;
    // Undo any cheats spent on a question that was closed before the reveal.
    for (const [pid, cheat] of Object.entries(state.current.cheats)) {
      const p = playerById(pid);
      if (p) p.cheats[cheat] = true;
    }
    state.current = null;
    state.screen = "board";
    stopSound();
    render();
  },

  toggleDrop: ({ id }) => {
    const c = state.current;
    if (c.phase !== "asking") return;
    const p = playerById(id);
    if (c.drops.includes(id)) {
      c.drops = c.drops.filter((x) => x !== id);
    } else {
      // Dropping out undoes a cheat picked on this question.
      if (c.cheats[id]) {
        p.cheats[c.cheats[id]] = true;
        delete c.cheats[id];
      }
      c.drops.push(id);
    }
    render();
  },
  useCheat: ({ id, cheat }) => {
    const c = state.current;
    if (c.phase !== "asking" || c.kind === "million") return;
    const p = playerById(id);
    if (isClassmate(p)) return; // the 5th grader can't cheat off themselves
    if (CHEATS[cheat]?.afterReveal) return; // Save comes after the reveal: see useSave
    if (c.cheats[id] === cheat) {
      // Clicking again undoes a misclick.
      p.cheats[cheat] = true;
      delete c.cheats[id];
    } else {
      if (c.cheats[id] || !p.cheats[cheat]) return; // one cheat per question
      p.cheats[cheat] = false;
      c.cheats[id] = cheat;
    }
    render();
  },
  // After the reveal, a live player marked wrong can spend their Save. It only rescues
  // them if the 5th grader was right (see liveResult).
  useSave: ({ id }) => {
    const c = state.current;
    if (c.phase !== "revealed" || c.kind === "million") return;
    const p = playerById(id);
    if (!p || !playerIsLive(p) || isClassmate(p)) return;
    if (c.cheats[id] === "save") {
      // Clicking again undoes a misclick.
      p.cheats.save = true;
      delete c.cheats[id];
    } else {
      if (c.cheats[id] || !p.cheats.save || c.marks[id] !== false) return; // one cheat per question
      p.cheats.save = false;
      c.cheats[id] = "save";
    }
    render();
  },
  closeOverlay: () => {
    const o = state.overlay;
    state.overlay = null;
    if (o?.type === "flunk") afterQuestion();
    else render();
  },

  reveal: () => {
    const c = state.current;
    if (c.phase !== "asking") return;
    c.phase = "revealed";
    playSound("reveal");
    render();
  },
  mark: ({ id, value }) => {
    const c = state.current;
    if (c.phase !== "revealed") return;
    c.marks[id] = value === "1";
    if (value === "1") refundSave(id);
    playSound(value === "1" ? "correct" : "wrong");
    render();
  },
  markAll: ({ value }) => {
    const c = state.current;
    for (const p of participants()) {
      if (!(playerIsLive(p) && c.cheats[p.id] === "copy")) c.marks[p.id] = value === "1";
      if (value === "1") refundSave(p.id);
    }
    if (needsClassmate() && !state.classmate?.playerId) c.marks[CLASSMATE] = value === "1";
    playSound(value === "1" ? "correct" : "wrong");
    render();
  },
  continue: () => finishQuestion(),

  pickClassmate: ({ id, name: audName }) => {
    let pick;
    if (id) {
      pick = { playerId: id };
    } else if (audName) {
      pick = { name: audName };
    } else {
      const name = (document.getElementById("other-classmate")?.value || "").trim();
      if (!name) return document.getElementById("other-classmate")?.focus();
      pick = { name };
    }
    state.classmate = pick;
    state.classmateBlock = Math.floor(state.asked / QUESTIONS_PER_CLASSMATE);
    const name = classmateName();
    if (!state.pastClassmates.includes(name)) state.pastClassmates.push(name);
    render();
  },
  changeClassmate: () => {
    // Picked the wrong person: they don't count as having gone.
    state.pastClassmates = state.pastClassmates.filter((n) => n !== classmateName());
    state.classmateBlock = -1;
    render();
  },
  startMillion: () => {
    if (state.screen !== "millionIntro") return;
    state.current = { kind: "million", phase: "asking", marks: {}, cheats: {}, drops: [] };
    state.screen = "question";
    playSound("question");
    render();
  },

  endGame: () => {
    if (!confirm("End the game and show the final results?")) return;
    toResults();
  },
  newGame: () => {
    clearSaved();
    startSetup(state.game, state.gameId); // same players, fresh scores
  },
  toggleMute: () => {
    toggleMute();
    render();
  },

  audOn: () => startAudience(),
  audOff: () => stopAudience(),
  audReset: () => {
    if (confirm("Start the play-along leaderboard over from zero?")) resetScores();
  },
  audNewRoom: () => {
    if (confirm("Open a new room? Everyone on their phones will have to join again.")) newRoom();
  },
  audBoard: () => {
    aud.board = !aud.board;
    aud.review = false;
    updateAudience();
  },
  audReview: () => {
    aud.review = !aud.review;
    aud.board = false;
    updateAudience();
  },
  audClose: () => {
    aud.board = false;
    aud.review = false;
    updateAudience();
  },
  audFlip: ({ key }) => flipAnswers(key),
};

// A player re-marked right doesn't need their Save: give it back.
function refundSave(id) {
  const c = state.current;
  const p = playerById(id);
  if (p && c.cheats[id] === "save") {
    p.cheats.save = true;
    delete c.cheats[id];
  }
}

function finishQuestion() {
  const c = state.current;
  if (c.phase !== "revealed") return;
  const q = currentQuestion();
  const parts = participants();
  if (!allMarked()) return;

  const flunked = [];
  for (const p of parts) {
    if (playerIsLive(p)) {
      const ok = liveResult(p);
      if (c.kind === "million") {
        if (ok) {
          p.status = "millionaire";
          p.bank = LADDER[10];
          p.correct++;
        } else {
          p.status = "flunked";
          p.bank = SAFE_AMOUNT;
          flunked.push(p.name);
        }
      } else if (ok) {
        p.level++;
        p.correct++;
      } else {
        p.status = "flunked";
        p.bank = flunkValue(p.level);
        flunked.push(p.name);
      }
    } else {
      if (p.status === "in" && c.drops.includes(p.id)) {
        p.status = "dropped";
        p.bank = levelValue(p.level);
      }
      if (c.marks[p.id]) p.correct++;
    }
  }

  if (c.kind === "grade") {
    state.used[c.tile] = true;
    state.asked++;
  }
  state.lastAnswer = q.answer;
  c.phase = "done";

  if (flunked.length) {
    state.overlay = { type: "flunk", names: flunked, million: c.kind === "million" };
    playSound("flunk");
    render();
    return;
  }
  afterQuestion();
}

function afterQuestion() {
  const wasMillion = state.current?.kind === "million";
  state.current = null;
  if (wasMillion) return toResults();
  const allUsed = state.used.every(Boolean);
  if (allUsed) {
    if (state.game.million && stillIn().length) {
      state.screen = "millionIntro";
      playSound("million");
      render();
      return;
    }
    return toResults();
  }
  state.screen = "board";
  stopSound();
  render();
}

function toResults() {
  for (const p of state.players) {
    if (p.status === "in") {
      p.status = "dropped";
      p.bank = levelValue(p.level);
    }
  }
  state.current = null;
  state.overlay = null;
  state.screen = "results";
  clearSaved();
  playSound("winner");
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const app = document.getElementById("app");
  const screens = {
    loader: renderLoader,
    setup: renderSetup,
    board: renderBoard,
    question: renderQuestion,
    millionIntro: renderMillionIntro,
    results: renderResults,
  };
  syncQuestion(audienceQuestion());
  renderedAudOn = aud.on;
  app.innerHTML = screens[state.screen]() + renderOverlay() + audSlot("overlay") + audSlot("corner") + renderMute();
  save();
  if (state.screen === "setup") {
    const input = document.getElementById("player-name");
    if (input) {
      input.value = draftName;
      input.addEventListener("input", (e) => (draftName = e.target.value));
    }
  }
}

function renderMute() {
  return `<button class="mute" data-action="toggleMute" title="Mute (M)">${isMuted() ? "🔇" : "🔊"}</button>`;
}

function logo(small = false) {
  return `<div class="logo ${small ? "logo-small" : ""}">
    <span class="logo-are">Are You</span>
    <span class="logo-smarter">Smarter</span>
    <span class="logo-than">Than a <span class="logo-former">Former</span></span>
    <span class="logo-fifth"><span class="logo-5">5</span><sup>th</sup> Grader?</span>
  </div>`;
}

function renderLoader() {
  const resume = savedGame();
  const games = gameList.length
    ? gameList
        .map(
          (g) => `<button class="episode" data-action="loadGame" data-id="${esc(g.id)}">
            <span class="episode-title">${esc(g.title)}</span>
            ${g.description ? `<span class="episode-desc">${esc(g.description)}</span>` : ""}
          </button>`
        )
        .join("")
    : `<p class="muted">No games listed in games/index.json yet.</p>`;
  return `<main class="screen loader">
    ${logo()}
    <section class="card">
      ${resume ? `<button class="btn btn-yellow wide" data-action="resume">Resume game in progress · ${esc(resume.game.title || "")}</button>` : ""}
      <h2>Pick an episode</h2>
      <div class="episodes">${games}</div>
      <button class="btn btn-ghost" data-action="pickFile">Load a game file…</button>
      <input type="file" id="file-input" accept=".json,application/json" hidden />
    </section>
  </main>`;
}

function renderSetup() {
  const g = state.game;
  return `<main class="screen setup">
    ${logo(true)}
    <section class="card">
      <p class="eyebrow">${esc(g.title || "Custom game")}</p>
      <h2>Who's in class today?</h2>
      <form class="add-player" onsubmit="return false">
        <input id="player-name" placeholder="Player name" autocomplete="off" maxlength="24" />
        <button class="btn btn-yellow" data-action="addPlayer">Add</button>
      </form>
      <ul class="roster">
        ${state.players
          .map((p) => `<li><span>${esc(p.name)}</span><button class="x" data-action="removePlayer" data-id="${p.id}" aria-label="Remove">×</button></li>`)
          .join("")}
      </ul>
      <details class="rules">
        <summary>How it works</summary>
        <ul>
          <li>Pick any subject on the board. Everyone writes down an answer to every question.</li>
          <li>Each right answer moves you up the money ladder. One wrong answer and you flunk out — with ${money(SAFE_AMOUNT)} if you'd already banked it, otherwise nothing.</li>
          <li>After seeing a question you can <b>drop out</b> and keep what you've banked.</li>
          <li>Every ${QUESTIONS_PER_CLASSMATE} questions, the group picks a new <b>5th grader</b> — a different person each time. They answer too, and everyone else can use their answer: one <b>Peek</b> (look at it), one <b>Copy</b> (lock it in) and one <b>Save</b> (used after the reveal: if you're wrong but the 5th grader is right, you're saved) per player, one per question.</li>
          <li>Survive all ${g.questions.length} and you face the ${money(LADDER[10])} question — no cheats and no walking away. Get it wrong and you leave with ${money(SAFE_AMOUNT)}.</li>
          <li>Players who are out keep answering for bragging rights: most correct answers breaks ties.</li>
        </ul>
      </details>
      ${audSlot("setup")}
      <div class="row">
        <button class="btn btn-ghost" data-action="backToLoader">Back</button>
        <button class="btn btn-red" data-action="startGame" ${state.players.length ? "" : "disabled"}>Ring the bell →</button>
      </div>
    </section>
  </main>`;
}

function renderLadder() {
  const level = stillIn().length ? Math.max(...stillIn().map((p) => p.level)) : -1;
  return `<ol class="ladder">
    ${LADDER.map((v, i) => {
      const cls = [i + 1 === level ? "reached" : "", i === level ? "next" : "", i + 1 === SAFE_LEVEL ? "safe" : "", i === 10 ? "top" : ""].join(" ");
      return `<li class="${cls}"><span>${i === 10 ? "★" : i + 1}</span>${money(v)}</li>`;
    })
      .reverse()
      .join("")}
  </ol>`;
}

function renderScoreboard() {
  return `<div class="scoreboard">
    ${state.players
      .map((p) => {
        const status =
          p.status === "in"
            ? `<span class="bank">${money(bankOf(p))}</span>`
            : p.status === "dropped"
            ? `<span class="bank out">${money(p.bank)}</span><span class="tag">dropped out</span>`
            : p.status === "millionaire"
            ? `<span class="bank">${money(p.bank)}</span><span class="tag gold">millionaire</span>`
            : `<span class="bank out">${money(p.bank)}</span><span class="tag red">flunked</span>`;
        const cheats = Object.keys(CHEATS)
          .map((k) => `<span class="cheat-dot ${p.cheats[k] ? "" : "spent"}" title="${CHEATS[k].label}">${CHEATS[k].icon}</span>`)
          .join("");
        return `<div class="player ${p.status}">
          <div class="player-name">${esc(p.name)}</div>
          <div class="player-status">${status}</div>
          <div class="player-meta">${p.status === "in" ? cheats : ""}<span class="correct" title="Correct answers (tiebreaker)">✓ ${p.correct}</span></div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderBoard() {
  const qs = state.game.questions;
  const nobodyIn = stillIn().length === 0;
  return `<main class="screen board">
    <header class="topbar">
      ${logo(true)}
      <div class="topbar-info">
        <div class="eyebrow">Question ${state.asked + 1} of ${qs.length}</div>
        <div class="stake">${nobodyIn ? "Playing for bragging rights" : `Playing for ${money(LADDER[Math.min(state.asked, 9)])}`}</div>
        ${
          state.classmate && !needsPick()
            ? `<div class="current-mate">🎒 5th grader: <b>${esc(classmateName())}</b> <button class="link" data-action="changeClassmate">change</button></div>`
            : ""
        }
      </div>
      <button class="btn btn-ghost small" data-action="endGame">End game</button>
    </header>
    ${nobodyIn ? `<div class="banner">Everyone is out of the money. The rest of the board is for bragging rights — most correct answers breaks the tie.</div>` : ""}
    <div class="board-layout ${aud.on ? "with-aud" : ""}">
      <div class="tiles">
        ${qs
          .map((q, i) => [q, i])
          // Highest grade on top, like the money ladder; same-grade tiles keep file order.
          .sort(([a, ai], [b, bi]) => (b.grade || 0) - (a.grade || 0) || ai - bi)
          .map(
            ([q, i]) => `<button class="tile grade-${Math.min(Math.max(q.grade || 1, 1), 5)} ${state.used[i] ? "used" : ""}" data-action="openTile" data-tile="${i}" ${state.used[i] ? "disabled" : ""}>
              <span class="tile-grade">${q.grade ? gradeName(q.grade) : ""}</span>
              <span class="tile-subject">${esc(q.subject || `Question ${i + 1}`)}</span>
            </button>`
          )
          .join("")}
      </div>
      ${renderLadder()}
      ${aud.on ? audSlot("boardLb") : ""}
    </div>
    ${renderScoreboard()}
    ${needsPick() ? renderPicker() : ""}
  </main>`;
}

function renderPicker() {
  const block = Math.floor(state.asked / QUESTIONS_PER_CLASSMATE);
  const first = block * QUESTIONS_PER_CLASSMATE + 1;
  const last = Math.min(first + QUESTIONS_PER_CLASSMATE - 1, state.game.questions.length);
  const range = first === last ? `question ${first}` : `questions ${first}–${last}`;
  const went = (name) => state.pastClassmates.includes(name);
  return `<div class="overlay">
    <div class="overlay-card picker">
      <div class="picker-icon">🎒</div>
      <h2>Who's the new 5th grader?</h2>
      <p class="muted-ink">As a group, pick someone who hasn't gone yet. They're the 5th grader for ${range}.</p>
      <div class="picker-options">
        ${state.players
          .map(
            (p) => `<button class="pick ${went(p.name) ? "went" : ""}" data-action="pickClassmate" data-id="${p.id}">
              ${esc(p.name)}${went(p.name) ? `<span>already went</span>` : ""}
            </button>`
          )
          .join("")}
      </div>
      ${aud.on ? audSlot("pickerAud") : ""}
      <form class="add-player" onsubmit="return false">
        <input id="other-classmate" placeholder="Someone else in the room" autocomplete="off" maxlength="24" />
        <button class="btn btn-yellow" data-action="pickClassmate">Choose</button>
      </form>
    </div>
  </div>`;
}

function renderMedia(q, revealed) {
  let html = "";
  if (q.image) html += `<img class="media" src="${esc(mediaUrl(q.image))}" alt="" />`;
  if (q.audio) html += `<audio class="media" controls src="${esc(mediaUrl(q.audio))}"></audio>`;
  if (q.video) html += `<video class="media" controls src="${esc(mediaUrl(q.video))}"></video>`;
  if (revealed && q.answerImage) html += `<img class="media" src="${esc(mediaUrl(q.answerImage))}" alt="" />`;
  return html ? `<div class="media-wrap">${html}</div>` : "";
}

function renderQuestion() {
  const c = state.current;
  const q = currentQuestion();
  const million = c.kind === "million";
  const revealed = c.phase !== "asking";
  const done = c.phase === "done"; // scored; only shown behind the flunk splash
  const live = participants().filter(playerIsLive);
  const stakeLevel = live.length ? live[0].level : 0;
  const header = million
    ? `<div class="q-grade">The ${money(LADDER[10])} Question</div><div class="q-subject">${esc(q.subject || "")}</div>`
    : `<div class="q-grade">${q.grade ? gradeName(q.grade) : ""}</div><div class="q-subject">${esc(q.subject || "")}</div>`;
  const stake = million ? money(LADDER[10]) : live.length ? money(LADDER[stakeLevel]) : "Bragging rights";
  const choices = Array.isArray(q.choices)
    ? `<ol class="choices">${q.choices
        .map((ch) => `<li class="${revealed && String(ch).trim().toLowerCase() === String(q.answer).trim().toLowerCase() ? "right" : ""}">${esc(ch)}</li>`)
        .join("")}</ol>`
    : "";
  const answerBlock = revealed
    ? `<div class="answer">
        <div class="answer-label">Answer</div>
        <div class="answer-text">${esc(q.answer)}</div>
        ${q.note ? `<div class="answer-note">${esc(q.note)}</div>` : ""}
      </div>`
    : "";

  const parts = participants();
  const ready = revealed && allMarked();
  const mateMark = classmateMark();
  const matePlayer = !!state.classmate?.playerId;

  const chips = parts
    .map((p) => {
      const isLive = playerIsLive(p);
      const dropping = c.drops.includes(p.id);
      const cheat = c.cheats[p.id];
      let controls = "";
      if (!revealed) {
        if (p.status === "in" && !million && isClassmate(p)) {
          controls = `<span class="chip-note">🎒 the 5th grader — no cheats</span><button class="chip-btn drop ${dropping ? "active" : ""}" data-action="toggleDrop" data-id="${p.id}">${dropping ? `Dropping out · ${money(levelValue(p.level))}` : "Drop out"}</button>`;
        } else if (p.status === "in" && !million) {
          const cheatBtns = Object.entries(CHEATS)
            .filter(([, v]) => !v.afterReveal)
            .map(([k, v]) => {
              const active = cheat === k;
              const disabled = dropping || (!active && (cheat || !p.cheats[k]));
              return `<button class="chip-btn ${active ? "active" : ""}" title="${v.tip}" data-action="useCheat" data-id="${p.id}" data-cheat="${k}" ${disabled ? "disabled" : ""}>${v.icon} ${v.label}</button>`;
            })
            .join("");
          controls = `${cheatBtns}<button class="chip-btn drop ${dropping ? "active" : ""}" data-action="toggleDrop" data-id="${p.id}">${dropping ? `Dropping out · ${money(levelValue(p.level))}` : "Drop out"}</button>`;
        } else if (!isLive) {
          controls = `<span class="chip-note">bragging rights</span>`;
        } else {
          controls = `<span class="chip-note">no cheats</span>`;
        }
      } else {
        const result = isLive ? liveResult(p) : c.marks[p.id];
        if (isLive && cheat === "copy") {
          controls = `<span class="chip-note">copied ${esc(classmateName())} → ${result === undefined ? `mark ${esc(classmateName())}` : result ? "✓ right" : "✗ wrong"}</span>`;
        } else {
          const saving = isLive && cheat === "save" && c.marks[p.id] === false;
          // Marked wrong with a Save left (and no other cheat this question): offer it.
          const canSave = isLive && !million && !isClassmate(p) && !cheat && p.cheats.save && c.marks[p.id] === false;
          const saveBtn =
            saving || canSave
              ? `<button class="chip-btn ${saving ? "active" : ""}" title="${CHEATS.save.tip}" data-action="useSave" data-id="${p.id}">${CHEATS.save.icon} ${saving ? "Saving" : "Use Save"}</button>`
              : "";
          const savedNote = saving
            ? mateMark === undefined
              ? `<span class="chip-note">mark ${esc(classmateName())}</span>`
              : mateMark
              ? `<span class="chip-note saved">saved!</span>`
              : `<span class="chip-note">save failed</span>`
            : "";
          controls = `<button class="mark yes ${c.marks[p.id] === true ? "on" : ""}" data-action="mark" data-id="${p.id}" data-value="1" aria-label="Correct">✓</button>
            <button class="mark no ${c.marks[p.id] === false ? "on" : ""}" data-action="mark" data-id="${p.id}" data-value="0" aria-label="Wrong">✗</button>${saveBtn}${savedNote}`;
        }
        if (!isLive) controls += `<span class="chip-note small">for bragging rights</span>`;
      }
      const cheatTag = cheat
        ? `<span class="tag">${CHEATS[cheat].icon} ${CHEATS[cheat].label}</span>`
        : !million && isClassmate(p)
        ? `<span class="tag gold">🎒 5th grader</span>`
        : "";
      return `<div class="chip ${isLive ? "live" : "bystander"} ${dropping ? "dropping" : ""} ${!million && isClassmate(p) ? "is-mate" : ""}">
        <div class="chip-head"><span class="chip-name">${esc(p.name)}</span>${cheatTag}<span class="chip-bank">${money(bankOf(p))}</span></div>
        <div class="chip-controls">${controls}</div>
      </div>`;
    })
    .join("");

  const mateChip =
    revealed && needsClassmate() && !matePlayer
      ? `<div class="chip classmate-chip">
          <div class="chip-head"><span class="chip-name">🎒 ${esc(classmateName())}</span><span class="tag">5th grader</span></div>
          <div class="chip-controls">
            <button class="mark yes ${mateMark === true ? "on" : ""}" data-action="mark" data-id="${CLASSMATE}" data-value="1" aria-label="5th grader correct">✓</button>
            <button class="mark no ${mateMark === false ? "on" : ""}" data-action="mark" data-id="${CLASSMATE}" data-value="0" aria-label="5th grader wrong">✗</button>
            <span class="chip-note small">for Copy &amp; Save</span>
          </div>
        </div>`
      : "";

  return `<main class="screen question ${million ? "million" : ""}">
    <header class="q-header">
      <div class="q-title">${header}${!million && state.classmate ? `<div class="q-mate">🎒 5th grader: ${esc(classmateName())}</div>` : ""}</div>
      ${done ? "" : `<div class="q-stake"><span>Playing for</span>${stake}</div>`}
    </header>
    <section class="chalkboard ${String(q.question).length > 80 || (q.choices || []).length > 4 ? "dense" : ""}">
      <div class="q-text">${esc(q.question)}</div>
      ${choices}
      ${renderMedia(q, revealed)}
      ${answerBlock}
    </section>
    ${done ? "" : `<section class="chips">${mateChip}${chips}</section>
    <footer class="q-footer">
      <div class="row left">
        ${!revealed && !million ? `<button class="btn btn-ghost" data-action="backToBoard">← Board (Esc)</button>` : ""}
        ${aud.on ? audSlot("strip") : ""}
      </div>
      ${
        revealed
          ? `<div class="row">
              <button class="btn btn-ghost small" data-action="markAll" data-value="1">Everyone ✓</button>
              <button class="btn btn-ghost small" data-action="markAll" data-value="0">Everyone ✗</button>
              <button class="btn btn-red" data-action="continue" ${ready ? "" : "disabled"}>${ready ? "Continue (Space)" : "Mark everyone"}</button>
            </div>`
          : `<button class="btn btn-yellow" data-action="reveal">Pencils down — reveal (Space)</button>`
      }
    </footer>`}
  </main>`;
}

function renderMillionIntro() {
  const m = state.game.million;
  const players = stillIn();
  return `<main class="screen million-intro">
    <div class="million-badge">${money(LADDER[10])}</div>
    <h1>The ${money(LADDER[10])} Question</h1>
    <p class="million-subject">Subject: <b>${esc(m.subject || "Mystery")}</b></p>
    <p class="muted">No cheats and no walking away. Get it right for ${money(LADDER[10])}. Get it wrong and you leave with ${money(SAFE_AMOUNT)}.</p>
    <div class="decisions">
      ${players.map((p) => `<div class="decision"><span class="chip-name">${esc(p.name)}</span><span class="tag">${money(bankOf(p))} on the line</span></div>`).join("")}
    </div>
    <button class="btn btn-yellow" data-action="startMillion">Show the question (Space)</button>
  </main>`;
}

function ranked() {
  return [...state.players].sort((a, b) => b.bank - a.bank || b.correct - a.correct);
}

function renderResults() {
  const list = ranked();
  const top = list[0];
  const winners = top ? list.filter((p) => p.bank === top.bank && p.correct === top.correct) : [];
  const smarter = list.filter((p) => p.status === "millionaire");
  const headline = winners.length > 1 ? `${winners.map((p) => esc(p.name)).join(" & ")} tie!` : top ? `${esc(top.name)} wins!` : "Class dismissed";
  return `<main class="screen results">
    ${logo(true)}
    <h1 class="headline">${headline}</h1>
    ${smarter.length ? `<p class="smarter">${smarter.map((p) => esc(p.name)).join(" & ")} ${smarter.length > 1 ? "are" : "is"} smarter than a former 5th grader!</p>` : ""}
    <ol class="final">
      ${list
        .map(
          (p, i) => `<li class="${winners.includes(p) ? "win" : ""}">
            <span class="place">${i + 1}</span>
            <span class="final-name">${esc(p.name)}</span>
            <span class="final-bank">${money(p.bank)}</span>
            <span class="final-correct">✓ ${p.correct}</span>
          </li>`
        )
        .join("")}
    </ol>
    <p class="muted small">Ranked by money banked, then by total correct answers.</p>
    ${aud.on ? audSlot("final") : ""}
    <div class="row">
      <button class="btn btn-ghost" data-action="backToLoader">Pick another episode</button>
      <button class="btn btn-red" data-action="newGame">Play this episode again</button>
    </div>
  </main>`;
}

function renderOverlay() {
  const o = state.overlay;
  if (!o) return "";
  if (o.type === "flunk") {
    const n = o.names.map(esc);
    const names = n.length > 1 ? `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}` : n[0];
    return `<div class="overlay flunk">
      <div class="overlay-card">
        <div class="flunk-f">F</div>
        <h2>${names} flunked out!</h2>
        <p>The answer was <b>${esc(state.lastAnswer)}</b>.</p>
        <p class="say-it">Now say it to the audience:<br/><span>“I am not smarter than a former 5th grader!”</span></p>
        <button class="btn btn-yellow" data-action="closeOverlay">Continue (Space)</button>
      </div>
    </div>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Audience play-along
// ---------------------------------------------------------------------------

// What the phones should see right now: the question on screen, or nothing.
function audienceQuestion() {
  const c = state.current;
  if (state.screen !== "question" || !c) return null;
  const million = c.kind === "million";
  return {
    pid: `${state.runId}:${million ? "m" : c.tile}`,
    open: c.phase === "asking",
    revealed: c.phase !== "asking",
    q: currentQuestion(),
    million,
  };
}

// Audience bits live in their own slots so a phone joining or answering only redraws
// them, not the whole screen (which would restart a video or close the keyboard).
const AUD_SLOTS = {
  setup: audSetupCard,
  pickerAud: audPickerList,
  corner: audCorner,
  boardLb: audBoardLeaderboard,
  strip: audStrip,
  final: audFinal,
  overlay: audOverlay,
};

function audSlot(name) {
  return `<div class="aud-slot aud-slot-${name}" data-aud="${name}">${AUD_SLOTS[name]()}</div>`;
}

let renderedAudOn = false;

// Called whenever the play-along changes. Turning it on or off changes the layout, so that
// redraws everything; anything else just refreshes the audience slots.
function onAudienceChange() {
  if (aud.on !== renderedAudOn) return render();
  updateAudience();
}

function updateAudience() {
  for (const el of document.querySelectorAll("[data-aud]")) {
    const html = AUD_SLOTS[el.dataset.aud]();
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

const qrCache = new Map();
function qrSvg(text) {
  if (qrCache.has(text)) return qrCache.get(text);
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  const svg = `<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges" aria-label="QR code"><rect width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  qrCache.set(text, svg);
  return svg;
}

const audStatusText = () =>
  ({ connecting: "Connecting…", live: "Live", down: "Reconnecting…", error: "Couldn't connect", off: "Off" })[aud.status] || aud.status;
const pts = (n) => Number(n).toLocaleString("en-US");

function audSetupCard() {
  if (!aud.on) {
    return `<div class="aud-card">
      <div class="aud-info">
        <h3>📱 Audience play-along</h3>
        <p class="small">Everyone who isn't playing can answer along on their phone. The faster they lock in a right answer, the more points (up to ${pts(MAX_POINTS)}), and a leaderboard runs all game.</p>
        ${aud.status === "error" ? `<p class="error">${esc(aud.error)}</p>` : ""}
      </div>
      <button class="btn btn-yellow" data-action="audOn">Turn on play-along</button>
    </div>`;
  }
  const rows = audStandings();
  return `<div class="aud-card on">
    <div class="aud-qr">${aud.code && aud.status !== "connecting" ? qrSvg(joinUrl()) : ""}</div>
    <div class="aud-info">
      <h3>📱 Audience play-along <span class="aud-pill ${aud.status}">${audStatusText()}</span></h3>
      ${
        aud.code
          ? `<p class="aud-code">Room <strong>${esc(aud.code)}</strong></p><p class="small">Scan the code or go to <b>${esc(shortUrl())}</b></p>`
          : `<p class="small">Opening a room…</p>`
      }
      ${aud.status === "error" ? `<p class="error">${esc(aud.error)}</p>` : ""}
      <p class="aud-names">${rows.length ? `${rows.length} joined: ${rows.map((r) => esc(r.name)).join(", ")}` : "Nobody's joined yet."}</p>
      <div class="row left">
        <button class="btn btn-ghost small" data-action="audReset" ${rows.some((r) => r.pts) ? "" : "disabled"}>Reset scores</button>
        <button class="btn btn-ghost small" data-action="audNewRoom">New room code</button>
        <button class="btn btn-ghost small" data-action="audOff">Turn off</button>
      </div>
    </div>
  </div>`;
}

// The room code in the corner of every game screen, so people can join any time.
function audCorner() {
  if (!aud.on || !["board", "question", "millionIntro"].includes(state.screen)) return "";
  const n = playerCount();
  return `<button class="aud-corner" data-action="audBoard" title="Show the play-along leaderboard (0)">
    <span class="aud-dot ${aud.status}"></span> 📱 Play along: <b>${esc(aud.code || "…")}</b>
    <span class="aud-corner-url">${esc(aud.code ? shortUrl() : "")}</span>
    <span class="aud-corner-n">${n} playing</span>
  </button>`;
}

const subjectTags = (r) =>
  r.subjects.length ? `<span class="lb-subj">${r.subjects.map((x) => `<span>${esc(x)}</span>`).join("")}</span>` : "";

const record = (r) => (r.answered ? `${r.right}/${r.answered} right` : "");

function lbRows(rows, max) {
  return rows
    .slice(0, max)
    .map(
      (r) => `<li><span class="lb-rank">${r.rank}</span><span class="lb-name">${esc(r.name)}${subjectTags(r)}</span><b>${pts(r.pts)}</b></li>`
    )
    .join("");
}

// In the 5th grader picker: the play-along crowd, best first, with what they're good at.
function audPickerList() {
  const rows = audStandings();
  if (!rows.length) return "";
  const went = (name) => state.pastClassmates.includes(name);
  return `<div class="picker-aud">
    <h3>📱 From the play-along</h3>
    <ul>${rows
      .map(
        (r) => `<li><button class="aud-pick ${went(r.name) ? "went" : ""}" data-action="pickClassmate" data-name="${esc(r.name)}">
          <span class="lb-rank">${r.rank}</span>
          <span class="aud-pick-name">${esc(r.name)}${went(r.name) ? ` <em>already went</em>` : ""}${subjectTags(r)}</span>
          <span class="aud-pick-score"><b>${pts(r.pts)}</b><small>${record(r)}</small></span>
        </button></li>`
      )
      .join("")}</ul>
  </div>`;
}

function audBoardLeaderboard() {
  if (!aud.on) return "";
  const rows = audStandings();
  return `<div class="aud-lb">
    <h3>📱 Play-along</h3>
    ${
      rows.length
        ? `<ol class="lb">${lbRows(rows, 6)}</ol>${rows.length > 6 ? `<p class="small">+${rows.length - 6} more · press 0 for the top 10</p>` : ""}`
        : `<p class="small">Nobody yet. Join with room <b>${esc(aud.code || "…")}</b>.</p>`
    }
  </div>`;
}

// Under the question: how many phones have answered, and after the reveal, how they did.
function audStrip() {
  const pid = currentPid();
  if (!aud.on || !pid) return "";
  const st = questionStats(pid);
  const n = playerCount();
  if (!isRevealed(pid)) {
    return `<span class="aud-strip">📱 ${st.answered} of ${n} locked in</span>`;
  }
  return `<span class="aud-strip">📱 ${st.right} of ${st.answered} right${
    st.fastest ? ` · fastest: <b>${esc(st.fastest.name)}</b> +${pts(st.fastest.pts)}` : ""
  }</span>${st.answered ? `<button class="btn btn-ghost small" data-action="audReview">Check answers</button>` : ""}`;
}

function audFinal() {
  const rows = audStandings();
  if (!rows.length) return "";
  return `<div class="aud-final"><h3>📱 Play-along leaderboard</h3><ol class="lb">${lbRows(rows, 10)}</ol></div>`;
}

function audOverlay() {
  if (!aud.on) return "";
  if (aud.review && currentPid() && isRevealed(currentPid())) {
    const groups = answerGroups();
    return `<div class="overlay aud-overlay">
      <div class="overlay-card aud-review">
        <h2>📱 Play-along answers</h2>
        <p class="muted-ink">Tap an answer to flip it between right and wrong. Everyone who gave that answer changes together.</p>
        <ul class="aud-groups">
          ${groups
            .map(
              (g) => `<li><button class="aud-group ${g.ok ? "ok" : "no"}" data-action="audFlip" data-key="${esc(g.key)}">
                <span class="mark-ico">${g.ok ? "✓" : "✗"}</span><span class="aud-group-text">${esc(g.text)}</span><span class="aud-group-n">×${g.count}</span>
              </button></li>`
            )
            .join("")}
        </ul>
        <button class="btn btn-yellow" data-action="audClose">Done (Esc)</button>
      </div>
    </div>`;
  }
  if (aud.board) {
    const rows = audStandings();
    return `<div class="overlay aud-overlay">
      <div class="overlay-card aud-big">
        <div class="aud-big-lb">
          <h2>📱 Play-along leaderboard</h2>
          ${rows.length ? `<ol class="lb big">${lbRows(rows, 10)}</ol>` : `<p class="muted-ink">Nobody's joined yet.</p>`}
          <p class="small muted-ink">Right answers score ${pts(MAX_POINTS)} down to ${pts(MIN_POINTS)}, faster is better (over ${DROP_MS / 1000} seconds).</p>
        </div>
        <div class="aud-big-join">
          ${aud.code ? qrSvg(joinUrl()) : ""}
          <p>Room <strong>${esc(aud.code || "…")}</strong></p>
          <p class="small">${esc(aud.code ? shortUrl() : "")}</p>
        </div>
        <button class="btn btn-yellow" data-action="audClose">Close (0)</button>
      </div>
    </div>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  e.preventDefault();
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset);
});

document.addEventListener("change", async (e) => {
  if (e.target.id !== "file-input" || !e.target.files?.[0]) return;
  try {
    const game = validateGame(JSON.parse(await e.target.files[0].text()));
    startSetup(game, null);
  } catch (err) {
    alert(`Couldn't load that file: ${err.message}`);
  }
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
  if (typing) {
    if (e.key === "Enter" && e.target.id === "player-name") {
      e.preventDefault();
      actions.addPlayer();
    }
    if (e.key === "Enter" && e.target.id === "other-classmate") {
      e.preventDefault();
      actions.pickClassmate({});
    }
    return;
  }
  if (e.key === "m" || e.key === "M") {
    actions.toggleMute();
    return;
  }
  if (e.key === "0" && aud.on) return actions.audBoard();
  if ((aud.board || aud.review) && (e.key === "Escape" || e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    return actions.audClose();
  }
  if (e.key === "Escape") {
    if (state.screen === "question") actions.backToBoard();
    return;
  }
  if (e.key === " " || e.key === "Enter") {
    if (e.target.tagName === "BUTTON" && e.key === "Enter") return;
    e.preventDefault();
    const o = state.overlay;
    if (o?.type === "flunk") return actions.closeOverlay();
    if (state.screen === "setup") return actions.startGame();
    if (state.screen === "question") return state.current.phase === "asking" ? actions.reveal() : actions.continue();
    if (state.screen === "millionIntro") return actions.startMillion();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  setOnChange(onAudienceChange);
  if (loadAudience()) startAudience();
  try {
    const res = await fetch("games/index.json", { cache: "no-cache" });
    gameList = res.ok ? await res.json() : [];
  } catch {
    gameList = [];
  }
  const id = new URLSearchParams(location.search).get("game");
  // A refresh mid-game shows the Resume button instead of starting over.
  if (id && !savedGame()) {
    try {
      await loadGameById(id);
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  render();
}

init();
