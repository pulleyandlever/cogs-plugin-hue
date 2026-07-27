#!/usr/bin/env node
// Real-bridge probe, phase 2: SUSTAINED load (short bursts proved too
// easy). For each rate: hammer group commands alternating bri 1/254
// for a sustained window with a concurrent poller watching the
// bridge's light-state cache, then send a sentinel value and measure
// how long it takes to appear ("settle time" — detects internal
// buffering). Watches for in-body errors (type 901 = overloaded) and
// latency growth over the window.
//
// Usage: BRIDGE_IP=... HUE_API_KEY=... node mock-bridge/bridge-probe2.js
//   TEST_LIGHTS=2,3 to override auto-selection of reachable lights.

const BRIDGE_IP = process.env.BRIDGE_IP;
const API_KEY = process.env.HUE_API_KEY;
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

const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);

async function sustained(groupId, watchLight, intervalMs, seconds) {
  console.log(`── Sustained: group cmd every ${intervalMs}ms for ${seconds}s (alternating bri 1/254)`);
  const latencies = [];
  const errors = [];
  let transitions = 0;

  // concurrent poller: counts bridge-cache state changes on one light
  let polling = true;
  const poller = (async () => {
    let last = -1;
    while (polling) {
      const r = await call("GET", `/lights/${watchLight}`);
      const bri = r.json?.state?.bri;
      if (bri !== undefined && bri !== last) {
        if (last !== -1) transitions++;
        last = bri;
      }
      await sleep(100);
    }
  })();

  const endAt = Date.now() + seconds * 1000;
  let i = 0;
  let sent = 0;
  while (Date.now() < endAt) {
    const r = await call("PUT", `/groups/${groupId}/action`, {
      on: true,
      bri: i++ % 2 ? 1 : 254,
      transitiontime: 0,
    });
    sent++;
    latencies.push(r.ms);
    if (r.errors.length) errors.push(r.errors.join(";"));
    const wait = intervalMs - r.ms;
    if (wait > 0) await sleep(wait);
  }

  // sentinel: distinct value, measure time until the bridge cache shows it
  const sentinelSentAt = Date.now();
  const s = await call("PUT", `/groups/${groupId}/action`, { on: true, bri: 111, transitiontime: 0 });
  let settleMs = -1;
  for (let t = 0; t < 100; t++) {
    const r = await call("GET", `/lights/${watchLight}`);
    if (r.json?.state?.bri === 111) {
      settleMs = Date.now() - sentinelSentAt;
      break;
    }
    await sleep(100);
  }
  polling = false;
  await poller;

  const firstHalf = latencies.slice(0, Math.floor(latencies.length / 2));
  const secondHalf = latencies.slice(Math.floor(latencies.length / 2));
  console.log(`   sent=${sent}  errors=${errors.length}${errors.length ? " e.g. " + errors[0] : ""}`);
  console.log(`   PUT latency: first-half avg ${avg(firstHalf)}ms, second-half avg ${avg(secondHalf)}ms (growth = buffering)`);
  console.log(`   bridge-cache transitions observed: ${transitions} (poll @10Hz, max observable ~${seconds * 10})`);
  console.log(`   sentinel settle after burst: ${settleMs}ms ${s.errors.length ? "(sentinel ERR " + s.errors.join(";") + ")" : ""}\n`);
  await sleep(1500);
}

async function main() {
  // pick reachable lights & make probe group
  const lightsRes = await call("GET", "/lights");
  const testLights = process.env.TEST_LIGHTS
    ? process.env.TEST_LIGHTS.split(",")
    : Object.entries(lightsRes.json)
        .filter(([, l]) => l.state.reachable)
        .map(([id]) => id);
  const saved = {};
  for (const id of testLights) {
    const st = lightsRes.json[id].state;
    saved[id] = { on: st.on, bri: st.bri, colormode: st.colormode, xy: st.xy, ct: st.ct };
  }
  const create = await call("POST", "/groups", { name: "CC-Probe2", type: "LightGroup", lights: testLights });
  const groupId = create.json?.[0]?.success?.id;
  if (!groupId) {
    console.error("Could not create probe group:", JSON.stringify(create.json));
    process.exit(1);
  }
  console.log(`Probe group ${groupId} with lights ${testLights.join(",")}\n`);

  try {
    await sustained(groupId, testLights[0], 500, 10); //  2 group cmds/s
    await sustained(groupId, testLights[0], 200, 10); //  5 group cmds/s
    await sustained(groupId, testLights[0], 80, 12);  // ~12 group cmds/s
    console.log("── Mixed load: light spam @10/s on one light + group cmd every 1s");
    let lightSpam = true;
    const spam = (async () => {
      let j = 0;
      while (lightSpam) {
        await call("PUT", `/lights/${testLights[1] || testLights[0]}/state`, {
          on: true, bri: j++ % 2 ? 20 : 220, transitiontime: 0,
        });
        await sleep(100);
      }
    })();
    const groupLat = [];
    const groupErr = [];
    for (let i = 0; i < 8; i++) {
      const r = await call("PUT", `/groups/${groupId}/action`, { on: true, bri: 25 * (i + 1), transitiontime: 0 });
      groupLat.push(r.ms);
      if (r.errors.length) groupErr.push(r.errors.join(";"));
      await sleep(1000);
    }
    lightSpam = false;
    await spam;
    console.log(`   group PUT latency avg ${avg(groupLat)}ms max ${Math.max(...groupLat)}ms, errors ${groupErr.length}/8\n`);
  } finally {
    await call("DELETE", `/groups/${groupId}`);
    for (const id of testLights) {
      const s = saved[id];
      const restore = { on: true, transitiontime: 0, bri: s.bri };
      if (s.colormode === "xy" && s.xy) restore.xy = s.xy;
      else if (s.colormode === "ct" && s.ct) restore.ct = s.ct;
      await call("PUT", `/lights/${id}/state`, restore);
      await sleep(300);
      if (!s.on) await call("PUT", `/lights/${id}/state`, { on: false });
      await sleep(300);
    }
    console.log("Cleanup done: probe group deleted, light states restored.");
  }
}

main();
