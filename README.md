# COGS Philips Hue plugin

## How to use

- Download the plugin from [Releases](https://github.com/clockwork-dog/cogs-plugin-hue/releases/latest)
- Unzip into the `plugins` folder in your COGS project
- In COGS, open the project and go to `Setup` > `Settings` and enable `Hue Control`
- Click the `Hue Control` icon that appears on the left
- Set your API key and local IP address for your Philips Hue bridge

You can now use the `Hue Control: Show Scene` action in your behaviours.

## Events (COGS → plugin)

All values are strings. Fields are separated by `|`. Transition times are in
**deciseconds** — Hue's native unit — so `10` = 1 second, `0` = instant snap.

| Event | Value format | Example | Notes |
| --- | --- | --- | --- |
| Show Scene | `sceneName` or `sceneName\|transitionTime` | `Blackout\|0` | Transition time overrides the project default |
| Start Flicker | `groupId` or `groupId\|sceneName` | `1\|Candlelight` | Recalls the scene first, then flickers (bridge-native, ~2Hz) |
| Stop Flicker | `stop` | `stop` | Stops cleanly (alert off) |
| Start Colorloop | `groupId\|brightness\|saturation` | `0\|254\|254` | Brightness/saturation 1–254, default 254 |
| Start Party | `groupId\|speedMs` | `0\|300` | Random hues per light; rate is capped to the bridge budget |
| Stop Effect | `groupId` | `0` | Stops colorloop/party on the group |

Group `0` is the bridge's built-in all-lights group.

Scene names should be unique on the bridge. If duplicates exist the plugin
uses the most recently updated one and logs a warning in its status panel.

## Events (plugin → COGS)

Usable in behaviours, e.g. to alert the operator when something fails:

| Event | Value | Fires when |
| --- | --- | --- |
| Scene Shown | scene name (string) | A Show Scene cue was confirmed by the bridge |
| Cue Failed | description (string) | A cue failed after retry, or a scene name wasn't found |
| Bridge Online | boolean | Bridge reachability changes (in either direction) |

## Reliability model

Every bridge command goes through a client-side queue that mirrors the Hue
bridge's real rate budget (~1 group command/sec, ~10 light commands/sec,
shared). The queue is pass-through when idle (no added latency); under a
burst of cues, **the newest cue always wins** — stale cues are superseded and
never sent, never fired late, and never retried once superseded. Cues always
jump ahead of effect traffic. The plugin panel shows bridge health, the last
scene outcome, and a live activity log.

## Local development in a browser

- Place this folder in the `client-content` folder in your COGS project.
- Add a "Custom" Media Master called "Hue Control dev" in COGS and select the `Custom` type
- Select `cogs-plugin-hue/build` as the content directory

```
yarn start "Hue Control dev"
```

This will connect to COGS as a simulator for the Media Master called "Hue Control dev".

## Build for your COGS project

```
yarn build
```

This folder can now be used as a plugin. Place the entire folder in the `plugins` folder of your COGS project and follow the "How to use" instructions above.

## Reliability testing with the mock bridge

`mock-bridge/` contains a mock Hue bridge (v1 API subset) that models the real
bridge's radio budget (~1 group command/sec, ~10 light commands/sec, shared).
Over-budget commands are silently dropped but still return HTTP 200 — matching
the worst real bridge behavior. No dependencies; plain Node.

```
npm test                            # unit tests (cue parsing, queue guarantees)
npm run test:reliability            # regression suite: HueClient + queue vs mock bridge
npm run test:soak                   # randomized chaos soak (SOAK_SECONDS=3600 for an hour)
```

This compiles the real `HueClient`/`CommandQueue` from `src/` and drives the
cue-reliability scenarios through them (spawns its own mock bridge on :8091).
All four must pass: well-spaced cues land with no queue delay, rapid cues are
never dropped (stale ones are superseded, final state = last cue), a cue
preempts a running effect, and duplicate scene names resolve to the newest.

The historical failure modes can still be demonstrated by bypassing the queue:

```
node mock-bridge/server.js          # starts on http://127.0.0.1:8090
node mock-bridge/burst-test.js      # un-queued behavior: reproduces the old bugs
```

Test-only endpoints: `GET /_test/state`, `GET /_test/log`, `POST /_test/reset`.

Note: Hue `transitiontime` values are in **deciseconds** (10 = 1 second).
