// Play-along relay: a tiny MQTT client over WebSockets.
//
// Like Dim Sum Rush, phones and the host never connect to each other directly. Every
// message goes through a free public MQTT broker, so nothing else needs hosting and home
// Wi-Fi firewalls don't matter. The first letter of a room code says which broker the
// room is on.
//
// This speaks just enough MQTT 3.1.1 for the game: connect, subscribe, publish (QoS 0,
// optionally retained) and keepalive pings. It reconnects on its own if the line drops.

export const BROKERS = [
  { key: "E", url: "wss://broker.emqx.io:8084/mqtt", name: "EMQX" },
  { key: "H", url: "wss://broker.hivemq.com:8884/mqtt", name: "HiveMQ" },
  { key: "M", url: "wss://test.mosquitto.org:8081", name: "Mosquitto" },
];

// For testing on one computer: ?broker=ws://localhost:1884 uses that broker (key "L").
const override = new URLSearchParams(location.search).get("broker");
const LIST = override ? [{ key: "L", url: override, name: "Local" }] : BROKERS;

export const TOPIC_ROOT = "whatsgood/fifth/v1/";

export function makeCode(brokerKey) {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = brokerKey;
  for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}

export const brokerFor = (code) => LIST.find((b) => b.key === String(code || "")[0]) || null;
export const cleanCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 5);

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

function packet(first, body) {
  const len = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    len.push(d);
  } while (n > 0);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = first;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

const KEEPALIVE = 30; // seconds

export class Relay {
  // onMessage(topic, object), onStatus("connecting" | "live" | "down")
  constructor(url, { onMessage, onStatus } = {}) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.subs = new Set();
    this.ws = null;
    this.live = false;
    this.closed = false;
    this.buf = new Uint8Array(0);
    this.nextId = 1;
    this.retry = 0;
    this.pingTimer = null;
    this.queue = []; // publishes made while offline, sent on reconnect
  }

  // Phones: start connecting and keep trying for as long as the page is open.
  start() {
    this._open(null);
    return this;
  }

  // Resolves once connected (or rejects after a timeout on the first try).
  connect(timeout = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error("timeout"));
      }, timeout);
      this._open(() => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(this);
      });
    });
  }

  _open(onFirstConnect) {
    if (this.closed) return;
    this.onStatus(this.retry ? "down" : "connecting");
    let ws;
    try {
      ws = new WebSocket(this.url, ["mqtt"]);
    } catch {
      return this._later(onFirstConnect);
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.buf = new Uint8Array(0);
    ws.onopen = () => {
      const id = "afg" + Math.random().toString(16).slice(2, 14);
      // Protocol "MQTT", level 4 (3.1.1), clean session, keepalive.
      const body = [...str("MQTT"), 4, 0x02, KEEPALIVE >> 8, KEEPALIVE & 255, ...str(id)];
      ws.send(packet(0x10, body));
    };
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
      this._drain(onFirstConnect);
    };
    ws.onclose = () => {
      const was = this.live;
      this.live = false;
      clearInterval(this.pingTimer);
      if (this.closed) return;
      if (was) this.onStatus("down");
      this._later(onFirstConnect);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }

  _later(onFirstConnect) {
    if (this.closed) return;
    this.retry += 1;
    const wait = Math.min(8000, 800 * this.retry);
    setTimeout(() => this._open(onFirstConnect), wait);
  }

  _drain(onFirstConnect) {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= b.length) return;
        byte = b[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (b.length < i + len) return;
      const first = b[0];
      const body = b.subarray(i, i + len);
      this.buf = b.slice(i + len);
      this._packet(first, body, onFirstConnect);
    }
  }

  _packet(first, body, onFirstConnect) {
    const type = first >> 4;
    if (type === 2) {
      // CONNACK
      if (body[1] !== 0) {
        this.ws?.close();
        return;
      }
      this.live = true;
      this.retry = 0;
      for (const topic of this.subs) this._subscribe(topic);
      const q = this.queue;
      this.queue = [];
      for (const [topic, data, retain] of q) this.publish(topic, data, retain);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._send(packet(0xc0, [])), (KEEPALIVE * 1000) / 2);
      this.onStatus("live");
      onFirstConnect?.();
    } else if (type === 3) {
      // PUBLISH
      const qos = (first >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tlen));
      let at = 2 + tlen;
      if (qos > 0) {
        const pid = [body[at], body[at + 1]];
        at += 2;
        if (qos === 1) this._send(packet(0x40, pid));
      }
      const payload = body.subarray(at);
      if (!payload.length) return; // a cleared retained message
      let obj;
      try {
        obj = JSON.parse(dec.decode(payload));
      } catch {
        return;
      }
      this.onMessage(topic, obj);
    }
    // SUBACK, PINGRESP and the rest need nothing.
  }

  _send(bytes) {
    if (this.ws?.readyState === 1) {
      try {
        this.ws.send(bytes);
        return true;
      } catch {
        /* dropped; reconnect will catch up */
      }
    }
    return false;
  }

  _subscribe(topic) {
    const id = this.nextId++ & 0xffff || 1;
    this._send(packet(0x82, [id >> 8, id & 255, ...str(topic), 0]));
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.live) this._subscribe(topic);
  }

  publish(topic, data, retain = false) {
    const payload = data == null ? new Uint8Array(0) : enc.encode(JSON.stringify(data));
    const bytes = packet(0x30 | (retain ? 1 : 0), [...str(topic), ...payload]);
    if (!this.live || !this._send(bytes)) {
      // Keep only the latest retained message per topic, plus a few others.
      this.queue = this.queue.filter(([t, , r]) => !(retain && r && t === topic)).slice(-20);
      this.queue.push([topic, data, retain]);
    }
  }

  close() {
    this.closed = true;
    this.live = false;
    clearInterval(this.pingTimer);
    try {
      if (this.ws?.readyState === 1) this.ws.send(packet(0xe0, []));
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

// Host: try each broker until one answers. Returns { relay, broker }.
export async function connectAny(handlers) {
  let lastErr = null;
  for (const broker of LIST) {
    const relay = new Relay(broker.url, handlers);
    try {
      await relay.connect();
      return { relay, broker };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No relay answered");
}
