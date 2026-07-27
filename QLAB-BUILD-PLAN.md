# Build Plan: QLab support via a headless OSC daemon

A specification for adding QLab show-control to this repo alongside the
existing COGS plugin. Written to be executed by a code model without
further design input. Follow it in phase order; each phase has
acceptance criteria that must pass before the next phase starts.

---

## 1. Goal and constraints

**Goal:** the same Hue engine must be drivable from either COGS (the
existing webview plugin, unchanged) or QLab (a new headless Node daemon
receiving OSC) — **one at a time, never both simultaneously** (two
controllers would double-spend the bridge's radio budget and fight over
effect state).

**Hard constraints:**

1. **Do not modify the engine.** These files are hardware-validated
   (2026-07-18 show-bridge characterization, see
   HARDWARE-TEST-RESULTS.md) and must not change in any way:
   - `src/hueClient.ts`
   - `src/commandQueue.ts`
   - `src/hueApi.ts`
   - `src/cueParsing.ts`
   - `src/types.ts`
2. **Do not modify the COGS shell** (`src/App.tsx`,
   `src/HueController.tsx`, `src/index.tsx`) or the CRA build. The COGS
   plugin must build and behave exactly as before
   (`npx yarn build` → `build/dog.clockwork.hue`).
3. **No new runtime dependencies.** The daemon uses only Node built-ins
   (`dgram`, `fs`, `path`, `http`) and the compiled engine. Node ≥ 18
   (global `fetch` is required by `hueApi.ts`).
4. All existing test suites must still pass unchanged:
   `CI=true npx react-scripts test`, `npm run test:reliability`,
   `npm run test:soak`.
5. New code follows the existing style: extensive "why" header comments,
   plain TypeScript, no classes where a function will do.

**Why this is low-risk:** the engine layer already has zero React/COGS
imports and already runs headless in Node — `tsconfig.queue.json`
compiles `src/hueClient.ts` to CommonJS and `mock-bridge/queue-test.js`
drives it directly. The daemon is a second consumer of exactly that
mechanism.

---

## 2. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │              ENGINE (frozen)             │
  COGS webview shell   │  hueClient.ts   scene cache, effects     │
  App.tsx ────────────▶│  commandQueue.ts rate budget, supersede  │──▶ Hue bridge
  HueController.tsx    │  hueApi.ts      instrumented fetch       │    (HTTP v1)
                       │  cueParsing.ts  pipe-string parsers      │
  QLab ──OSC/UDP──▶    │                                          │
  qlab/daemon.ts ─────▶└──────────────────────────────────────────┘
```

Both shells construct a `HueClient` and call the same six methods.
The daemon translates OSC messages into the **same pipe-string event
values** the COGS shell passes through, so `cueParsing.ts` remains the
single source of truth for cue grammar and every engine code path
stays identical between runtimes.

The engine API surface the daemon consumes (all already public):

```ts
new HueClient({ bridgeIp, apiKey, defaultTransitionTime?, onStatus? })
client.refreshScenes(): Promise<boolean>
client.showScene(value: string): Promise<QueuedCommandResult>   // "scene" | "scene|tt"
client.startFlicker(value: string): Promise<void>               // "group" | "group|scene"
client.stopFlicker(): Promise<void>
client.startColorloop(value: string): Promise<void>             // "group|bri|sat"
client.startParty(value: string): Promise<void>                 // "group|speedMs"
client.stopEffect(groupId: string): Promise<void>
client.stopAllEffects(): void
client.queueDepth: number
client.dispose(): void
```

`onStatus` receives `HueStatusEvent`:
`{type:"command", label, outcome:"sent"|"superseded"|"failed", scene?, errors?}`
| `{type:"bridge", online:boolean}` | `{type:"warning", message}`.

Note: the engine's 1s heartbeat/timer-throttle warning is webview-
specific; under Node timers are never throttled so it simply stays
silent. This is expected — do not remove or alter it.

---

## 3. Repository layout after the build

```
qlab/
  oscCodec.ts        OSC 1.0 encode/decode, no deps
  oscCodec.test.ts   unit tests (run under react-scripts test — see §7.1)
  dispatch.ts        OSC message → HueClient call mapping (pure)
  dispatch.test.ts   unit tests with a fake client
  config.ts          config file + env + CLI loading
  daemon.ts          entry point: lifecycle, UDP server, logging, feedback
  send-osc.js        plain-JS CLI utility to send one OSC message (manual
                     testing, and the fallback when QLab is unlicensed)
