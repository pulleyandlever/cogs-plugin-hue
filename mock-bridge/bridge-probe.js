#!/usr/bin/env node
// Real-bridge characterization probe.
//
// Measures how an actual Hue bridge behaves under load so the
// CommandQueue's constants can be tuned from data instead of Philips'
// documentation: response latency, light-command throughput, group-
// command throughput, and — most importantly — whether over-limit
// commands are DROPPED (never applied) or DELAYED (applied late).
//
// Etiquette: never touches group 0 or existing rooms. Picks reachable
// lights, saves their state, creates a temporary probe group, restores
// everything and deletes the group afterwards. Total run ~60s.
//
// Usage:
//   BRIDGE_IP=192.168.1.143 HUE_API_KEY=xxxx node mock-bridge/bridge-probe.js
//   TEST_LIGHTS=2,3 to override auto-selection of reachable lights.

const BRIDGE_IP = process.env.BRIDGE_IP;
const API_KEY = process.env.HUE_API_KEY;
if (!BRIDGE_IP || !API_KEY) {
  console.error("Set BRIDGE_IP and HUE_API_KEY");
  process.exit(1);
}
const API = `http://${BRIDGE_IP}/api/${API_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json().catch(() => undefined);
    const errors = Array.isArray(json)
      ? json.filter((e) => e && e.error).map((e) => `${e.error.type}:${e.error.description}`)
      : [];
    return { ms: Date.now() - t0, status: res.status, errors, json };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, errors: [String(e.message || e)], json: undefined };
  }
}

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
  };
};

async function main() {
  const report = {};

  // ---- recon & light selection
  const config = await call("GET", "/config");
  console.log(`Bridge: ${config.json.name} ${config.json.modelid} fw ${config.json.swversion} api ${config.json.apiversion}`);

  const lightsRes = await call("GET", "/lights");
  const lights = lightsRes.json;
  let testLights = process.env.TEST_LIGHTS
    ? process.env.TEST_LIGHTS.split(",")
    : Object.entries(lights)
        .filter(([, l]) => l.state.reachable)
        .map(([id]) => id);
  if (testLights.length === 0) {
    console.error("No reachable lights to test with");
    process.exit(1);
  }
  console.log(`Test lights: ${testLights.map((id) => `${id} (${lights[id].name})`).join(", ")}\n`);

  // ---- save original states
  const saved = {};
  for (const id of testLights) {
    const s = lights[id].state;
    saved[id] = { on: s.on, bri: s.bri, colormode: s.colormode, xy: s.xy, ct: s.ct, hue: s.hue, sat: s.sat };
  }

  let probeGroup;
  try {
    // ---- 1. sequential latency baseline (one light, well-spaced)
    console.log("── 1. Latency baseline: 8 well-spaced light commands");
    const lat = [];
    for (let i = 0; i < 8; i++) {
      const r = await call("PUT", `/lights/${testLights[0]}/state`, {
        on: true,
        bri: i % 2 ? 50 : 150,
        transitiontime: 0,
      });
      lat.push(r.ms);
      if (r.errors.length) console.log(`   error: ${r.errors.join("; ")}`);
      await sleep(400);
    }
    report.latency = stats(lat);
    console.log(`   latency ms: ${JSON.stringify(report.latency)}\n`);

    // ---- 2. light-command throughput: 20 cmds at 20/s to ONE light
    console.log("── 2. Light-command burst: 20 commands at 20/s (2x documented limit)");
    const lightBurst = { latencies: [], errors: [], sentBri: [] };
    for (let i = 0; i < 20; i++) {
      const bri = 10 * (i + 1); // 10..200, distinct & ordered
      lightBurst.sentBri.push(bri);
      const r = await call("PUT", `/lights/${testLights[0]}/state`, { on: true, bri, transitiontime: 0 });
      lightBurst.latencies.push(r.ms);
      if (r.errors.length) lightBurst.errors.push(`cmd${i}(bri ${bri}): ${r.errors.join(";")}`);
      await sleep(50);
    }
    await sleep(1500);
    const after2 = await call("GET", `/lights/${testLights[0]}`);
    report.lightBurst = {
      latency: stats(lightBurst.latencies),
      errorCount: lightBurst.errors.length,
      errors: lightBurst.errors.slice(0, 5),
      finalBriWanted: 200,
      finalBriActual: after2.json.state.bri,
    };
    console.log(`   latency ms: ${JSON.stringify(report.lightBurst.latency)}`);
    console.log(`   in-body errors: ${lightBurst.errors.length}/20`);
    console.log(`   final bri: wanted 200, actual ${after2.json.state.bri}\n`);

    // ---- create probe group
    const create = await call("POST", "/groups", {
      name: "CC-Probe",
      type: "LightGroup",
      lights: testLights,
    });
    probeGroup = create.json?.[0]?.success?.id;
    if (!probeGroup) {
      console.log(`   could not create probe group (${JSON.stringify(create.json)}) — skipping group tests`);
    }

    if (probeGroup) {
      // ---- 3. group-command rate ladder
      for (const intervalMs of [1000, 500, 250, 100]) {
        console.log(`── 3. Group commands every ${intervalMs}ms (6 commands)`);
        const g = { latencies: [], errors: [] };
        let lastBri = 0;
        for (let i = 0; i < 6; i++) {
          const bri = 30 * (i + 1); // 30..180 distinct ordered
          lastBri = bri;
          const r = await call("PUT", `/groups/${probeGroup}/action`, { on: true, bri, transitiontime: 0 });
          g.latencies.push(r.ms);
          if (r.errors.length) g.errors.push(`cmd${i}: ${r.errors.join(";")}`);
          await sleep(intervalMs);
        }
        await sleep(2000);
        const readback = await Promise.all(
          testLights.map(async (id) => (await call("GET", `/lights/${id}`)).json.state.bri)
        );
        const allAtFinal = readback.every((b) => b === lastBri);
        report[`group${intervalMs}`] = {
          latency: stats(g.latencies),
          errorCount: g.errors.length,
          errors: g.errors.slice(0, 3),
          finalBriWanted: lastBri,
          readback,
          allLightsAtFinal: allAtFinal,
        };
        console.log(`   latency ms: ${JSON.stringify(report[`group${intervalMs}`].latency)}`);
        console.log(`   in-body errors: ${g.errors.length}/6${g.errors.length ? " — " + g.errors[0] : ""}`);
        console.log(`   readback bri per light: [${readback.join(", ")}] (wanted ${lastBri}) all-at-final: ${allAtFinal}\n`);
        await sleep(1000);
      }

      // ---- 4. dropped vs delayed: back-to-back burst, then watch the timeline
      console.log("── 4. Dropped-vs-delayed: 5 group commands back-to-back, then poll one light for 8s");
      const burstBris = [40, 90, 140, 190, 240];
      const sendTimes = [];
      for (const bri of burstBris) {
        const r = await call("PUT", `/groups/${probeGroup}/action`, { on: true, bri, transitiontime: 0 });
        sendTimes.push({ bri, ms: r.ms, errors: r.errors });
      }
      const t0 = Date.now();
      const timeline = [];
      let last = -1;
      while (Date.now() - t0 < 8000) {
        const r = await call("GET", `/lights/${testLights[0]}`);
        const bri = r.json?.state?.bri;
        if (bri !== last) {
          timeline.push({ t: Date.now() - t0, bri });
          last = bri;
        }
        await sleep(150);
      }
      report.burst = { sends: sendTimes, timeline };
      console.log(`   send results: ${sendTimes.map((s) => `bri${s.bri}:${s.ms}ms${s.errors.length ? "(ERR " + s.errors.join(";") + ")" : ""}`).join(" ")}`);
      console.log(`   observed bri timeline: ${timeline.map((e) => `${e.t}ms→${e.bri}`).join("  ")}`);
      const appliedValues = timeline.map((e) => e.bri).filter((b) => burstBris.includes(b));
      const skipped = burstBris.filter((b) => !appliedValues.includes(b));
      console.log(`   applied: [${appliedValues.join(", ")}]  never-seen: [${skipped.join(", ")}]`);
      console.log(`   verdict: ${skipped.length > 0 ? "DROPPED (some states never appeared)" : "DELAYED (all states appeared, late)"}\n`);
    }
  } finally {
    // ---- cleanup: delete probe group, restore light states
    if (probeGroup) await call("DELETE", `/groups/${probeGroup}`);
    for (const id of testLights) {
      const s = saved[id];
      const restore = { on: true, transitiontime: 0 };
      if (s.bri !== undefined) restore.bri = s.bri;
      if (s.colormode === "xy" && s.xy) restore.xy = s.xy;
      else if (s.colormode === "ct" && s.ct) restore.ct = s.ct;
      else if (s.colormode === "hs") { restore.hue = s.hue; restore.sat = s.sat; }
      await call("PUT", `/lights/${id}/state`, restore);
      await sleep(300);
      if (!s.on) await call("PUT", `/lights/${id}/state`, { on: false });
      await sleep(300);
    }
    console.log("Cleanup done: probe group deleted, light states restored.");
  }

  console.log("\n═══ Raw report ═══");
  console.log(JSON.stringify(report, null, 1));
}

main();
