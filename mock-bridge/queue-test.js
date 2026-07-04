#!/usr/bin/env node
// Phase 1 regression test: drives the REAL HueClient + CommandQueue
// (compiled from src/ by tsconfig.queue.json) against the mock bridge.
// The same scenarios that failed in burst-test.js must now pass:
//
//   A. Control — well-spaced cues all land, zero queue-added delay.
//   B. Rapid GO — nothing dropped by the bridge, stale cues superseded
//      (never sent), final state is always the LAST cue.
//   C. Party effect running — a scene cue preempts effect traffic and
//      lands; no bridge drops at all.
//   D. Duplicate scene names — newest scene wins; all lights addressed.
//
// Usage:  npm run test:reliability
// (spawns its own mock bridge on port 8091; no setup needed)

const { spawn } = require("child_process");
const path = require("path");

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const { HueClient } = require("./dist/hueClient");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();
const reset = () => fetch(`${BASE}/_test/reset`, { method: "POST" });

async function groupStats() {
  const log = await getJson(`${BASE}/_test/log`);
  const cmds = log.filter((e) => e.method === "PUT" && e.path.includes("/action"));
  return {
    sent: cmds.length,
    applied: cmds.filter((e) => e.applied).length,
    dropped: cmds.filter((e) => !e.applied).length,
    scenes: cmds.filter((e) => e.applied && e.body && e.body.scene).map((e) => e.body.scene),
  };
}

async function totalDropped() {
  const log = await getJson(`${BASE}/_test/log`);
  return log.filter((e) => e.method === "PUT" && !e.applied).length;
}

async function lightStates() {
  return (await getJson(`${BASE}/_test/state`)).lights;
}

function makeClient() {
  return new HueClient({ bridgeIp: `127.0.0.1:${PORT}`, apiKey: "testkey" });
}

const results = [];
function check(name, description, pass, detail) {
  results.push({ name, description, pass });
  console.log(`\n  ${pass ? "✓ PASS" : "✗ FAIL"} — ${description}`);
  console.log(`    ${detail}`);
}

async function scenarioA() {
  console.log("\n─── Scenario A: control — 5 cues spaced 1.5s apart");
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  const latencies = [];
  for (let i = 1; i <= 5; i++) {
    const t0 = Date.now();
    const result = await client.showScene(`Cue ${i}`);
    latencies.push(Date.now() - t0);
    if (result.outcome !== "sent") console.log(`    unexpected outcome for Cue ${i}:`, result);
    await sleep(1500);
  }
  const stats = await groupStats();
  const lights = await lightStates();
  const maxLatency = Math.max(...latencies);
  console.log(`    sent=${stats.sent} applied=${stats.applied} dropped=${stats.dropped}`);
  console.log(`    per-cue GO→confirmed latency: ${latencies.join(", ")}ms`);
  check(
    "A",
    "well-spaced cues: all land, no queue-added delay",
    stats.applied === 5 && stats.dropped === 0 && lights["1"].scene === "cue-5" && maxLatency < 500,
    `5/5 applied, final=Cue 5, worst GO→confirmed ${maxLatency}ms (budget: <500ms incl. mock latency & response)`
  );
  client.dispose();
}

async function scenarioB() {
  console.log("\n─── Scenario B: rapid GO — 5 cues fired 150ms apart");
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  const promises = [];
  for (let i = 1; i <= 5; i++) {
    promises.push(client.showScene(`Cue ${i}`));
    await sleep(150);
  }
  const outcomes = await Promise.all(promises);
  await sleep(1500);

  const stats = await groupStats();
  const lights = await lightStates();
  const superseded = outcomes.filter((o) => o.outcome === "superseded").length;
  const lastOutcome = outcomes[4].outcome;
  const appliedScenes = stats.scenes;
  const finalOk = lights["1"].scene === "cue-5";
  console.log(`    outcomes: ${outcomes.map((o) => o.outcome).join(", ")}`);
  console.log(`    bridge saw ${stats.sent} group PUTs, applied=${stats.applied}, dropped=${stats.dropped}`);
  console.log(`    applied scene order: ${appliedScenes.join(" → ")}`);
  check(
    "B",
    "rapid cues: nothing dropped, stale cues superseded, final state = last cue",
    stats.dropped === 0 &&
      finalOk &&
      lastOutcome === "sent" &&
      superseded > 0 &&
      appliedScenes[appliedScenes.length - 1] === "cue-5",
    `bridge dropped 0, ${superseded} stale cues superseded client-side (never sent), ` +
      `last cue outcome="${lastOutcome}", final state = Cue 5: ${finalOk}`
  );
  client.dispose();
}

