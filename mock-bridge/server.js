#!/usr/bin/env node
// Mock Philips Hue bridge (v1 API subset) for reliability testing.
//
// Models the bridge's real-world failure mode: a shared Zigbee radio
// budget of ~10 messages/sec, where a group command (broadcast) costs 8
// tokens and an individual light command costs 1. This reproduces
// Philips' documented guidance (~1 group command/sec, ~10 light
// commands/sec) and the interaction where heavy light traffic starves
// group/scene commands.
//
// Over-budget commands are SILENTLY DROPPED but still return HTTP 200
// with a success body — matching the worst observed bridge behavior.
// Set OVERLOAD=503 to return errors instead.
//
// Endpoints (v1):
//   GET /api/:key/scenes
//   GET /api/:key/groups/:id
//   PUT /api/:key/groups/:id/action
//   PUT /api/:key/lights/:id/state
// Test-only:
//   GET  /_test/state   full light state
//   GET  /_test/log     every request with applied/dropped outcome
//   POST /_test/reset   reset state, log, and rate budget
//
// Usage: node mock-bridge/server.js   (PORT=8090 by default)

const http = require("http");

const PORT = parseInt(process.env.PORT || "8090", 10);
const OVERLOAD = process.env.OVERLOAD || "drop"; // "drop" | "503"
const GROUP_COST = 8;
const LIGHT_COST = 1;
const RADIO_RATE = 10; // tokens/sec
const RADIO_CAP = 10;
const MIN_LATENCY_MS = 30;
const JITTER_MS = 50;

// ---------------------------------------------------------------- state

function initialState() {
  const lights = {};
  for (let i = 1; i <= 8; i++) {
    lights[String(i)] = { on: true, bri: 254, hue: 8000, sat: 140, effect: "none", alert: "none" };
  }
  return {
    lights,
    groups: {
      "0": { name: "All lights", lights: Object.keys(lights) },
      "1": { name: "Stage Left", lights: ["1", "2", "3", "4"] },
      "2": { name: "Stage Right", lights: ["5", "6", "7", "8"] },
    },
    // NOTE: two scenes named "Blackout". The stale one (only lights 1-2)
    // deliberately enumerates first to reproduce the wrong-lights bug
    // when scenes are looked up by name.
    scenes: {
      "stale-blackout": {
        name: "Blackout",
        lights: ["1", "2"],
        state: { on: false },
      },
      "real-blackout": {
        name: "Blackout",
        lights: ["1", "2", "3", "4", "5", "6", "7", "8"],
        state: { on: false },
      },
      "house-full": {
        name: "House Full",
        lights: ["1", "2", "3", "4", "5", "6", "7", "8"],
        state: { on: true, bri: 254, hue: 8000, sat: 140 },
      },
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `cue-${i + 1}`,
          {
            name: `Cue ${i + 1}`,
            lights: ["1", "2", "3", "4", "5", "6", "7", "8"],
            state: { on: true, bri: 200, hue: (i + 1) * 6000, sat: 254 },
          },
        ])
      ),
    },
  };
}

let state = initialState();
let log = [];

// ------------------------------------------------------- radio budget

let tokens = RADIO_CAP;
let lastRefill = Date.now();

function tryConsume(cost) {
  const now = Date.now();
  tokens = Math.min(RADIO_CAP, tokens + ((now - lastRefill) / 1000) * RADIO_RATE);
  lastRefill = now;
  if (tokens >= cost) {
    tokens -= cost;
    return true;
  }
  return false;
}

function resetBudget() {
  tokens = RADIO_CAP;
  lastRefill = Date.now();
}

// ------------------------------------------------------------ helpers

function applyToLight(lightId, attrs) {
  const light = state.lights[lightId];
  if (!light) return;
  for (const key of ["on", "bri", "hue", "sat", "effect", "alert"]) {
    if (key in attrs) light[key] = attrs[key];
  }
}

