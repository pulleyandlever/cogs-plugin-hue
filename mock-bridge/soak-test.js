#!/usr/bin/env node
// Soak test: sustained randomized cue/effect chaos through the real
// HueClient against the mock bridge, verifying the show-critical
// invariants hold over time:
//
//   1. The bridge NEVER silently drops a command (client pacing works).
//   2. No cue ever reports "failed".
//   3. After the chaos, the final cue always wins: light state matches
//      the last Show Scene issued.
//   4. The queue drains back to depth 0 (no leak / runaway backlog).
//
// Usage:  npm run test:soak                (default 30 seconds)
//         SOAK_SECONDS=3600 npm run test:soak   (one-hour soak)

const { spawn } = require("child_process");
const path = require("path");

const PORT = 8092;
const BASE = `http://127.0.0.1:${PORT}`;
const SOAK_SECONDS = parseInt(process.env.SOAK_SECONDS || "30", 10);
const { HueClient } = require("./dist/hueClient");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();
const rand = (n) => Math.floor(Math.random() * n);

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

  const stats = { sent: 0, superseded: 0, failed: 0, warnings: 0, ops: 0 };
  const failures = [];
  const client = new HueClient({
    bridgeIp: `127.0.0.1:${PORT}`,
    apiKey: "testkey",
    onStatus: (e) => {
      if (e.type === "command") {
        stats[e.outcome]++;
        if (e.outcome === "failed") failures.push(`${e.label}: ${(e.errors || []).join("; ")}`);
      } else if (e.type === "warning") {
        stats.warnings++;
      }
    },
  });
  await client.refreshScenes();

  console.log(`Soak: ${SOAK_SECONDS}s of randomized cue/effect chaos against ${BASE}`);
  const endAt = Date.now() + SOAK_SECONDS * 1000;
  let lastReport = Date.now();

  while (Date.now() < endAt) {
    const roll = Math.random();
    stats.ops++;
    if (roll < 0.55) {
      // single cue, sometimes with a transition time
      const suffix = Math.random() < 0.3 ? `|${rand(20)}` : "";
      void client.showScene(`Cue ${1 + rand(10)}${suffix}`);
    } else if (roll < 0.7) {
      // rapid GO burst
      const burst = 3 + rand(4);
      for (let i = 0; i < burst; i++) {
        void client.showScene(`Cue ${1 + rand(10)}`);
        await sleep(30 + rand(120));
      }
    } else if (roll < 0.8) {
      void client.startParty(`0|${200 + rand(300)}`);
    } else if (roll < 0.9) {
      void client.stopEffect("0");
    } else if (roll < 0.95) {
      void client.startFlicker(String(1 + rand(2)));
    } else {
      void client.stopFlicker();
    }
    await sleep(50 + rand(350));

    if (Date.now() - lastReport > 10000) {
      console.log(
        `  t+${Math.round((SOAK_SECONDS * 1000 - (endAt - Date.now())) / 1000)}s: ` +
          `ops=${stats.ops} sent=${stats.sent} superseded=${stats.superseded} ` +
          `failed=${stats.failed} queueDepth=${client.queueDepth}`
      );
      lastReport = Date.now();
    }
  }

  // Wind down: stop effects, then a deterministic final cue
  await client.stopFlicker();
  await client.stopEffect("0");
  await sleep(2000);
  const finalResult = await client.showScene("Cue 1");

  // Leftover effect-priority commands (e.g. flicker keep-alives) drain at
  // ~0.9s per group command — allow up to 10s, assert it reaches empty.
  let drained = false;
  for (let i = 0; i < 40; i++) {
    if (client.queueDepth === 0) {
      drained = true;
      break;
    }
    await sleep(250);
  }
  await sleep(500);
  client.dispose();

  const log = await getJson(`${BASE}/_test/log`);
  const puts = log.filter((e) => e.method === "PUT");
  const bridgeDropped = puts.filter((e) => !e.applied);
  const lights = (await getJson(`${BASE}/_test/state`)).lights;
  const finalOk = lights["1"].scene === "cue-1" && finalResult.outcome === "sent";
  server.kill();

  console.log("\n═══ Soak results ═══");
  console.log(`  operations issued:        ${stats.ops}`);
  console.log(`  commands sent to bridge:  ${puts.length}`);
  console.log(`  superseded client-side:   ${stats.superseded} (stale cues/frames never sent)`);
  console.log(`  bridge silently dropped:  ${bridgeDropped.length}`);
  console.log(`  cue failures reported:    ${stats.failed}`);
  console.log(`  final cue wins:           ${finalOk}`);
  console.log(`  queue drained to 0:       ${drained}`);
  if (bridgeDropped.length > 0) {
    console.log("  dropped:", bridgeDropped.slice(0, 5));
  }
  if (failures.length > 0) {
    console.log("  failures:", failures.slice(0, 5));
  }

  const pass = bridgeDropped.length === 0 && stats.failed === 0 && finalOk && drained;
  console.log(pass ? "\n  SOAK PASS" : "\n  SOAK FAIL");
  process.exit(pass ? 0 : 1);
}

main();
