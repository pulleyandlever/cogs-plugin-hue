# COGS Philips Hue plugin

## How to use

- Download the plugin from [Releases](https://github.com/clockwork-dog/cogs-plugin-hue/releases/latest)
- Unzip into the `plugins` folder in your COGS project
- In COGS, open the project and go to `Setup` > `Settings` and enable `Hue Control`
- Click the `Hue Control` icon that appears on the left
- Set your API key and local IP address for your Philips Hue bridge

You can now use the `Hue Control: Show Scene` action in your behaviours.

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
npm run test:reliability            # regression suite: HueClient + queue vs mock bridge
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