async function scenarioC() {
  console.log("\n─── Scenario C: party effect running, scene cue fired mid-effect");
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  await client.startParty("0|300");
  await sleep(1500);

  const t0 = Date.now();
  const cueResult = await client.showScene("House Full");
  const cueLatency = Date.now() - t0;
  await sleep(500);
  await client.stopEffect("0");
  await sleep(500);

  const stats = await groupStats();
  const dropped = await totalDropped();
  const cueApplied = stats.scenes.includes("house-full");
  console.log(`    cue outcome="${cueResult.outcome}" GO→confirmed in ${cueLatency}ms`);
  console.log(`    bridge dropped ${dropped} commands total (party + cues)`);
  check(
    "C",
    "cue preempts a running effect and lands; zero bridge drops",
    cueResult.outcome === "sent" && cueApplied && dropped === 0 && cueLatency < 2000,
    `cue applied=${cueApplied} in ${cueLatency}ms under full effect load, bridge drops=${dropped}`
  );
  client.dispose();
}

async function scenarioD() {
  console.log('\n─── Scenario D: duplicate scene names — recall "Blackout"');
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  await client.showScene("Blackout");
  await sleep(500);
  const lights = await lightStates();
  const off = Object.values(lights).filter((l) => !l.on).length;
  check(
    "D",
    "duplicate names: newest scene wins, all lights addressed",
    off === 8,
    `"Blackout" turned off ${off}/8 lights (newest of the two duplicates covers all 8)`
  );
  client.dispose();
}

async function scenarioE() {
  console.log("\n─── Scenario E: status events — command outcomes and bridge health");
  await reset();
  const events = [];
  const client = new HueClient({
    bridgeIp: `127.0.0.1:${PORT}`,
    apiKey: "testkey",
    onStatus: (e) => events.push(e),
  });
  await client.refreshScenes();

  await client.showScene("Cue 1"); // should emit command/sent with scene
  await client.showScene("No Such Scene"); // should emit command/failed
  client.dispose();

  // Unreachable bridge → command failed + bridge offline event
  const deadEvents = [];
  const deadClient = new HueClient({
    bridgeIp: "127.0.0.1:9",
    apiKey: "testkey",
    onStatus: (e) => deadEvents.push(e),
  });
  await deadClient.showScene("Cue 1");
  deadClient.dispose();

  const sent = events.find((e) => e.type === "command" && e.outcome === "sent" && e.scene === "Cue 1");
  const failed = events.find((e) => e.type === "command" && e.outcome === "failed" && e.scene === "No Such Scene");
  const dupWarning = events.find((e) => e.type === "warning" && /Duplicate scene names/.test(e.message));
  const offline = deadEvents.find((e) => e.type === "bridge" && e.online === false);
  const deadFailed = deadEvents.find((e) => e.type === "command" && e.outcome === "failed");
  console.log(`    live-bridge events: ${events.map((e) => e.type + ":" + (e.outcome ?? e.online ?? "warn")).join(", ")}`);
  console.log(`    dead-bridge events: ${deadEvents.map((e) => e.type + ":" + (e.outcome ?? e.online ?? "warn")).join(", ")}`);
  check(
    "E",
    "status events: sent/failed outcomes, duplicate warning, bridge-offline detection",
    Boolean(sent && failed && dupWarning && offline && deadFailed),
    `sent=${!!sent} failed=${!!failed} duplicate-warning=${!!dupWarning} offline-detected=${!!offline} dead-cue-failed=${!!deadFailed}`
  );
}

