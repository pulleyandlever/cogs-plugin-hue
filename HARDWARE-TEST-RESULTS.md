# Hardware Test Results

## Session 1 — Show bridge characterization (2026-07-18)

Bridge: BSB002 fw 1976154040, api 1.76.0, id C42996FFFE643D68, IP
192.168.50.168 (no DHCP reservation yet — rediscover via
`arp -a | grep c4:29:96`). 25 devices paired. Probes run with
`TEST_LIGHTS=3,4,5,6,7,12,22,23,25,26` (the 10 Hue Plays) — the
reachable smart plugs (8, 11) drive strobes/disco balls and must never
be included in probe groups.

### bridge-probe.js (bursts)

- Latency baseline (well-spaced light commands): min 42 / median 123 /
  p90 129 / max 129 ms.
- 20 light commands at 20/s to one light: 0 errors, final state correct,
  median 41 ms.
- Group-command ladder at 1/s, 2/s, 4/s, 10/s (6 commands each): 0
  errors at every rate, all 10 lights at final bri every time.
- 5 group commands back-to-back: all accepted (~107–172 ms each), lights
  jumped straight to the final value — intermediate states DROPPED
  (coalesced), nothing applied late. Good for cue stacks: no stale looks.

### bridge-probe2.js (sustained)

- 2 group/s for 10 s: 0 errors, no latency growth, sentinel settle 176 ms.
- 5 group/s for 10 s: 0 errors, no latency growth, sentinel settle 194 ms.
- ~12 group/s for 12 s: collapse — 112/131 commands rejected with
  `901: Internal error, 404`; sentinel never settled.
- Mixed load (10 light/s + 1 group/s): 3/8 group commands got errors —
  same starvation the home bridge showed.

**Conclusion:** the show bridge with its full 25-device mesh behaves like
the 3-bulb home bridge: clean sustained at 5 group/s, collapse ~12/s,
mixed-load damage at 10 light/s + 1 group/s. Effective group cost ≈ 2
tokens at a 10 token/s refill.

### Tuning applied (per HARDWARE-TEST-PLAN.md gate: clean at ≥ 4 group/s)

- `COSTS.group` 8 → 5 in `src/commandQueue.ts` (≈1.8 cues/s sustained,
  2 instant back-to-back GOs). Rate-budget unit test updated.
- Mock bridge `GROUP_COST` 8 → 2 to match measured behavior (it modeled
  Philips' documented ~1 group/s, far more conservative than reality).
- **Bug found & fixed:** `hueApi.ts` dropped the numeric error type when
  formatting bridge errors, so the queue's 901-overload detection
  (`e.includes("901")`) could never match — the real 901 description is
  "Internal error, 404", no "901" in it. The 800 ms overload backoff had
  effectively never engaged; it only appeared to work under the old
  cost-8 budget because token starvation delayed retries by accident.
  Error strings now include the type (`901: Internal error, 404 (...)`).
- All suites pass after the changes: 26/26 unit, 8/8 reliability
  scenarios, soak PASS. Plugin rebuilt (`build/dog.clockwork.hue`).

## Session 2 — COGS integration checks

Not yet run. Needs the COGS app open with the plugin installed
(timer-throttle, event wiring, reconnect tests — see
HARDWARE-TEST-PLAN.md).

## Session 3 — Show-pattern validation

Not yet run. Wants the full rig and ideally the venue network.
