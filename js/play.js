// The phone page for audience play-along.
//
// Phones see the question the TV shows (never the answer) and lock in one answer per
// question. The host's laptop checks and scores it; the result shows up here once the
// answer is revealed on the TV. Faster right answers are worth more.

import { Relay, brokerFor, cleanCode, TOPIC_ROOT } from "./relay.js?v=__V__";
import { speedPoints, MAX_POINTS, MIN_POINTS, DROP_MS } from "./audience.js?v=__V__";

const STORE_KEY = "smarter5th.play.v1";
const ORDINALS = { 1: "1st", 2: "2nd", 3: "3rd" };

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pts = (n) => Number(n).toLocaleString("en-US");

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}

function store() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(me));
  } catch {
    /* private window: fine, just won't remember */
  }
}

const me = Object.assign({ id: "p" + Math.random().toString(36).slice(2, 12), name: "", code: "", joined: false, last: {} }, load() || {});
const params = new URLSearchParams(location.search);
const linkCode = cleanCode(params.get("code"));
if (linkCode && linkCode !== me.code) {
  me.code = linkCode;
  me.joined = false;
}
store();

let relay = null;
let topic = "";
let status = "idle"; // idle | connecting | live | down
let view = null; // the latest message from the host
let pending = null; // { pid, text } sent but not confirmed yet
let picked = null; // the multiple-choice option tapped but not locked in yet
let joinError = "";
let lastJoinSent = 0;
let resendTimer = null;
let formKey = "";
const firstSeen = {}; // pid -> when this phone first saw the question

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const broker = brokerFor(me.code);
  if (!broker) return;
  relay?.close();
  view = null;
  topic = TOPIC_ROOT + me.code;
  relay = new Relay(broker.url, {
    onMessage: (t, m) => {
      if (t !== topic + "/s") return;
      view = m;
      const mine = m.players?.[me.id];
      if (!m.closed && !mine) sendJoin();
      if (m.q?.open && !firstSeen[m.q.pid]) firstSeen[m.q.pid] = Date.now();
      if (pending && (pending.pid !== m.q?.pid || mine?.g)) pending = null;
      if (picked && picked.pid !== m.q?.pid) picked = null;
      render();
    },
    onStatus: (s) => {
      status = s;
      if (s === "live") sendJoin(true);
      render();
    },
  });
  relay.subscribe(topic + "/s");
  relay.start();
  status = "connecting";
}

function sendJoin(force = false) {
  if (!relay) return;
  if (!force && Date.now() - lastJoinSent < 3000) return;
  lastJoinSent = Date.now();
  relay.publish(topic + "/h", { t: "join", id: me.id, name: me.name });
}

// Check in now and then so the host knows we're still here.
setInterval(() => sendJoin(true), 25000);