tsconfig.qlab.json   compiles qlab/*.ts + the engine to qlab/dist/
mock-bridge/
  qlab-test.js       integration suite: daemon + mock bridge + real UDP
hue-daemon.example.json   documented example config
QLAB-BUILD-PLAN.md   this file
README.md            gains a "Running from QLab" section (§9)
```

`tsconfig.qlab.json` (mirror of `tsconfig.queue.json`):

```json
{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "lib": ["es2020", "dom"],
    "rootDir": ".",
    "outDir": "qlab/dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": false
  },
  "files": ["qlab/daemon.ts"]
}
```

(`"dom"` is needed because `hueApi.ts` uses `fetch`/`AbortSignal`
types. `rootDir: "."` means output lands at `qlab/dist/qlab/daemon.js`
and `qlab/dist/src/hueClient.js` — that's fine.)

Unit-test placement caveat: `react-scripts test` only discovers tests
under `src/`. Put `oscCodec.test.ts` / `dispatch.test.ts` in `qlab/`
anyway and add a dedicated script that runs them with react-scripts'
jest by passing `--roots qlab` — if that fights CRA, the fallback is a
tiny self-contained assert-based runner `node qlab/dist/qlab/run-unit-tests.js`
invoked by `test:qlab` before the integration suite. Either mechanism
is acceptable; what is not acceptable is the codec/dispatch logic
having no automated tests.

New npm scripts in `package.json`:

```json
"build:qlab": "tsc -p tsconfig.qlab.json",
"start:qlab": "npm run build:qlab && node qlab/dist/qlab/daemon.js",
"test:qlab":  "npm run build:qlab && node mock-bridge/qlab-test.js"
```

---

## 4. Component spec: OSC codec (`qlab/oscCodec.ts`)

Minimal OSC 1.0 subset, hand-rolled (~150 lines), because QLab's
Network cues emit plain OSC messages and a dependency-free parser keeps
the show stack auditable.

```ts
export type OscArg = string | number | Buffer;
export interface OscMessage { address: string; args: OscArg[]; }

/** Decode a UDP datagram. Returns [] for anything unparseable — the
 *  daemon must never crash on garbage input. Unwraps #bundle packets
 *  recursively, ignoring timetags (execute immediately). */
export function decodeOscPacket(buf: Buffer): OscMessage[];

/** Encode one message (for feedback to QLab). Supports s, i, f args:
 *  integers encode as "i", other numbers as "f", strings as "s". */
export function encodeOscMessage(address: string, args: OscArg[]): Buffer;
```

Wire-format rules to implement exactly:

- Strings (address, type-tag string, `s` args): ASCII, NUL-terminated,
  padded with NULs to a 4-byte boundary. **A string whose length is
  already a multiple of 4 still gets 4 NUL bytes** (the terminator must
  exist).
- Type-tag string starts with `,`. Supported tags on decode:
  `i` (int32 BE), `f` (float32 BE), `s` (string), `b` (blob: int32 BE
  size + bytes + pad to 4 — decode and skip), `T` → arg `1`,
  `F` → arg `0`, `N`/`I` → skip (no bytes, no arg). Any other tag ⇒
  abandon the message (return nothing for it), never throw.
- A packet starting with `#bundle\0` is a bundle: 8-byte timetag, then
  repeated [int32 BE element size][element bytes]; each element is a
  packet (message or nested bundle) — recurse.
- A message missing its type-tag string (legacy OSC) ⇒ treat as
  zero-arg message.
- Every read must be bounds-checked; a truncated packet returns `[]`.

---

## 5. Component spec: dispatcher (`qlab/dispatch.ts`)

Pure function so it can be tested without sockets or a real client:

```ts
export interface DispatchTarget {   // structural subset of HueClient
  showScene(v: string): Promise<unknown>;
  startFlicker(v: string): Promise<void>;
  stopFlicker(): Promise<void>;
  startColorloop(v: string): Promise<void>;
  startParty(v: string): Promise<void>;
  stopEffect(g: string): Promise<void>;
  stopAllEffects(): void;
  refreshScenes(): Promise<boolean>;
}
export interface DispatchContext { defaultScene?: string; }
export type DispatchResult =
  | { handled: true; description: string }
  | { handled: false; reason: string };

export function dispatchOsc(
  msg: OscMessage, client: DispatchTarget, ctx: DispatchContext
): DispatchResult;
```