function applyGroupAction(groupId, body) {
  if (body.scene) {
    const scene = state.scenes[body.scene];
    if (!scene) return { error: `scene ${body.scene} not found` };
    // Real bridge: recalling a scene via a group applies the scene's
    // stored state to the lights in the scene (∩ group membership).
    const group = state.groups[groupId];
    if (!group) return { error: `group ${groupId} not found` };
    const targets = scene.lights.filter((id) => group.lights.includes(id));
    targets.forEach((id) => applyToLight(id, { ...scene.state, scene: body.scene }));
    targets.forEach((id) => (state.lights[id].scene = body.scene));
    return {};
  }
  const group = state.groups[groupId];
  if (!group) return { error: `group ${groupId} not found` };
  group.lights.forEach((id) => applyToLight(id, body));
  return {};
}

function record(entry) {
  log.push({ t: Date.now(), ...entry });
}

function send(res, status, jsonBody) {
  const latency = MIN_LATENCY_MS + Math.random() * JITTER_MS;
  setTimeout(() => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonBody));
  }, latency);
}

const success = (body) =>
  Object.entries(body).map(([k, v]) => ({ success: { [k]: v } }));

const v1Error = (type, address, description) => [
  { error: { type, address, description } },
];

// ------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, v1Error(2, req.url, "body contains invalid JSON"));
      }
    }
    route(req, res, body);
  });
});

function route(req, res, body) {
  const url = req.url || "";

  // --- test endpoints
  if (url === "/_test/state") return send(res, 200, state);
  if (url === "/_test/log") return send(res, 200, log);
  if (url === "/_test/reset" && req.method === "POST") {
    state = initialState();
    log = [];
    resetBudget();
    return send(res, 200, { reset: true });
  }

  // --- v1 API
  const scenesMatch = url.match(/^\/api\/[^/]+\/scenes$/);
  if (scenesMatch && req.method === "GET") {
    record({ method: "GET", path: "scenes", applied: true });
    const out = {};
    for (const [id, s] of Object.entries(state.scenes)) {
      out[id] = { name: s.name, lights: s.lights };
    }
    return send(res, 200, out);
  }

  const groupGetMatch = url.match(/^\/api\/[^/]+\/groups\/(\w+)$/);
  if (groupGetMatch && req.method === "GET") {
    const group = state.groups[groupGetMatch[1]];
    record({ method: "GET", path: `groups/${groupGetMatch[1]}`, applied: !!group });
    if (!group) return send(res, 200, v1Error(3, url, "resource not available"));
    return send(res, 200, group);
  }

  const groupActionMatch = url.match(/^\/api\/[^/]+\/groups\/(\w+)\/action$/);
  if (groupActionMatch && req.method === "PUT") {
    return handleCommand(res, {
      kind: "group",
      cost: GROUP_COST,
      path: `groups/${groupActionMatch[1]}/action`,
      body,
      apply: () => applyGroupAction(groupActionMatch[1], body),
    });
  }

  const lightMatch = url.match(/^\/api\/[^/]+\/lights\/(\w+)\/state$/);
  if (lightMatch && req.method === "PUT") {
    return handleCommand(res, {
      kind: "light",
      cost: LIGHT_COST,
      path: `lights/${lightMatch[1]}/state`,
      body,
      apply: () => {
        if (!state.lights[lightMatch[1]]) return { error: "light not found" };
        applyToLight(lightMatch[1], body);
        return {};
      },
    });
  }

  send(res, 404, v1Error(4, url, "method not available for resource"));
}

function handleCommand(res, { kind, cost, path, body, apply }) {
  if (!tryConsume(cost)) {
    record({ method: "PUT", path, body, applied: false, reason: "rate-limited" });
    if (OVERLOAD === "503") {
      return send(res, 503, v1Error(901, path, "bridge internal error (overloaded)"));
    }
    // Worst-case real behavior: claim success, apply nothing.
    return send(res, 200, success(body));
  }
  const result = apply();
  if (result.error) {
    record({ method: "PUT", path, body, applied: false, reason: result.error });
    return send(res, 200, v1Error(3, path, result.error));
  }
  record({ method: "PUT", path, body, applied: true });
  return send(res, 200, success(body));
}

server.listen(PORT, () => {
  console.log(`Mock Hue bridge on http://127.0.0.1:${PORT} (overload mode: ${OVERLOAD})`);
  console.log(`Radio budget: ${RADIO_RATE} tokens/s — group cmd costs ${GROUP_COST}, light cmd costs ${LIGHT_COST}`);
});