async function scenarioF() {
  console.log("\n─── Scenario F: bridge overloaded (901) — retry with overload backoff recovers");
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  // Force the bridge into its measured overload state for 600ms
  await fetch(`${BASE}/_test/overload`, { method: "POST", body: JSON.stringify({ ms: 600 }) });
  const t0 = Date.now();
  const result = await client.showScene("Cue 2");
  const elapsed = Date.now() - t0;
  await sleep(300);

  const log = await getJson(`${BASE}/_test/log`);
  const rejected = log.filter((e) => e.reason === "overloaded").length;
  const applied = log.filter((e) => e.applied && e.path.includes("/action")).length;
  console.log(`    outcome="${result.outcome}" after ${elapsed}ms (901 rejections: ${rejected}, applied: ${applied})`);
  check(
    "F",
    "a 901-overloaded bridge: first attempt rejected, backoff retry lands the cue",
    result.outcome === "sent" && rejected >= 1 && applied === 1 && elapsed >= 700,
    `cue landed on retry after ${elapsed}ms (backoff 800ms) despite ${rejected} overload rejection(s)`
  );
  client.dispose();
}

async function scenarioG() {
  console.log("\n─── Scenario G: flaky venue WiFi — 25% of connections dropped mid-request");
  const FLAKY_PORT = PORT + 1;
  const flakyServer = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(FLAKY_PORT), FLAKY_DROP: "0.25" },
    stdio: "ignore",
  });
  await sleep(500);

  const client = new HueClient({ bridgeIp: `127.0.0.1:${FLAKY_PORT}`, apiKey: "testkey" });
  // Initial scene fetch has no retry of its own — try a few times, like
  // a startup would across polling attempts
  let refreshed = false;
  for (let i = 0; i < 6 && !refreshed; i++) refreshed = await client.refreshScenes();

  const outcomes = [];
  for (let i = 1; i <= 6; i++) {
    outcomes.push(await client.showScene(`Cue ${i}`));
    await sleep(1100);
  }
  client.dispose();
  flakyServer.kill();

  const sent = outcomes.filter((o) => o.outcome === "sent").length;
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  const unaccounted = outcomes.filter((o) => !["sent", "failed"].includes(o.outcome)).length;
  console.log(`    outcomes: ${outcomes.map((o) => o.outcome).join(", ")}`);
  check(
    "G",
    "flaky transport: retries absorb drops, every cue outcome is reported, no silent losses",
    refreshed && sent >= 4 && unaccounted === 0,
    `${sent}/6 cues landed (retry absorbs single drops), ${failed} reported failed, 0 unaccounted`
  );
}

async function scenarioH() {
  console.log("\n─── Scenario H: overlapping effect starts must not leak ghost timers");
  await reset();
  const client = makeClient();
  await client.refreshScenes();

  // Fire effect starts into each other's async setup windows (each
  // start awaits a bridge fetch before installing its interval — the
  // 30-min soak found intervals leaking here)
  void client.startParty("0|250");
  void client.startParty("1|250");
  void client.startFlicker("1");
  await sleep(1500);
  await client.stopEffect("0");
  await client.stopFlicker();
  await sleep(2000);

  const countPuts = async () =>
    (await getJson(`${BASE}/_test/log`)).filter((e) => e.method === "PUT").length;
  const before = await countPuts();
  await sleep(3000);
  const after = await countPuts();
  const ghostPuts = after - before;
  const depth = client.queueDepth;
  client.dispose();
  console.log(`    PUTs in 3s quiet window after stop: ${ghostPuts}, queue depth: ${depth}`);
  check(
    "H",
    "after stopping all effects, no ghost timer keeps sending",
    ghostPuts === 0 && depth === 0,
    `${ghostPuts} PUTs arrived after everything was stopped (must be 0), queue depth ${depth}`
  );
}

async function main() {
  const server = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await sleep(500);

  try {
    await fetch(`${BASE}/_test/state`);
  } catch {
    console.error("Mock bridge failed to start");
    server.kill();
    process.exit(1);
  }

  console.log(`Phase 1 regression run: real HueClient + CommandQueue vs mock bridge (${BASE})`);
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await scenarioF();
    await scenarioG();
    await scenarioH();
  } finally {
    server.kill();
  }

  console.log("\n═══ Summary ═══");
  for (const r of results) {
    console.log(`  ${r.pass ? "✓" : "✗"} Scenario ${r.name}: ${r.description}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? "\n  All scenarios PASS." : `\n  ${failed} scenario(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