Argument coercion first: every arg is normalized with
`const str = (a: OscArg) => typeof a === "number" ? String(Math.trunc(a)) : String(a)`
(floats from QLab's typed fields must not become `"1.0"` when the
engine expects `"1"`; scene names pass through untouched — do NOT
truncate through `str()` a string arg).

Address map (exhaustive; anything else ⇒ `handled:false`):

| Address | Args | Engine call (pipe strings built exactly as shown) |
| --- | --- | --- |
| `/hue/scene` | `s scene`, optional `i tt` (deciseconds) | `showScene(tt !== undefined ? \`${scene}\|${tt}\` : scene)` — note a scene arg already containing `\|tt` passes straight through, same grammar as COGS |
| `/hue/flicker/start` | `i\|s group`, optional `s scene` | `startFlicker(scene ? \`${g}\|${scene}\` : g)` |
| `/hue/flicker/stop` | none | `stopFlicker()` |
| `/hue/colorloop/start` | `group`, optional `i bri`, optional `i sat` | `startColorloop([g, bri, sat].filter(x => x !== undefined).join("\|"))` (engine defaults bri/sat to 254) |
| `/hue/party/start` | `group`, optional `i speedMs` | `startParty(speed !== undefined ? \`${g}\|${speed}\` : g)` (engine defaults 300ms, floor 100) |
| `/hue/effect/stop` | `group` | `stopEffect(g)` |
| `/hue/reset` | none | `stopAllEffects()`; then if `ctx.defaultScene`, `showScene(ctx.defaultScene)` — mirrors the COGS show-reset handler in HueController.tsx |
| `/hue/scenes/refresh` | none | `refreshScenes()` (for mid-tech scene edits) |

Missing required args ⇒ `handled:false` with a reason naming the
address and expected signature (this string is logged and, if feedback
is on, sent to QLab as a warning). Extra args beyond the spec are
ignored. Dispatch never throws.

---

## 6. Component spec: config and daemon lifecycle

### 6.1 Config (`qlab/config.ts`)

Precedence: CLI `--config <path>` > `./hue-daemon.json` > env vars >
defaults. Env names reuse the probe conventions where they exist.