function sendAnswer(text) {
  const q = view?.q;
  if (!q?.open) return;
  pending = { pid: q.pid, text };
  // Remember what they answered, so it still shows after a reload.
  const keep = Object.entries(me.last || {}).slice(-5);
  me.last = Object.fromEntries([...keep, [q.pid, text]]);
  store();
  const msg = { t: "answer", id: me.id, pid: q.pid, text };
  relay.publish(topic + "/h", msg);
  clearInterval(resendTimer);
  let tries = 0;
  resendTimer = setInterval(() => {
    if (!pending || pending.pid !== msg.pid || ++tries > 6) return clearInterval(resendTimer);
    relay.publish(topic + "/h", msg);
  }, 2500);
  render();
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const app = document.getElementById("app");

function render() {
  if (!me.joined) return renderJoin();
  if (!app.querySelector(".pp")) {
    app.innerHTML = `<main class="pp">
      <header class="pp-top" id="pp-top"></header>
      <section id="pp-view"></section>
      <section id="pp-form"></section>
      <section id="pp-lb"></section>
      <footer class="pp-foot"><button class="link" id="pp-leave">Change name or room</button></footer>
    </main>`;
    document.getElementById("pp-leave").onclick = () => {
      me.joined = false;
      store();
      relay?.close();
      relay = null;
      app.innerHTML = "";
      render();
    };
  }
  const mine = view?.players?.[me.id];
  const dot = status === "live" ? "live" : status === "down" ? "down" : "connecting";
  document.getElementById("pp-top").innerHTML = `
    <div class="pp-me"><span class="aud-dot ${dot}"></span><strong>${esc(me.name)}</strong></div>
    <div class="pp-score">${
      mine ? `${pts(mine.p)} pts${view.count > 1 ? ` · #${mine.r} of ${view.count}` : ""}` : status === "live" ? "Joining…" : "Connecting…"
    }</div>`;
  const viewHtml = questionHtml(mine);
  const viewEl = document.getElementById("pp-view");
  if (viewEl.innerHTML !== viewHtml) viewEl.innerHTML = viewHtml;
  renderForm(mine);
  document.getElementById("pp-lb").innerHTML = lbHtml(mine);
}

const gradeName = (g) => `${ORDINALS[g] || g + "th"} Grade`;

function questionHtml(mine) {
  if (!view) return `<div class="pp-wait"><div class="pp-spinner"></div><p>${status === "down" ? "Reconnecting…" : "Connecting to the game…"}</p></div>`;
  if (view.closed) return `<div class="pp-wait"><p>The host has turned off play-along for now.</p></div>`;
  const q = view.q;
  if (!q)
    return `<div class="pp-wait"><p class="pp-big">You're in!</p><p>Questions show up here as soon as they're on the TV. Keep this page open.</p>${lastResult(
      mine
    )}</div>`;
  const label = q.million ? "The $1,000,000 Question" : q.grade ? gradeName(q.grade) : "";
  return `<div class="pp-q ${q.million ? "million" : ""}">
    <div class="pp-grade">${esc(label)}</div>
    <div class="pp-subject">${esc(q.subject)}</div>
    <div class="pp-text">${esc(q.text)}</div>
    ${q.media ? `<p class="pp-media">📺 Look at the TV for this one.</p>` : ""}
    ${q.revealed ? revealHtml(mine) : ""}
  </div>`;
}

function revealHtml(mine) {
  const g = mine?.g;
  const st = view.stats;
  let line = `<p class="pp-res none">You didn't answer this one.</p>`;
  if (Array.isArray(g)) {
    line = g[0]
      ? `<p class="pp-res ok">✓ You got it! <strong>+${pts(g[1])}</strong></p>`
      : `<p class="pp-res no">✗ You said “${esc(g[2])}”</p>`;
  }
  return `<div class="pp-reveal">
    <div class="pp-answer"><span>Answer</span>${esc(view.answer)}</div>
    ${line}
    ${st ? `<p class="small">${st.right} of ${st.answered} got it${st.fastest ? ` · fastest: ${esc(st.fastest.name)} +${pts(st.fastest.pts)}` : ""}</p>` : ""}
  </div>`;
}

function lastResult(mine) {
  if (!mine?.l) return "";
  return mine.l[0] ? `<p class="pp-res ok">Last question: ✓ +${pts(mine.l[1])}</p>` : `<p class="pp-res no">Last question: ✗</p>`;
}

const worthNow = () => speedPoints(Date.now() - (firstSeen[view?.q?.pid] || Date.now()));

// The answer form is only rebuilt when it has to be, so the keyboard doesn't close.
function renderForm(mine) {
  const el = document.getElementById("pp-form");
  const q = view?.q;
  let key = "none";
  if (view && !view.closed && q?.open) {
    if (mine?.g) key = "locked:" + q.pid;
    else if (pending?.pid === q.pid) key = "sending:" + q.pid;
    else key = (q.choices ? "choices:" : "input:") + q.pid + ":" + (picked?.pid === q.pid ? picked.text : "");
  }
  if (key === formKey) return updateWorth();
  formKey = key;
  if (key.startsWith("input")) {
    el.innerHTML = `<form class="pp-form" id="pp-ans" autocomplete="off">
      <label for="pp-text">Your answer <span class="pp-worth">worth <b id="pp-worth"></b> if right</span></label>
      <input id="pp-text" maxlength="80" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Type your answer">
      <button class="btn btn-red big" type="submit">Lock it in</button>
      <p class="small">One answer per question. Spelling doesn't have to be perfect.</p>
    </form>`;
    document.getElementById("pp-ans").onsubmit = (e) => {
      e.preventDefault();
      const text = document.getElementById("pp-text").value.trim();
      if (!text) return;
      document.getElementById("pp-text").blur();
      sendAnswer(text);
    };
  } else if (key.startsWith("choices")) {
    const sel = picked?.pid === q.pid ? picked.text : null;
    el.innerHTML = `<div class="pp-form">
      <label>Pick one <span class="pp-worth">worth <b id="pp-worth"></b> if right</span></label>
      <div class="pp-choices">${q.choices
        .map((c, i) => `<button class="pp-choice ${sel === c ? "on" : ""}" data-i="${i}"><span>${String.fromCharCode(65 + i)}</span>${esc(c)}</button>`)
        .join("")}</div>
      <button class="btn btn-red big" id="pp-lock" ${sel ? "" : "disabled"}>${sel ? `Lock in “${esc(sel)}”` : "Tap an answer"}</button>
    </div>`;
    for (const b of el.querySelectorAll(".pp-choice")) {
      b.onclick = () => {
        picked = { pid: q.pid, text: q.choices[Number(b.dataset.i)] };
        render();
      };
    }
    document.getElementById("pp-lock").onclick = () => sel && sendAnswer(sel);
  } else if (key.startsWith("locked") || key.startsWith("sending")) {
    const text = pending?.text || me.last?.[q.pid] || "";
    el.innerHTML = `<div class="pp-locked">${key.startsWith("sending") ? "Sending…" : "🔒 Locked in"}${
      text ? `<strong>${esc(text)}</strong>` : ""
    }<span class="small">You'll find out when the answer is revealed on the TV.</span></div>`;
  } else {
    el.innerHTML = "";
  }
  updateWorth();
}

function updateWorth() {
  const w = document.getElementById("pp-worth");
  if (w) w.textContent = pts(worthNow());
}
setInterval(updateWorth, 250);

function lbHtml(mine) {
  if (!view?.top?.length) return "";
  const inTop = view.top.slice(0, 5).some(([n]) => n === me.name);
  return `<div class="pp-lb"><h3>Leaderboard</h3><ol class="lb">${view.top
    .slice(0, 5)
    .map(([n, p, r]) => `<li class="${n === me.name ? "me" : ""}"><span class="lb-rank">${r}</span><span class="lb-name">${esc(n)}</span><b>${pts(p)}</b></li>`)
    .join("")}${
    mine && !inTop
      ? `<li class="me gap"><span class="lb-rank">${mine.r}</span><span class="lb-name">${esc(me.name)}</span><b>${pts(mine.p)}</b></li>`
      : ""
  }</ol></div>`;
}

function renderJoin() {
  formKey = "";
  app.innerHTML = `<main class="pp pp-join">
    <div class="logo pp-logo">
      <span class="logo-are">Are You</span>
      <span class="logo-smarter">Smarter</span>
      <span class="logo-than">Than a <span class="logo-former">Former</span></span>
      <span class="logo-fifth"><span class="logo-5">5</span><sup>th</sup> Grader?</span>
    </div>
    <section class="card">
      <h2>Play along</h2>
      <p class="small">Answer every question on your phone. The faster you lock in a right answer, the more points you get: ${pts(MAX_POINTS)} if you're quick, down to ${pts(
        MIN_POINTS
      )} after ${DROP_MS / 1000} seconds.</p>
      <form id="pp-join" class="pp-join-form" autocomplete="off">
        <label>Room code<input id="pp-code" maxlength="5" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="5 letters" value="${esc(me.code)}"></label>
        <label>Your name<input id="pp-name" maxlength="20" autocorrect="off" placeholder="Name for the leaderboard" value="${esc(me.name)}"></label>
        ${joinError ? `<p class="error">${esc(joinError)}</p>` : ""}
        <button class="btn btn-red big" type="submit">Join</button>
      </form>
    </section>
  </main>`;
  document.getElementById("pp-join").onsubmit = (e) => {
    e.preventDefault();
    const code = cleanCode(document.getElementById("pp-code").value);
    const name = document.getElementById("pp-name").value.replace(/\s+/g, " ").trim().slice(0, 20);
    if (code.length !== 5 || !brokerFor(code)) {
      joinError = "That room code doesn't look right. It's the 5 letters on the TV.";
      return renderJoin();
    }
    if (!name) {
      joinError = "Add a name for the leaderboard.";
      return renderJoin();
    }
    joinError = "";
    Object.assign(me, { code, name, joined: true });
    store();
    app.innerHTML = "";
    connect();
    render();
  };
  (me.code ? document.getElementById("pp-name") : document.getElementById("pp-code")).focus();
}

if (me.joined && me.code && me.name) connect();
render();

// For checking things from the browser console.
window.playState = () => ({ me, view, status, pending });
