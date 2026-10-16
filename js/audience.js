// Audience play-along, host side.
//
// Works like the Wheel of Fortune play-along: phones and this tab talk through a free
// public relay, and this tab is the referee. Each phone sees the question (never the
// answer) and locks in one answer per question. This tab checks it and scores it on the
// spot: the faster a right answer comes in, the more it's worth. Results stay hidden until
// the answer is revealed on the TV.

import { Relay, connectAny, brokerFor, makeCode, TOPIC_ROOT } from "./relay.js?v=__V__";

const STORE_KEY = "smarter5th.audience.v1";
export const MAX_POINTS = 1000;
export const MIN_POINTS = 100;
export const DROP_MS = 30000; // a right answer loses value over this long, then stays at MIN_POINTS
const ACTIVE_MS = 70000; // a phone counts as here if it checked in this recently

// Subjects people can say they're best at, in the spirit of the show's categories.
export const SUBJECTS = [
  "Math",
  "Measurement & Time",
  "Geometry & Shapes",
  "Grammar",
  "Spelling & Vocabulary",
  "Reading & Literature",
  "Animals & Life Science",
  "Earth Science",
  "Space Science",
  "Physical Science",
  "Human Body & Health",
  "U.S. History",
  "World History",
  "Geography",
  "Government & Civics",
  "Art & Music",
];

// Up to two known subjects, no repeats.
export function cleanSubjects(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => SUBJECTS.includes(x)))].slice(0, 2);
}

export const aud = {
  on: false,
  status: "off", // off | connecting | live | down | error
  error: "",
  code: null,
  players: {}, // id -> { name, seen }
  books: {}, // pid -> { id -> { text, key, sp, ok } }
  opened: {}, // pid -> when the question first appeared (host clock)
  revealed: [], // pids whose answers have been revealed
  board: false, // full-screen leaderboard showing
  review: false, // answer review panel showing
};

let relay = null;
let topic = "";
let current = null; // { pid, open, revealed, q, million }
let onChange = () => {};
let lastSent = "";
let sendTimer = null;

export function setOnChange(fn) {
  onChange = fn;
}

function save() {
  try {
    const { on, code, players, books, opened, revealed } = aud;
    localStorage.setItem(STORE_KEY, JSON.stringify({ on, code, players, books, opened, revealed }));
  } catch {
    /* storage unavailable */
  }
}

export function loadAudience() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s)
      Object.assign(aud, {
        on: !!s.on,
        code: s.code || null,
        players: s.players || {},
        books: s.books || {},
        opened: s.opened || {},
        revealed: s.revealed || [],
      });
  } catch {
    /* fresh start */
  }
  return aud.on;
}

