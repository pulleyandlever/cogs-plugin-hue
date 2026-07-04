#!/usr/bin/env node
// Phase 0 diagnosis test: reproduces the plugin's CURRENT behavior
// (scene cache + un-queued fire-and-forget PUTs) against the mock
// bridge, to demonstrate the failure modes seen in production:
//
//   A. Control — well-spaced cues all land.
//   B. Rapid GO sequence — cues in quick succession get dropped.
//   C. Party effect running — a scene cue fired mid-effect is starved.
//   D. Duplicate scene names — lookup by name addresses wrong lights.
//
// Usage:  node mock-bridge/server.js &   then   node mock-bridge/burst-test.js

const BASE = process.env.BRIDGE || "http://127.0.0.1:8090";
const API = `${BASE}/api/testkey`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  return (await fetch(url)).json();
}

async function reset() {
  await fetch(`${BASE}/_test/reset`, { method: "POST" });
}

// Mimic the plugin: fetch scenes once, look up by FIRST name match.
async function loadSceneMap() {
  const scenes = await getJson(`${API}/scenes`);
  const byName = {};
  for (const [id, s] of Object.entries(scenes)) {
    if (!(s.name in byName)) byName[s.name] = id; // first match wins, like the plugin
  }
  return byName;
}

// Mimic the plugin's showScene: single un-queued PUT to group 0.
function recallScene(sceneId) {
  return fetch(`${API}/groups/0/action`, {
    method: "PUT",
    body: JSON.stringify({ scene: sceneId, transitiontime: 0 }),
  });
}

async function appliedCount(pathPrefix) {
  const log = await getJson(`${BASE}/_test/log`);
  const cmds = log.filter((e) => e.method === "PUT" && e.path.startsWith(pathPrefix));
  return {
    sent: cmds.length,
    applied: cmds.filter((e) => e.applied).length,
    dropped: cmds.filter((e) => !e.applied).length,
  };
}

async function lightStates() {
  const s = await getJson(`${BASE}/_test/state`);
  return s.lights;
}

const results = [];
function verdict(name, expectation, holds, detail) {
  results.push({ name, expectation, holds, detail });
  console.log(`\n  ${holds ? "⚠ REPRODUCED" : "✗ NOT REPRODUCED"} — ${expectation}`);
  console.log(`    ${detail}`);
}

async function scenarioA() {
  console.log("\n─── Scenario A: control — 5 cues spaced 1.5s apart");
  await reset();
  const byName = await loadSceneMap();
  for (let i = 1; i <= 5; i++) {
    await recallScene(byName[`Cue ${i}`]);
    await sleep(1500);
  }
  const stats = await appliedCount("groups/0/action");
  const lights = await lightStates();
  const finalOk = lights["1"].scene === byName["Cue 5"];
  console.log(`    sent=${stats.sent} applied=${stats.applied} dropped=${stats.dropped}`);
  verdict(
    "A",
    "well-spaced cues are reliable (control)",
    stats.dropped === 0 && finalOk,
    `all ${stats.applied}/5 cues applied, final state = Cue 5: ${finalOk}`
  );
}

async function scenarioB() {
  console.log("\n─── Scenario B: rapid GO — 5 cues fired 150ms apart");
  await reset();
  const byName = await loadSceneMap();
  for (let i = 1; i <= 5; i++) {
    recallScene(byName[`Cue ${i}`]); // fire-and-forget, like the plugin
    await sleep(150);
  }
  await sleep(1000); // let in-flight requests finish
  const stats = await appliedCount("groups/0/action");
  const lights = await lightStates();
  const finalScene = lights["1"].scene;
  const finalIsCue5 = finalScene === byName["Cue 5"];
  console.log(`    sent=${stats.sent} applied=${stats.applied} dropped=${stats.dropped}`);
  console.log(`    final light state: ${finalScene} (wanted ${byName["Cue 5"]} = Cue 5)`);
  verdict(
    "B",
    "cues in quick succession are silently dropped",
    stats.dropped > 0,
    `${stats.dropped}/5 cues dropped by the bridge, all returned HTTP 200 "success"; ` +
      `final state correct: ${finalIsCue5}`
  );
}

async function scenarioC() {
  console.log("\n─── Scenario C: party effect running, scene cue fired mid-effect");
  await reset();
  const byName = await loadSceneMap();
  // Mimic startParty: 8 lights, every 300ms, staggered 150ms
  const lightIds = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const party = setInterval(() => {
    lightIds.forEach((id, i) => {
      setTimeout(() => {
        fetch(`${API}/lights/${id}/state`, {
          method: "PUT",
          body: JSON.stringify({ on: true, hue: Math.floor(Math.random() * 65536) }),
        }).catch(() => {});
      }, i * 150);
    });
  }, 300);

  await sleep(1500);
  await recallScene(byName["House Full"]); // the GO during the effect
  await sleep(1500);
  clearInterval(party);
  await sleep(500);

  const cueStats = await appliedCount("groups/0/action");
  const partyStats = await appliedCount("lights/");
  console.log(`    party PUTs: sent=${partyStats.sent} dropped=${partyStats.dropped}`);
  console.log(`    scene cue:  sent=${cueStats.sent} applied=${cueStats.applied}`);
  verdict(
    "C",
    "a running effect starves scene cues",
    cueStats.applied === 0,
    `scene cue applied: ${cueStats.applied}/1 — effect traffic also degraded ` +
      `(${partyStats.dropped}/${partyStats.sent} party updates dropped)`
  );
}

async function scenarioD() {
  console.log('\n─── Scenario D: duplicate scene names — recall "Blackout" by name');
  await reset();
  const byName = await loadSceneMap();
  await recallScene(byName["Blackout"]);
  await sleep(500);
  const lights = await lightStates();
  const off = Object.values(lights).filter((l) => !l.on).length;
  const wrong = off < 8;
  console.log(`    lights off after Blackout: ${off}/8`);
  verdict(
    "D",
    "name lookup picks a stale duplicate scene → wrong lights addressed",
    wrong,
    `"Blackout" turned off only ${off}/8 lights (first name-match was a stale scene covering lights 1-2)`
  );
}

async function main() {
  try {
    await fetch(`${BASE}/_test/state`);
  } catch {
    console.error(`Cannot reach mock bridge at ${BASE} — start it first:\n  node mock-bridge/server.js`);
    process.exit(1);
  }

  console.log(`Phase 0 diagnosis run against ${BASE}`);
  console.log("(⚠ REPRODUCED = the production failure mode occurs, confirming the diagnosis)");

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();

  console.log("\n═══ Summary ═══");
  for (const r of results) {
    console.log(`  ${r.holds ? "⚠" : "✗"} Scenario ${r.name}: ${r.expectation} — ${r.holds ? "confirmed" : "NOT confirmed"}`);
  }
  const controlOk = results.find((r) => r.name === "A")?.holds;
  const bugsReproduced = results.filter((r) => r.name !== "A" && r.holds).length;
  console.log(
    `\n  Control scenario healthy: ${controlOk ? "yes" : "NO — mock setup problem"}; ` +
      `${bugsReproduced}/3 production failure modes reproduced.`
  );
  process.exit(controlOk && bugsReproduced === 3 ? 0 : 1);
}

main();
