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
node mock-bridge/server.js          # starts on http://127.0.0.1:8090
node mock-bridge/burst-test.js      # runs the cue-reliability scenarios
```

The burst test reproduces the known failure modes of the current un-queued
implementation: rapid cues dropped (B), effects starving scene cues (C), and
duplicate scene names addressing the wrong lights (D). Once the command queue
lands (Phase 1), the same scenarios become the regression suite and are
expected to pass instead.

Test-only endpoints: `GET /_test/state`, `GET /_test/log`, `POST /_test/reset`.

Note: Hue `transitiontime` values are in **deciseconds** (10 = 1 second).