export function joinUrl() {
  const base = location.href.split(/[?#]/)[0].replace(/index\.html$/, "").replace(/\/?$/, "/");
  const extra = new URLSearchParams(location.search).get("broker");
  return `${base}play/?code=${aud.code}${extra ? `&broker=${encodeURIComponent(extra)}` : ""}`;
}

export function shortUrl() {
  return joinUrl()
    .replace(/^https?:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Checking answers
// ---------------------------------------------------------------------------

function words(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

// What two answers are compared on: lowercase letters and digits only.
export const answerKey = (s) => words(s).replace(/ /g, "");

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Is this answer right? Multiple choice must match exactly. Numbers just need the right
// number somewhere ("210 minutes" is fine). Longer words forgive a typo or two. "needs"
// lists words that all have to appear, in any order. The host can flip any answer later.
export function checkAnswer(q, text) {
  const guess = answerKey(text);
  if (!guess) return false;
  const answers = [q.answer, ...(q.accept || [])].map(answerKey).filter(Boolean);
  if (Array.isArray(q.choices)) return answers.includes(guess);
  if (Array.isArray(q.needs) && q.needs.length) {
    return q.needs.every((w) => guess.includes(answerKey(w)));
  }
  for (const a of answers) {
    if (/^\d+$/.test(a)) {
      const n = String(text).replace(/(\d),(\d)/g, "$1$2").match(/\d+/);
      if (n && n[0] === a) return true;
      continue;
    }
    if (guess === a) return true;
    if (a.length >= 5 && editDistance(guess, a) <= Math.floor(a.length / 6)) return true;
  }
  return false;
}

// Points for a right answer that came in this long after the question appeared.
export function speedPoints(ms) {
  const share = Math.min(1, Math.max(0, ms) / DROP_MS);
  return Math.max(MIN_POINTS, Math.round((MAX_POINTS - (MAX_POINTS - MIN_POINTS) * share) / 10) * 10);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function startAudience() {
  if (relay) return;
  aud.on = true;
  aud.status = "connecting";
  aud.error = "";
  save();
  onChange();
  const handlers = {
    onMessage: (t, m) => handle(m),
    onStatus: (s) => {
      if (!aud.on) return;
      aud.status = s === "live" ? "live" : s === "down" ? "down" : "connecting";
      if (s === "live") lastSent = ""; // make sure phones get the latest after a reconnect
      onChange();
      if (s === "live") publishSoon();
    },
  };
  try {
    const existing = aud.code && brokerFor(aud.code);
    if (existing) {
      relay = new Relay(existing.url, handlers);
      await relay.connect(10000).catch(async () => {
        // That relay is down; open a new room somewhere else.
        relay = null;
        const r = await connectAny(handlers);
        relay = r.relay;
        aud.code = makeCode(r.broker.key);
      });
    } else {
      const r = await connectAny(handlers);
      relay = r.relay;
      aud.code = makeCode(r.broker.key);
    }
    topic = TOPIC_ROOT + aud.code;
    relay.subscribe(topic + "/h");
    aud.status = "live";
    save();
    lastSent = "";
    publishSoon();
  } catch {
    relay = null;
    aud.status = "error";
    aud.error = "Couldn't reach any of the free relays. Check the internet connection and try again.";
  }
  onChange();
}

export function stopAudience() {
  aud.on = false;
  aud.status = "off";
  aud.board = false;
  aud.review = false;
  if (relay) {
    relay.publish(topic + "/s", { v: 1, closed: true }, true); // tell phones the room is closed
    const r = relay;
    setTimeout(() => r.close(), 400);
  }
  relay = null;
  save();
  onChange();
}

// A brand new room code (phones have to join again). Scores are kept.
export function newRoom() {
  const wasOn = aud.on;
  stopAudience();
  aud.code = null;
  save();
  if (wasOn) startAudience();
}

export function resetScores() {
  aud.books = {};
  aud.opened = {};
  aud.revealed = [];
  save();
  lastSent = "";
  publishSoon();
  onChange();
}

// ---------------------------------------------------------------------------
// Messages from phones
// ---------------------------------------------------------------------------

function handle(m) {
  if (!m || typeof m.id !== "string" || m.id.length > 40) return;
  const now = Date.now();
  if (m.t === "join") {
    const name = String(m.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
    if (!name) return;
    const known = aud.players[m.id];
    const subjects = cleanSubjects(m.subj);
    aud.players[m.id] = { name, seen: now, subjects };
    if (!known || known.name !== name || (known.subjects || []).join("|") !== subjects.join("|")) {
      save();
      onChange();
    }
    publishSoon();
  } else if (m.t === "answer") {
    const p = aud.players[m.id];
    if (!p) return;
    p.seen = now;
    const c = current;
    if (!c || !c.open || m.pid !== c.pid) return publishSoon();
    const book = (aud.books[c.pid] ||= {});
    if (book[m.id]) return publishSoon(); // one answer each
    const text = String(m.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!text) return;
    const sp = speedPoints(now - (aud.opened[c.pid] || now));
    book[m.id] = { text, key: answerKey(text), sp, ok: checkAnswer(c.q, text) };
    save();
    onChange();
    publishSoon();
  }
}

// The host thinks a group of answers was marked wrong (or right) by mistake.
export function flipAnswers(key) {
  const c = current;
  if (!c) return;
  const book = aud.books[c.pid] || {};
  const group = Object.values(book).filter((g) => g.key === key);
  if (!group.length) return;
  const ok = !group[0].ok;
  for (const g of group) g.ok = ok;
  save();
  lastSent = "";
  publishSoon();
  onChange();
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

const pointsFor = (g) => (g.ok ? g.sp : 0);

export function scores() {
  const total = {};
  for (const id of Object.keys(aud.players)) total[id] = 0;
  for (const pid of aud.revealed) {
    for (const [id, g] of Object.entries(aud.books[pid] || {})) total[id] = (total[id] || 0) + pointsFor(g);
  }
  return total;
}

// How many revealed questions each person answered, and how many they got right.
function records() {
  const out = {};
  for (const pid of aud.revealed) {
    for (const [id, g] of Object.entries(aud.books[pid] || {})) {
      const r = (out[id] ||= { answered: 0, right: 0 });
      r.answered++;
      if (g.ok) r.right++;
    }
  }
  return out;
}

// Players sorted by score, with shared ranks for ties.
export function standings() {
  const total = scores();
  const rec = records();
  const rows = Object.entries(aud.players)
    .map(([id, p]) => ({
      id,
      name: p.name,
      pts: total[id] || 0,
      subjects: p.subjects || [],
      right: rec[id]?.right || 0,
      answered: rec[id]?.answered || 0,
    }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
  let rank = 0;
  let prev = null;
  rows.forEach((r, i) => {
    if (r.pts !== prev) rank = i + 1;
    prev = r.pts;
    r.rank = rank;
  });
  return rows;
}

export const playerCount = () => Object.keys(aud.players).length;
export const activeCount = () => Object.values(aud.players).filter((p) => Date.now() - p.seen < ACTIVE_MS).length;

// How a question went: how many answered, how many right, the fastest right answer.
export function questionStats(pid = current?.pid) {
  const list = Object.entries(aud.books[pid] || {});
  const right = list.filter(([, g]) => g.ok).sort((a, b) => b[1].sp - a[1].sp);
  const best = right[0];
  return {
    answered: list.length,
    right: right.length,
    fastest: best ? { name: aud.players[best[0]]?.name || "?", pts: best[1].sp } : null,
  };
}

// The current question's answers, grouped, for the host's review panel.
export function answerGroups() {
  const book = aud.books[current?.pid] || {};
  const groups = new Map();
  for (const g of Object.values(book)) {
    const k = g.key;
    if (!groups.has(k)) groups.set(k, { key: k, text: g.text, ok: g.ok, count: 0 });
    groups.get(k).count++;
  }
  return [...groups.values()].sort((a, b) => b.ok - a.ok || b.count - a.count);
}

export const currentPid = () => current?.pid || null;
export const isRevealed = (pid) => aud.revealed.includes(pid);

// ---------------------------------------------------------------------------
// Keeping up with the game
// ---------------------------------------------------------------------------

// Called on every redraw with the question on screen (or null):
// { pid, open, revealed, q, million }
export function syncQuestion(info) {
  current = info;
  if (info) {
    if (info.open && !aud.opened[info.pid]) {
      aud.opened[info.pid] = Date.now();
      save();
    }
    if (info.revealed && !aud.revealed.includes(info.pid)) {
      aud.revealed.push(info.pid);
      save();
    }
  } else {
    aud.review = false;
  }
  publishSoon();
}

function publishSoon() {
  if (!relay || !aud.on) return;
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    publishNow();
  }, 120);
}

function publishNow() {
  if (!relay || !aud.on) return;
  const c = current;
  const rows = standings();
  const revealed = c ? aud.revealed.includes(c.pid) : false;
  const book = c ? aud.books[c.pid] || {} : {};
  const lastPid = [...aud.revealed].reverse().find((x) => x !== c?.pid || revealed);
  const lastBook = aud.books[lastPid] || {};
  const players = {};
  for (const r of rows) {
    const mine = book[r.id];
    const last = lastBook[r.id];
    players[r.id] = {
      n: r.name,
      p: r.pts,
      r: r.rank,
      g: mine ? (revealed ? [mine.ok ? 1 : 0, pointsFor(mine), mine.text] : 1) : 0,
      l: last ? [last.ok ? 1 : 0, pointsFor(last)] : null,
    };
  }
  const q = c?.q;
  const msg = {
    v: 1,
    room: aud.code,
    count: rows.length,
    top: rows.slice(0, 10).map((r) => [r.name, r.pts, r.rank]),
    players,
    // The question as the TV shows it. The answer stays here until it's revealed.
    q: c
      ? {
          pid: c.pid,
          open: !!c.open,
          revealed,
          million: !!c.million,
          grade: q.grade || null,
          subject: q.subject || "",
          text: q.question,
          choices: Array.isArray(q.choices) ? q.choices : null,
          media: !!(q.image || q.audio || q.video),
        }
      : null,
    answer: c && revealed ? q.answer : null,
    stats: c && revealed ? questionStats(c.pid) : null,
  };
  const json = JSON.stringify(msg);
  if (json === lastSent) return;
  lastSent = json;
  relay.publish(topic + "/s", msg, true);
}
