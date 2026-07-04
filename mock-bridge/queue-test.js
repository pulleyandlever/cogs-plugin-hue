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