| Key (JSON) | Env | Default | Meaning |
| --- | --- | --- | --- |
| `bridgeIp` | `BRIDGE_IP` | — (required) | Hue bridge IP |
| `apiKey` | `HUE_API_KEY` | — (required) | Hue API key |
| `oscPort` | `OSC_PORT` | `7700` | UDP listen port (avoid 53000/53001 — QLab's own) |
| `bindAddress` | — | `0.0.0.0` | UDP bind address |
| `defaultScene` | — | unset | fired once at startup + on `/hue/reset` |
| `defaultTransitionTime` | — | unset | deciseconds, passed to HueClient |
| `sceneRefreshSeconds` | — | `30` | periodic `refreshScenes()`; `0` disables |
| `feedback` | — | unset | `{ "host": "...", "port": n }` — OSC status messages back to QLab; absent = disabled |

Missing required keys ⇒ print a one-screen usage message listing all
keys and exit code 1. Ship `hue-daemon.example.json` with every key
present and commented via adjacent `_comment` keys.

### 6.2 Daemon (`qlab/daemon.ts`)

Startup sequence:

1. Load config; print a banner including bridge IP, OSC port, and this
   warning verbatim: `"Run EITHER this daemon OR the COGS plugin — never
   both at once. Two controllers double-spend the bridge radio budget."`
2. Construct `HueClient` with an `onStatus` handler (→ §6.3).
3. `refreshScenes()`; on failure retry every 5s until the first
   success (bridge may still be booting at venue power-up), logging
   each failure. After the **first successful** fetch, fire
   `defaultScene` exactly once if configured (guard flag — mirrors
   `defaultSceneShownRef` in HueController.tsx; later reconnects or
   `/hue/scenes/refresh` must NOT refire it).
4. Bind the UDP socket. On each datagram: `decodeOscPacket` →
   `dispatchOsc` per message → log the result. Unparseable datagrams
   log one warning line (rate-limit: max 1 per 5s to survive a port
   scan without log spam).
5. Start the periodic scene refresh if enabled.

Shutdown (`SIGINT`/`SIGTERM`): stop the refresh timer, close the
socket, `client.dispose()` (clears effect timers and drains nothing —
dispose does not send bridge commands, which is correct: killing the
daemon mid-show must not change the lights), then exit 0. Must complete
in < 2s.

### 6.3 Logging and OSC feedback

Every log line: `[HH:MM:SS] LEVEL message` to stdout (`hueApi.ts`
already logs each bridge call with its own format; leave that as-is).
Status events map to logs:

- `command` outcome `sent` → INFO with label (+ scene name);
  `superseded` → INFO; `failed` → ERROR with the error strings.
- `bridge` → INFO `Bridge ONLINE` / ERROR `Bridge OFFLINE`.
- `warning` → WARN.

If `feedback` is configured, also send (fire-and-forget UDP, errors
logged once, never fatal):

| Event | OSC message |
| --- | --- |
| scene confirmed | `/hue/event/scene-shown` `s:<sceneName>` |
| any cue failed | `/hue/event/cue-failed` `s:<label + errors joined>` |
| bridge state | `/hue/event/bridge-online` `i:0\|1` |
| engine warning | `/hue/event/warning` `s:<message>` |

QLab can listen for these to trigger an operator-alert cue.

### 6.4 `qlab/send-osc.js`

Plain-JS CLI (requires `qlab/dist/qlab/oscCodec.js`):
`node qlab/send-osc.js 127.0.0.1:7700 /hue/scene "Blackout" 0` —
args that parse as integers are sent as `i`, everything else as `s`.
This is the manual test tool and the QLab-unlicensed fallback.

---

## 7. Testing process

### 7.1 Unit tests (Phase 1–2 gates)

**Codec:** round-trip property tests (encode → decode returns the same
address/args) over a table of ≥ 10 messages covering: zero args; string
lengths of 3/4/5 chars (padding edge); int/float/mixed args; a bundle
containing two messages; nested bundle. Plus the canonical OSC spec
vector — `/oscillator/4/frequency` with `f 440.0` must encode to the
exact 32 bytes given in the OSC 1.0 spec. Plus fuzz: 500 random
buffers (length 0–64) must return `[]` or valid messages, never throw.

**Dispatcher:** fake client recording calls. Cover: every address in
the §5 table (args → exact pipe string received by the fake); float
group id `1.0` → `"1"`; scene names containing spaces and `|`; missing
required args → `handled:false`; unknown address → `handled:false`;
`/hue/reset` with and without `defaultScene` in context.

### 7.2 Integration suite (`mock-bridge/qlab-test.js`, Phase 4 gate)

Follow the existing harness pattern from `queue-test.js`: spawn
`mock-bridge/server.js` on a random port, spawn the daemon as a child
process with env-var config pointing at it, send real UDP datagrams,
assert via the mock's `/_test/log` and `/_test/state`. Also open a UDP
listener as the fake QLab feedback target. Scenarios:

- **Q-A Startup:** daemon comes up, fetches scenes, fires the default
  scene exactly once (mock log: exactly one `groups/0/action` PUT with
  a scene body).
- **Q-B Cue:** `/hue/scene "Cue 2" 0` → scene applied; feedback
  listener receives `/hue/event/scene-shown`.
- **Q-C Rapid GO:** 5 `/hue/scene` cues back-to-back → nothing dropped
  by the mock, final state is the last cue, intermediate cues
  superseded (same assertions as reliability Scenario B).
- **Q-D Failure path:** `/hue/scene "No Such Scene"` → daemon stays up,
  ERROR logged, `/hue/event/cue-failed` received.
- **Q-E Effects:** `/hue/party/start 0 200` → light PUTs arriving;
  `/hue/effect/stop 0` → zero PUTs in a 3s quiet window, queue depth 0
  (mirror of reliability Scenario H).
- **Q-F Garbage:** 20 random datagrams + a valid cue → the cue still
  lands; daemon did not crash.
- **Q-G Shutdown:** SIGTERM → exit 0 within 2s, no PUTs after exit.
- **Q-H Reset:** with a default scene configured, party running,
  `/hue/reset` → effect stops AND default scene fires (this is the
  second and last permitted firing of the default scene).

Suite output mirrors `queue-test.js` (per-scenario ✓/✗ + summary,
non-zero exit on failure).

### 7.3 Regression gate (every phase)

`CI=true npx react-scripts test` (26 tests), `npm run test:reliability`
(8 scenarios), `npm run test:soak`, and `npx yarn build` must all still
pass with zero changes to their files.

### 7.4 Manual + hardware validation (human, after Phase 4)

1. Laptop, real bridge: `npm run start:qlab` with the show-bridge
   config, then drive every address once with `send-osc.js`.
   **Safety on this bridge: only cue scenes scoped to zones 81–84, and
   only group ids 81–84 for effects — never group 0 or room 87, and
   never any group containing smart plugs (ids 8, 11 and friends);
   they are relays driving strobes/disco balls.**
2. Show machine, QLab: verify the QLab license includes Network cues
   (unlicensed QLab restricts them — check before scheduling; the
   `send-osc.js` fallback proves the daemon while a license is
   sorted). Configure per §9, run a cue stack including a rapid
   double-GO and a party → scene interrupt.
3. Long-haul: daemon + a repeating QLab loop for a few hours; check RSS
   memory and log for oddities (parallels the COGS Session 3 item).

---

## 8. Build phases and acceptance criteria

| Phase | Deliverables | Gate to pass |
| --- | --- | --- |
| 0 | `tsconfig.qlab.json`, npm scripts, empty `qlab/` | `npm run build:qlab` compiles engine + a stub daemon.ts; §7.3 green |
| 1 | `oscCodec.ts` + tests | §7.1 codec tests green |
| 2 | `dispatch.ts` + tests | §7.1 dispatcher tests green |
| 3 | `config.ts`, `daemon.ts`, `send-osc.js`, example config | daemon runs against the mock bridge manually; a `send-osc` scene cue lands |
| 4 | `mock-bridge/qlab-test.js` | all Q-scenarios green; §7.3 green |
| 5 (optional) | HTTP status page: `GET /status` JSON (bridge online, queue depth, last 50 events) + minimal HTML on `statusPort` | manual check |
| 6 | README "Running from QLab" section (§9 content), CHANGELOG note | docs review |

Commit per phase, message prefix `qlab:`.

---

## 9. QLab operator setup (content for README)

1. Daemon machine (normally the show machine itself) must be on the
   bridge's LAN. Start: `npm run start:qlab` (or
   `node qlab/dist/qlab/daemon.js --config hue-daemon.json`).
