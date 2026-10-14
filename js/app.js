import { playSound, stopSound, toggleMute, isMuted, mediaUrl } from "./sounds.js";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Bank after 1, 2, 3 ... 10 correct answers, then the million-dollar question.
const LADDER = [1000, 2000, 5000, 10000, 25000, 50000, 100000, 175000, 300000, 500000, 1000000];
const SAFE_LEVEL = 5; // after 5 correct answers, $25,000 is guaranteed
const SAFE_AMOUNT = 25000;
const WALK_AWAY_AMOUNT = 500000; // what you keep if you skip the million question
const CHEATS = {
  peek: { label: "Peek", icon: "👀", tip: "Secretly see your classmate's answer" },
  copy: { label: "Copy", icon: "📝", tip: "Lock in your classmate's answer" },
  save: { label: "Save", icon: "🛟", tip: "If you're wrong but your classmate is right, you're saved" },
};
const STORE_KEY = "smarter5th.state.v1";

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
    used: [],
    asked: 0,
    current: null,
    overlay: null,
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
  if (c.kind === "million") return p.goForIt === true;
  return !c.drops.includes(p.id);
}

// The result that counts for a live player, after cheats.
function liveResult(p) {
  const c = state.current;
  const q = currentQuestion();
  const mate = q.classmate;
  const cheat = c.cheats[p.id];
  if (cheat === "copy" && mate) return !!mate.correct;
  const mark = c.marks[p.id];
  if (mark === undefined) return undefined;
  if (!mark && cheat === "save" && mate && mate.correct) return true;
  return mark;
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
    goForIt: null,
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
    state = s;
    state.overlay = null;
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
    if (state.used[i]) return;
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
    const q = currentQuestion();
    if (!q.classmate) {
      alert("This question has no classmate answer, so cheats can't be used on it.");
      return;
    }
    if (c.cheats[id] === cheat) {
      // Undo (except Peek, which can't be un-seen).
      if (cheat === "peek") return;
      p.cheats[cheat] = true;
      delete c.cheats[id];
    } else {
      if (c.cheats[id] || !p.cheats[cheat]) return; // one cheat per question
      p.cheats[cheat] = false;
      c.cheats[id] = cheat;
      if (cheat === "peek") state.overlay = { type: "peek", id, shown: false };
    }
    render();
  },
  showPeek: () => {
    if (state.overlay?.type === "peek") state.overlay.shown = true;
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
    playSound(value === "1" ? "correct" : "wrong");
    render();
  },
  markAll: ({ value }) => {
    const c = state.current;
    for (const p of participants()) {
      if (!(playerIsLive(p) && c.cheats[p.id] === "copy")) c.marks[p.id] = value === "1";
    }
    playSound(value === "1" ? "correct" : "wrong");
    render();
  },
  continue: () => finishQuestion(),

  setGoForIt: ({ id, value }) => {
    const p = playerById(id);
    p.goForIt = value === "1";
    render();
  },
  startMillion: () => {
    const players = stillIn();
    if (players.some((p) => p.goForIt === null)) return;
    for (const p of players) {
      if (!p.goForIt) {
        p.status = "dropped";
        p.bank = WALK_AWAY_AMOUNT;
      }
    }
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
  cancelPeek: () => {
    const o = state.overlay;
    if (o?.type !== "peek" || o.shown) return;
    playerById(o.id).cheats.peek = true;
    delete state.current.cheats[o.id];
    state.overlay = null;
    render();
  },
  toggleMute: () => {
    toggleMute();
    render();
  },
};

