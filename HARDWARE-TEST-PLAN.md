# Hardware Test Plan — show bridge + rig

Plan for the day the show hardware is available. Three sessions, ~2 hours
total. Sessions 1 and 2 need the bridge + a few lights; session 3 wants the
full rig and ideally the real venue network.

**What we're deciding:**
1. The show bridge's real limits with the full mesh paired → whether to
   retune the queue's pacing (currently documented-conservative).
2. Whether the COGS webview throttles timers (the one risk we couldn't
   test without equipment).
3. Bulb-level behavior the API can't show us: popcorn effect severity,
   GO-to-light latency feel, ghost failures.

**Prerequisites** (from the README show-day checklist):
- Show bridge + rig paired, bridge IP and API key to hand
- DHCP reservation made; Hue auto-firmware-update off
- Laptop on the same network, this repo, Node 18+
- No other Hue traffic (phone apps, sensors, assistants)

---

## Session 1 — Characterize the show bridge (~15 min)

```
BRIDGE_IP=<ip> HUE_API_KEY=<key> node mock-bridge/bridge-probe.js
BRIDGE_IP=<ip> HUE_API_KEY=<key> node mock-bridge/bridge-probe2.js
```

(~60s of light flashing per probe; states are saved/restored, no rooms or
group 0 touched.)

Record: median latency, highest clean sustained group rate, collapse
point, mixed-load errors. Reference numbers from the 3-bulb home bridge
(BSB002 fw 1977138000): 60ms latency, clean at 5 group/s, collapse at
~12/s, mixed-load damage at 10 light/s + 1 group/s.

**Tuning gate** — based on the highest *clean* sustained group rate:

| Show bridge result | Action on `COSTS.group` in src/commandQueue.ts |
| --- | --- |
| Clean at ≥ 4 group/s | Lower cost 8 → 5 (≈1.8 cues/s, 2 instant back-to-back GOs) |
| Clean at 2–3 group/s | Lower cost 8 → 6 |
| Errors at ≤ 2 group/s | Keep 8. If errors at 1/s, raise to 10 and investigate mesh |

After any change: update the "rate budget" unit test's drain/expectation
numbers, then run all three suites (`npm test`, `npm run test:reliability`,
`npm run test:soak`) and rebuild.

## Session 2 — COGS integration checks (~30 min)

1. `yarn build`, install the plugin into the COGS project, open the
   status panel. Expect: COGS connected, Bridge online, scenes fetched,
   duplicate-name warning if applicable.
2. Wire test behaviours to `Scene Shown`, `Cue Failed`, `Bridge Online`
   and confirm they fire (trigger a failure by cueing a nonsense scene
   name).
3. **Timer-throttle test (important):** fire cues with the plugin window
   visible → all land in <1s. Then hide/minimize the plugin window (or
   cover it with another app) for 2+ minutes while firing cues from COGS.
   Watch for late cues and the "Timers stalled…" warning in the panel
   afterwards.
   - If throttling occurs: the operating rule is "plugin window stays
     visible" (checklist item). Note severity — if it's bad, the fix
     direction is moving queue timing into a Web Worker (workers are
     throttled far less); flag it and we'll build it.
4. **Reconnect test:** with lights in a non-default state, edit a plugin
   config value in COGS (e.g. transition time) and separately restart
   COGS. The default scene must NOT refire mid-session (guard added in
   `b9312e0`); reconnection should be clean in the panel log.

## Session 3 — Show-pattern validation with the full rig (~45 min)

1. Program a realistic cue stack including the show's fastest sequence.
2. **Double/triple-GO:** hammer GO. Expect: lights land on the final cue,
   panel shows intermediate cues as "superseded", no stale looks appear
   late.
3. **Effects under cues:** party running → scene GO must land in ~1s;
   flicker + stop; show reset mid-effect (flicker must stop, default
   scene fires).
4. **Pull-the-plug drills:** power-cycle the bridge mid-"show" → panel
   goes Bridge UNREACHABLE, `Bridge Online=false` event fires, cues report
   FAILED (not silence); on recovery the panel flips back and new cues
   land. Brief WiFi interruption → same story.
5. **Bulb-level observation** (the part no API shows): from a GO, how
   simultaneous do the lights feel? Any bulb that the panel says ✓ but
   didn't change = ghost failure — count these.
6. Long-haul: leave the plugin + a repeating cue loop running for a few
   hours (rehearsal day background task); check the panel and memory use
   afterwards.

## Data to bring back for tuning

- Raw output of both probes (copy/paste is fine)
- Throttle test result (warning seen? cues late by how much?)
- Any FAILED/superseded oddities from the panel log
- Ghost-failure count and popcorn severity (subjective is fine)

## Escalation triggers (decided in advance)

- **Ghost failures observed** (bridge ✓ but bulb dark) → start the CLIP
  v2 migration for its event stream (confirmed state), or the
  zigbee2mqtt spike.
- **Need >2 clean group cues/s or tighter sync than the rig shows** →
  zigbee2mqtt own-hub prototype (£25 coordinator + 2 spare bulbs first).
- **Severe webview throttling** → Web Worker timer refactor.
- Otherwise: ship v0.3.x as-is, tag the release, run tech with the panel
  visible.