2. QLab 5: Workspace Settings → Network → add an OSC network patch →
   destination `127.0.0.1`, port `7700` (or the daemon machine's IP).
3. Each lighting cue = a Network cue on that patch with a custom OSC
   message, e.g.:
   - `/hue/scene "Act 1 Preset" 10`
   - `/hue/flicker/start 83 "Candlelight"` / `/hue/flicker/stop`
   - `/hue/party/start 84 300` / `/hue/effect/stop 84`
   - `/hue/reset` (panic / top-of-show)
4. Optional operator alerting: set `feedback` in the config to QLab's
   listen port (53000) and wire QLab OSC triggers on
   `/hue/event/cue-failed` and `/hue/event/bridge-online`.
5. Never run the COGS plugin and the daemon against the same bridge at
   the same time.
6. The show-day checklist in the README applies unchanged **except**
   "keep the plugin window visible" — the daemon has no window and no
   timer throttling; that risk does not exist in QLab mode.

---

## 10. Known gotchas (read before coding)

- **OSC string padding** is the classic bug: a 4-char string still
  needs 4 more NUL bytes. The round-trip tests exist to catch this.
- **QLab sends typed args**: an int field arrives as `i`, but operators
  often type everything into one string — both arg shapes in §5 must
  work, and `/hue/scene` must accept the `"name|tt"` single-string form.
- **Float coercion**: `String(1.0)` is `"1"` in JS — but only because
  of `Math.trunc` in the coercion helper; keep it.
- **Don't route feedback sends through the CommandQueue** — it budgets
  bridge radio traffic; UDP to QLab is free and must not consume tokens.
- **`refreshScenes()` failure at startup is normal** at venues (bridge
  boots slower than the show machine). The retry loop is required, not
  defensive fluff.
- **Default-scene refire** caused a real onstage incident risk in COGS
  (see guard comment in HueController.tsx); the once-only guard in §6.2
  is load-bearing. Test Q-A and Q-H together assert it.
- The engine emits `bridge` events only when a call's outcome flips the
  state — with `sceneRefreshSeconds` on, offline detection latency is
  bounded by that interval when no cues are flowing.