function finishQuestion() {
  const c = state.current;
  if (c.phase !== "revealed") return;
  const q = currentQuestion();
  const parts = participants();
  const unmarked = parts.filter((p) => (playerIsLive(p) ? liveResult(p) : c.marks[p.id]) === undefined);
  if (unmarked.length) return;

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
      stillIn().forEach((p) => (p.goForIt = null));
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
  app.innerHTML = screens[state.screen]() + renderOverlay() + renderMute();
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
    <span class="logo-than">Than a</span>
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
          <li>Each player gets one <b>Peek</b>, one <b>Copy</b> and one <b>Save</b> (one per question) using the 5th-grade classmate's answer.</li>
          <li>Survive all ${g.questions.length} and you can go for ${money(LADDER[10])} — or walk away with ${money(WALK_AWAY_AMOUNT)}.</li>
          <li>Players who are out keep answering for bragging rights: most correct answers breaks ties.</li>
        </ul>
      </details>
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
      </div>
      <button class="btn btn-ghost small" data-action="endGame">End game</button>
    </header>
    ${nobodyIn ? `<div class="banner">Everyone is out of the money. The rest of the board is for bragging rights — most correct answers breaks the tie.</div>` : ""}
    <div class="board-layout">
      <div class="tiles">
        ${qs
          .map(
            (q, i) => `<button class="tile grade-${Math.min(Math.max(q.grade || 1, 1), 5)} ${state.used[i] ? "used" : ""}" data-action="openTile" data-tile="${i}" ${state.used[i] ? "disabled" : ""}>
              <span class="tile-grade">${q.grade ? gradeName(q.grade) : ""}</span>
              <span class="tile-subject">${esc(q.subject || `Question ${i + 1}`)}</span>
            </button>`
          )
          .join("")}
      </div>
      ${renderLadder()}
    </div>
    ${renderScoreboard()}
  </main>`;
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
  const mate = q.classmate;
  const answerBlock = revealed
    ? `<div class="answer">
        <div class="answer-label">Answer</div>
        <div class="answer-text">${esc(q.answer)}</div>
        ${q.note ? `<div class="answer-note">${esc(q.note)}</div>` : ""}
        ${mate && !million ? `<div class="classmate ${mate.correct ? "right" : "wrong"}"><b>${esc(mate.name || "Classmate")}</b> wrote: “${esc(mate.answer)}” ${mate.correct ? "✓" : "✗"}</div>` : ""}
      </div>`
    : "";

  const parts = participants();
  const allMarked = parts.every((p) => (playerIsLive(p) ? liveResult(p) : c.marks[p.id]) !== undefined);

  const chips = parts
    .map((p) => {
      const isLive = playerIsLive(p);
      const dropping = c.drops.includes(p.id);
      const cheat = c.cheats[p.id];
      let controls = "";
      if (!revealed) {
        if (p.status === "in" && !million) {
          const cheatBtns = Object.entries(CHEATS)
            .map(([k, v]) => {
              const active = cheat === k;
              const disabled = dropping || (!active && (cheat || !p.cheats[k])) || !mate;
              return `<button class="chip-btn ${active ? "active" : ""}" title="${v.tip}" data-action="useCheat" data-id="${p.id}" data-cheat="${k}" ${disabled ? "disabled" : ""}>${v.icon} ${v.label}</button>`;
            })
            .join("");
          controls = `${cheatBtns}<button class="chip-btn drop ${dropping ? "active" : ""}" data-action="toggleDrop" data-id="${p.id}">${dropping ? `Dropping out · ${money(levelValue(p.level))}` : "Drop out"}</button>`;
        } else if (!isLive) {
          controls = `<span class="chip-note">${p.status === "in" ? "walked away" : "bragging rights"}</span>`;
        } else {
          controls = `<span class="chip-note">going for it</span>`;
        }
      } else {
        const result = isLive ? liveResult(p) : c.marks[p.id];
        if (isLive && cheat === "copy" && mate) {
          controls = `<span class="chip-note">copied ${esc(mate.name || "classmate")} → ${result ? "✓ right" : "✗ wrong"}</span>`;
        } else {
          const savedNote =
            isLive && cheat === "save" && c.marks[p.id] === false
              ? mate && mate.correct
                ? `<span class="chip-note saved">🛟 saved!</span>`
                : `<span class="chip-note">🛟 save failed</span>`
              : "";
          controls = `<button class="mark yes ${c.marks[p.id] === true ? "on" : ""}" data-action="mark" data-id="${p.id}" data-value="1" aria-label="Correct">✓</button>
            <button class="mark no ${c.marks[p.id] === false ? "on" : ""}" data-action="mark" data-id="${p.id}" data-value="0" aria-label="Wrong">✗</button>${savedNote}`;
        }
        if (!isLive) controls += `<span class="chip-note small">for bragging rights</span>`;
      }
      const cheatTag = cheat ? `<span class="tag">${CHEATS[cheat].icon} ${CHEATS[cheat].label}</span>` : "";
      return `<div class="chip ${isLive ? "live" : "bystander"} ${dropping ? "dropping" : ""}">
        <div class="chip-head"><span class="chip-name">${esc(p.name)}</span>${cheatTag}<span class="chip-bank">${money(bankOf(p))}</span></div>
        <div class="chip-controls">${controls}</div>
      </div>`;
    })
    .join("");

  return `<main class="screen question ${million ? "million" : ""}">
    <header class="q-header">
      <div class="q-title">${header}</div>
      ${done ? "" : `<div class="q-stake"><span>Playing for</span>${stake}</div>`}
    </header>
    <section class="chalkboard">
      <div class="q-text">${esc(q.question)}</div>
      ${choices}
      ${renderMedia(q, revealed)}
      ${answerBlock}
    </section>
    ${done ? "" : `<section class="chips">${chips}</section>
    <footer class="q-footer">
      ${!revealed && !million ? `<button class="btn btn-ghost" data-action="backToBoard">← Board (Esc)</button>` : "<span></span>"}
      ${
        revealed
          ? `<div class="row">
              <button class="btn btn-ghost small" data-action="markAll" data-value="1">Everyone ✓</button>
              <button class="btn btn-ghost small" data-action="markAll" data-value="0">Everyone ✗</button>
              <button class="btn btn-red" data-action="continue" ${allMarked ? "" : "disabled"}>${allMarked ? "Continue (Space)" : "Mark everyone"}</button>
            </div>`
          : `<button class="btn btn-yellow" data-action="reveal">Pencils down — reveal (Space)</button>`
      }
    </footer>`}
  </main>`;
}

function renderMillionIntro() {
  const m = state.game.million;
  const players = stillIn();
  const ready = players.every((p) => p.goForIt !== null);
  return `<main class="screen million-intro">
    <div class="million-badge">${money(LADDER[10])}</div>
    <h1>The ${money(LADDER[10])} Question</h1>
    <p class="million-subject">Subject: <b>${esc(m.subject || "Mystery")}</b></p>
    <p class="muted">No cheats. Get it right for ${money(LADDER[10])}. Get it wrong and you leave with ${money(SAFE_AMOUNT)}. Or walk away now with ${money(WALK_AWAY_AMOUNT)}.</p>
    <div class="decisions">
      ${players
        .map(
          (p) => `<div class="decision">
            <span class="chip-name">${esc(p.name)}</span>
            <button class="chip-btn ${p.goForIt === true ? "active" : ""}" data-action="setGoForIt" data-id="${p.id}" data-value="1">Go for it</button>
            <button class="chip-btn ${p.goForIt === false ? "active" : ""}" data-action="setGoForIt" data-id="${p.id}" data-value="0">Walk away · ${money(WALK_AWAY_AMOUNT)}</button>
          </div>`
        )
        .join("")}
    </div>
    <button class="btn btn-yellow" data-action="startMillion" ${ready ? "" : "disabled"}>${ready ? "Show the question" : "Everyone decide"}</button>
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
    ${smarter.length ? `<p class="smarter">${smarter.map((p) => esc(p.name)).join(" & ")} ${smarter.length > 1 ? "are" : "is"} smarter than a 5th grader!</p>` : ""}
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
    <div class="row">
      <button class="btn btn-ghost" data-action="backToLoader">Pick another episode</button>
      <button class="btn btn-red" data-action="newGame">Play this episode again</button>
    </div>
  </main>`;
}

function renderOverlay() {
  const o = state.overlay;
  if (!o) return "";
  if (o.type === "peek") {
    const p = playerById(o.id);
    const mate = currentQuestion().classmate;
    return `<div class="overlay">
      <div class="overlay-card">
        ${
          o.shown
            ? `<p class="eyebrow">${esc(mate.name || "Your classmate")} wrote</p>
               <div class="peek-answer">${esc(mate.answer)}</div>
               <button class="btn btn-red" data-action="closeOverlay">Hide it</button>`
            : `<div class="peek-eyes">👀</div>
               <h2>Everyone except ${esc(p.name)}, look away!</h2>
               <button class="btn btn-yellow" data-action="showPeek">Show ${esc(p.name)}</button>
               <button class="btn btn-ghost small" data-action="cancelPeek">Never mind</button>`
        }
      </div>
    </div>`;
  }
  if (o.type === "flunk") {
    const n = o.names.map(esc);
    const names = n.length > 1 ? `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}` : n[0];
    return `<div class="overlay flunk">
      <div class="overlay-card">
        <div class="flunk-f">F</div>
        <h2>${names} flunked out!</h2>
        <p>The answer was <b>${esc(state.lastAnswer)}</b>.</p>
        <p class="say-it">Now say it to the camera:<br/><span>“I am not smarter than a 5th grader!”</span></p>
        <button class="btn btn-yellow" data-action="closeOverlay">Continue (Space)</button>
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
    return;
  }
  if (e.key === "m" || e.key === "M") {
    actions.toggleMute();
    return;
  }
  if (e.key === "Escape") {
    if (state.overlay?.type === "peek") state.overlay.shown ? actions.closeOverlay() : actions.cancelPeek();
    else if (state.screen === "question") actions.backToBoard();
    return;
  }
  if (e.key === " " || e.key === "Enter") {
    if (e.target.tagName === "BUTTON" && e.key === "Enter") return;
    e.preventDefault();
    const o = state.overlay;
    if (o?.type === "flunk") return actions.closeOverlay();
    if (o?.type === "peek") return o.shown ? actions.closeOverlay() : actions.showPeek();
    if (state.screen === "setup") return actions.startGame();
    if (state.screen === "question") return state.current.phase === "asking" ? actions.reveal() : actions.continue();
    if (state.screen === "millionIntro") return actions.startMillion();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
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
