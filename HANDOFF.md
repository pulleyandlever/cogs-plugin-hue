# Handoff: moving development to the show machine (2026-07-27)

Context for continuing work on another machine (with or without Claude
Code there). Read alongside HARDWARE-TEST-PLAN.md, HARDWARE-TEST-RESULTS.md
and QLAB-BUILD-PLAN.md.

## Machine setup

1. Node ≥ 18 (`node --version`).
2. In this repo folder: `npm install` (or `yarn`) — node_modules is not
   in the transfer archive. Needs internet once, ~2 min.
3. Sanity check the toolchain: `CI=true npx react-scripts test` (38
   tests), `npm run test:reliability` (8 scenarios), `npm run test:soak`.
4. Rebuild the plugin: `npx yarn build` → `build/dog.clockwork.hue/`,
   install by copying that folder into the COGS project's `plugins/`
   directory (or zip it: the repo's build step leaves a ready
   `build/dog.clockwork.hue.zip` after `zip -r` — see below).

## Show bridge

- IP `192.168.50.168` (router rt-be58; NO DHCP reservation yet — if it
  moves, rediscover with `arp -a | grep c4:29:96`). Bridge ID
  C42996FFFE643D68, BSB002, API v1.76.0.
- API key (devicetype `cogs-plugin-hue#test-laptop`):
  `k3dHB4vm3WO-EEyQtt4LETIkPMG9kUT7Dg4UyqTO`
- **Safety:** smart plugs are relays driving strobes/disco-ball motors
  (zones 85 Kitchen Strobe, 86 Kitchen Disco Balls; room 87 = whole
  rig). Never send group-wide on/off or effects to group 0 or room 87
  casually, and never include plug ids in probe groups. Probes must run
  with `TEST_LIGHTS=3,4,5,6,7,12,22,23,25,26` (the ten Hue Plays).
- Show-day checklist in README.md still applies (DHCP reservation and
  Hue auto-firmware-update are still outstanding).

## Where testing stands (HARDWARE-TEST-PLAN.md)

- **Session 1 (bridge characterization): DONE 2026-07-18.** Queue
  retuned from measurements; real 901-backoff bug found and fixed.
  Results in HARDWARE-TEST-RESULTS.md.
- **Session 2 (COGS integration): IN PROGRESS.** Blocked twice and
  fixed twice: (a) the show's cues were authored against a locally
  modified v0.2.1 plugin — v0.3.1 restores its six events
  (compat layer, see reference/v0.2.1-HueController.recovered.tsx for
  the recovered original); (b) the status panel needed a `window`
  declaration in the manifest to exist outside the dev simulator.
  **Next action: Session 2 test 1** — open the panel, expect COGS
  connected / Bridge online / scenes fetched / duplicate-names warning
  (the warning is a PASS on this bridge). Then event wiring, the
  timer-throttle test (hide the panel 2+ min while firing cues), and
  the reconnect/default-scene-refire guard test.
- **Session 3 (full-rig show patterns): NOT STARTED.** Rapid GO
  hammering, effects under cues, pull-the-plug drills, ghost-failure
  counting, long-haul soak.

## Open questions

1. **Show Scene duplicate semantics:** old plugin recalled ALL scenes
   matching a duplicated name (global "Blackout" = every zone's
   Blackout); v0.3 recalls the newest only. Check the show's cue list:
   if any plain `Show Scene` cue uses a name duplicated across zones,
   restore the recall-all behavior before trusting a run-through.
2. Four devices were unreachable on 2026-07-27: smart plugs 2 and 8
   (ids 9, 17), Essential lamps (ids 13, 20). Confirm whether they're
   part of the show or retired.

## Repo state

- All work through 2026-07-27 is committed on `main` (bridge tuning,
  901 fix, v0.2.1 compat layer, panel window fix, docs). No remote is
  configured — the .git history travels with this folder copy.
- `OldPlugin/` (untracked) is the April v0.2.1 build recovered from the
  show machine; its source map is where the compat semantics came from.
  The distilled reference is committed at
  `reference/v0.2.1-HueController.recovered.tsx`.
- QLab support is specced (QLAB-BUILD-PLAN.md) but not built.

## For Claude Code on the new machine

Project memory does not transfer automatically. The state above IS the
memory summary — on first session in this repo, offer to save it to
project memory. The plugin's operator is Jon (joncooperwriter@googlemail.com);
testing happens against live show hardware, so bias toward asking
before firing anything rig-wide.
