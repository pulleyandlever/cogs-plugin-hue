// Framework-free Hue bridge client. Owns the scene cache, all effect
// timers, and routes every bridge command through the CommandQueue so
// that cues are never silently dropped by the bridge's rate limits and
// a newer cue always supersedes a stale one.

import { CommandQueue, ExecuteResult, QueuedCommandResult } from "./commandQueue";
import {
  parseBlackoutValue,
  parseColorloopValue,
  parseFlickerValue,
  parseGroupSwitchValue,
  parsePartyValue,
  parseShowSceneOnGroupValue,
  parseShowSceneValue,
} from "./cueParsing";
import { HueCallResult, hueGet, huePut } from "./hueApi";
import { HueScenes } from "./types";

/** Emitted by HueClient so the UI and COGS can observe what's happening */
export type HueStatusEvent =
  | {
      type: "command";
      label: string;
      outcome: "sent" | "superseded" | "failed";
      /** Set for Show Scene commands */
      scene?: string;
      errors?: string[];
    }
  | { type: "bridge"; online: boolean }
  | { type: "warning"; message: string };

export interface HueClientConfig {
  bridgeIp: string;
  apiKey: string;
  /** Project-default transition time in deciseconds (Hue units) */
  defaultTransitionTime?: number;
  onStatus?: (event: HueStatusEvent) => void;
}

interface SceneInfo {
  id: string;
  name: string;
  lastupdated?: string;
  lights?: string[];
}

const PUT_TIMEOUT_MS = 2000;

export class HueClient {
  private queue = new CommandQueue();
  private scenesByName = new Map<string, SceneInfo>();
  /** Every scene per name (duplicates kept) — Show Scene On Group needs
   *  all of them to pick the right zone's copy */
  private scenesByNameAll = new Map<string, SceneInfo[]>();
  private groupLightsCache = new Map<string, string[]>();
  private strobeGroupId: string | undefined;
  private strobeKeepAlive: ReturnType<typeof setInterval> | undefined;
  private partyInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastBeat = Date.now();
  private lastThrottleWarning = 0;
  private effectGeneration = 0;

  constructor(private config: HueClientConfig) {
    // Watchdog: browsers throttle timers in hidden/backgrounded windows
    // (down to once per minute), which would stall the command queue's
    // pacing and all effects. We can't prevent it from inside the page,
    // but we can make it visible: if the 1s heartbeat fires very late,
    // warn the operator via the status panel.
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      const lateMs = now - this.lastBeat - 1000;
      if (lateMs > 3000 && now - this.lastThrottleWarning > 60000) {
        this.lastThrottleWarning = now;
        const message = `Timers stalled for ${(lateMs / 1000).toFixed(
          1
        )}s — the browser is likely throttling the plugin window. Keep it visible during shows.`;
        console.warn(`[Hue] ${message}`);
        this.emit({ type: "warning", message });
      }
      this.lastBeat = now;
    }, 1000);
  }

  private bridgeOnline: boolean | undefined;

  private url(path: string): string {
    return `http://${this.config.bridgeIp}/api/${this.config.apiKey}/${path}`;
  }

  private emit(event: HueStatusEvent): void {
    this.config.onStatus?.(event);
  }

  /** Bridge is "online" when it answered at all — even with an error body */
  private noteBridgeResult(result: HueCallResult): void {
    const online = result.httpStatus !== undefined;
    if (online !== this.bridgeOnline) {
      this.bridgeOnline = online;
      this.emit({ type: "bridge", online });
    }
  }

  /** PUT wrapped with bridge health tracking, for use inside queue commands */
  private trackedPut(label: string, path: string, body: unknown): Promise<ExecuteResult> {
    return huePut(label, this.url(path), body, PUT_TIMEOUT_MS).then((result) => {
      this.noteBridgeResult(result);
      return result;
    });
  }

  /** Emit a command status event when a queued command settles */
  private reported(
    label: string,
    scene: string | undefined,
    promise: Promise<QueuedCommandResult>
  ): Promise<QueuedCommandResult> {
    void promise.then((result) =>
      this.emit({ type: "command", label, outcome: result.outcome, scene, errors: result.errors })
    );
    return promise;
  }

  // ------------------------------------------------------------- scenes

  async refreshScenes(): Promise<boolean> {
    const result = await hueGet("Fetch scenes", this.url("scenes"));
    this.noteBridgeResult(result);
    if (!result.ok || !result.json) return false;

    const byName = new Map<string, SceneInfo>();
    const byNameAll = new Map<string, SceneInfo[]>();
    const duplicates = new Set<string>();
    for (const [id, scene] of Object.entries(result.json as HueScenes)) {
      const info: SceneInfo = {
        id,
        name: scene.name,
        lastupdated: scene.lastupdated,
        lights: scene.lights,
      };
      const all = byNameAll.get(scene.name);
      if (all) all.push(info);
      else byNameAll.set(scene.name, [info]);

      const existing = byName.get(scene.name);
      if (existing) {
        duplicates.add(scene.name);
        // Names collide: keep the most recently updated scene
        if ((scene.lastupdated ?? "") > (existing.lastupdated ?? "")) {
          byName.set(scene.name, info);
        }
      } else {
        byName.set(scene.name, info);
      }
    }
    if (duplicates.size > 0) {
      const message = `Duplicate scene names on bridge — using the most recently updated of each: ${Array.from(
        duplicates
      ).join(", ")}`;
      console.warn(`[Hue] ${message}`);
      this.emit({ type: "warning", message });
    }
    this.scenesByName = byName;
    this.scenesByNameAll = byNameAll;
    return true;
  }

  private async getGroupLights(groupId: string): Promise<string[]> {
    const cached = this.groupLightsCache.get(groupId);
    if (cached) return cached;
    const result = await hueGet("Fetch group lights", this.url(`groups/${groupId}`));
    this.noteBridgeResult(result);
    const lights = (result.json as { lights?: string[] } | undefined)?.lights ?? [];
    if (lights.length > 0) this.groupLightsCache.set(groupId, lights);
    return lights;
  }

  /** All scenes with this name whose lights overlap the given set */
  private matchScenesForLights(sceneName: string, lightIds: string[]): SceneInfo[] {
    const lightSet = new Set(lightIds);
    return (this.scenesByNameAll.get(sceneName) ?? []).filter((s) =>
      s.lights?.some((l) => lightSet.has(l))
    );
  }

  private async resolveScene(sceneName: string): Promise<SceneInfo | undefined> {
    let scene = this.scenesByName.get(sceneName);
    if (!scene) {
      // Maybe the scene was added since the last fetch
      await this.refreshScenes();
      scene = this.scenesByName.get(sceneName);
    }
    return scene;
  }

  // --------------------------------------------------------------- cues

  /** Event value: "sceneName" or "sceneName|transitionTimeDeciseconds" */
  async showScene(eventValue: string): Promise<QueuedCommandResult> {
    const { sceneName, transitionTime: cueTransitionTime } = parseShowSceneValue(eventValue);

    const scene = await this.resolveScene(sceneName);
    if (!scene) {
      const message = `Show Scene "${sceneName}": no scene with this name on bridge`;
      console.error(`[Hue] ${message}`);
      this.emit({
        type: "command",
        label: `Show Scene "${sceneName}"`,
        outcome: "failed",
        scene: sceneName,
        errors: [`scene "${sceneName}" not found`],
      });
      return { outcome: "failed", errors: [`scene "${sceneName}" not found`] };
    }

    const body: Record<string, unknown> = { scene: scene.id };
    const transitionTime = cueTransitionTime ?? this.config.defaultTransitionTime;
    if (transitionTime !== undefined) {
      body.transitiontime = transitionTime;
    }

    const label = `Show Scene "${sceneName}"`;
    return this.reported(
      label,
      sceneName,
      this.queue.enqueue({
        key: "group:0:action",
        kind: "group",
        priority: "cue",
        label,
        execute: () => this.trackedPut(label, "groups/0/action", body),
      })
    );
  }

  // ------------------------------------------- v0.2.1 compat cues
  // The April-2026 show was authored against a locally modified v0.2.1
  // plugin (source recovered from its build's source map). These events
  // reproduce its semantics exactly, but routed through the queue.

  /** Event value: "groupId|sceneName" or "groupId|sceneName|transitionTime".
   *  Recalls EVERY scene with the name whose lights overlap the group —
   *  duplicate scene names across zones are deliberate in the show, and
   *  this overlap filter is how the right zone's copy gets picked. */
  async showSceneOnGroup(eventValue: string): Promise<QueuedCommandResult> {
    const { groupId, sceneName, transitionTime: cueTt } = parseShowSceneOnGroupValue(eventValue);
    const label = `Show Scene On Group "${sceneName ?? "?"}" (group ${groupId ?? "?"})`;
    if (!groupId || !sceneName) {
      const error = `expected "groupId|sceneName", got "${eventValue}"`;
      console.error(`[Hue] ${label}: ${error}`);
      this.emit({ type: "command", label, outcome: "failed", scene: sceneName, errors: [error] });
      return { outcome: "failed", errors: [error] };
    }

    const groupLights = await this.getGroupLights(groupId);
    let matches = this.matchScenesForLights(sceneName, groupLights);
    if (matches.length === 0) {
      await this.refreshScenes();
      matches = this.matchScenesForLights(sceneName, groupLights);
    }
    if (matches.length === 0) {
      const error = `no scene named "${sceneName}" overlaps group ${groupId}`;
      console.error(`[Hue] ${label}: ${error}`);
      this.emit({ type: "command", label, outcome: "failed", scene: sceneName, errors: [error] });
      return { outcome: "failed", errors: [error] };
    }

    // v0.2.1 quirk preserved deliberately: a cue transition of 0 falls
    // back to the project default (the show's cues were authored with
    // this behavior in effect).
    const transitionTime = cueTt ? cueTt : this.config.defaultTransitionTime;
    const body: Record<string, unknown> = {};
    if (transitionTime !== undefined) body.transitiontime = transitionTime;

    // One queued command sends all matching scene recalls sequentially.
    // Typically 1 scene, occasionally 2-3 duplicates: at the measured
    // effective bridge cost (~2 tokens per group command) that still
    // fits inside this command's cost-5 budget with the overload
    // backoff as the safety net.
    return this.reported(
      label,
      sceneName,
      this.queue.enqueue({
        key: `group:${groupId}:action`,
        kind: "group",
        priority: "cue",
        label,
        execute: async () => {
          const errors: string[] = [];
          for (const scene of matches) {
            const result = await this.trackedPut(label, `groups/${groupId}/action`, {
              ...body,
              scene: scene.id,
            });
            errors.push(...result.errors);
          }
          return { ok: errors.length === 0, errors };
        },
      })
    );
  }

  /** Event value: "groupId" or "groupId|transitionTime" — group off */
  async blackout(eventValue: string): Promise<QueuedCommandResult> {
    const { groupId, transitionTime: cueTt } = parseBlackoutValue(eventValue);
    const label = `Blackout (group ${groupId ?? "?"})`;
    if (!groupId) {
      const error = `expected "groupId" or "groupId|transitionTime", got "${eventValue}"`;
      console.error(`[Hue] ${label}: ${error}`);
      this.emit({ type: "command", label, outcome: "failed", errors: [error] });
      return { outcome: "failed", errors: [error] };
    }
    // Same v0.2.1 transition-0 fallback quirk as showSceneOnGroup
    const transitionTime = cueTt ? cueTt : this.config.defaultTransitionTime;
    const body: Record<string, unknown> = { on: false };
    if (transitionTime !== undefined) body.transitiontime = transitionTime;
    return this.reported(
      label,
      undefined,
      this.queue.enqueue({
        key: `group:${groupId}:action`,
        kind: "group",
        priority: "cue",
        label,
        execute: () => this.trackedPut(label, `groups/${groupId}/action`, body),
      })
    );
  }

  /** Strobe On/Off and Disco Balls On/Off: plain group power switch.
   *  These groups are smart-plug relays (strobes, mirror-ball motors). */
  async setGroupPower(eventValue: string, on: boolean, eventName: string): Promise<QueuedCommandResult> {
    const { groupId } = parseGroupSwitchValue(eventValue);
    const label = `${eventName} (group ${groupId ?? "?"})`;
    if (!groupId) {
      const error = `expected "groupId", got "${eventValue}"`;
      console.error(`[Hue] ${label}: ${error}`);
      this.emit({ type: "command", label, outcome: "failed", errors: [error] });
      return { outcome: "failed", errors: [error] };
    }
    return this.reported(
      label,
      undefined,
      this.queue.enqueue({
        key: `group:${groupId}:action`,
        kind: "group",
        priority: "cue",
        label,
        execute: () => this.trackedPut(label, `groups/${groupId}/action`, { on }),
      })
    );
  }

  // ------------------------------------------------------------ effects

  /** Event value: "groupId" or "groupId|sceneName" */
  async startFlicker(eventValue: string): Promise<void> {
    const { groupId, sceneName } = parseFlickerValue(eventValue);
    if (!groupId) {
      console.error("[Hue] Start Flicker: missing group ID in event value", eventValue);
      return;
    }

    // v0.2.1 compat: a bare "groupId" (no scene) is the old one-shot
    // triple flash — alert:select ×3, 600ms apart, ends on its own. The
    // April show's cues rely on it self-ending; they never send Stop
    // Flicker. "groupId|sceneName" keeps the v0.3 indefinite behavior.
    if (!sceneName) {
      this.clearEffectTimers();
      const generation = this.effectGeneration;
      const flash = (n: number) =>
        this.reported(
          `Flicker flash ${n}/3 (group ${groupId})`,
          undefined,
          this.queue.enqueue({
            // Distinct keys so the three flashes don't coalesce away
            key: `group:${groupId}:alert:${n}`,
            kind: "group",
            priority: "effect",
            label: `Flicker flash ${n}/3`,
            execute: () =>
              this.trackedPut(`Flicker flash ${n}/3`, `groups/${groupId}/action`, {
                alert: "select",
              }),
          })
        );
      void flash(1);
      setTimeout(() => generation === this.effectGeneration && void flash(2), 600);
      setTimeout(() => generation === this.effectGeneration && void flash(3), 1200);
      return;
    }

    this.clearEffectTimers();
    const generation = this.effectGeneration;
    this.strobeGroupId = groupId;

    if (sceneName) {
      const scene = await this.resolveScene(sceneName);
      // Another effect op arrived while we were resolving — stand down
      if (generation !== this.effectGeneration) return;
      if (scene) {
        const label = `Flicker scene recall "${sceneName}"`;
        void this.reported(
          label,
          sceneName,
          this.queue.enqueue({
            key: `group:${groupId}:action`,
            kind: "group",
            priority: "cue",
            label,
            execute: () =>
              this.trackedPut(label, `groups/${groupId}/action`, {
                scene: scene.id,
                transitiontime: 0,
              }),
          })
        );
      } else {
        console.warn("Flicker: scene not found —", sceneName);
        this.emit({ type: "warning", message: `Flicker: scene not found — ${sceneName}` });
      }
    }

    const enqueueAlert = (priority: "cue" | "effect") =>
      this.queue.enqueue({
        key: `group:${groupId}:alert`,
        kind: "group",
        priority,
        label: "Flicker alert",
        execute: () =>
          this.trackedPut("Flicker alert", `groups/${groupId}/action`, { alert: "lselect" }),
      });

    void this.reported(`Start Flicker (group ${groupId})`, undefined, enqueueAlert("cue"));
    // lselect runs for 15s — re-send every 10s to keep it going indefinitely
    this.strobeKeepAlive = setInterval(() => void enqueueAlert("effect"), 10000);
  }

  async stopFlicker(): Promise<void> {
    const groupId = this.strobeGroupId;
    this.clearEffectTimers();
    if (groupId) {
      await this.reported(
        "Stop Flicker",
        undefined,
        this.queue.enqueue({
          key: `group:${groupId}:alert`,
          kind: "group",
          priority: "cue",
          label: "Stop flicker",
          execute: () =>
            this.trackedPut("Stop flicker", `groups/${groupId}/action`, { alert: "none" }),
        })
      );
    }
  }

  /** Event value: "groupId|brightness|saturation"  e.g. "0|254|254" */
  async startColorloop(eventValue: string): Promise<void> {
    const { groupId, bri, sat } = parseColorloopValue(eventValue);
    if (!groupId) {
      console.error("[Hue] Start Colorloop: missing group ID in event value", eventValue);
      return;
    }
    this.clearEffectTimers();

    await this.reported(
      `Start Colorloop (group ${groupId})`,
      undefined,
      this.queue.enqueue({
        key: `group:${groupId}:action`,
        kind: "group",
        priority: "cue",
        label: "Start colorloop",
        // No `on: true` — v0.2.1 deliberately omitted it: with zones
        // sharing a room, `on` switches on every light in the group and
        // bleeds across zones. Colorloop applies to lights already on.
        execute: () =>
          this.trackedPut("Start colorloop", `groups/${groupId}/action`, {
            bri,
            sat,
            effect: "colorloop",
          }),
      })
    );
  }

  /** Event value: "groupId|speedMs"  e.g. "0|300" */
  async startParty(eventValue: string): Promise<void> {
    const { groupId, speedMs: speed } = parsePartyValue(eventValue);
    if (!groupId) {
      console.error("[Hue] Start Party: missing group ID in event value", eventValue);
      return;
    }
    this.clearEffectTimers();
    const generation = this.effectGeneration;

    const groupResult = await hueGet("Fetch group lights", this.url(`groups/${groupId}`));
    this.noteBridgeResult(groupResult);
    // Another effect op arrived while we were fetching — stand down
    // (installing our interval now would leak it forever)
    if (generation !== this.effectGeneration) return;
    if (!groupResult.ok) {
      this.emit({
        type: "command",
        label: `Start Party (group ${groupId})`,
        outcome: "failed",
        errors: groupResult.errors,
      });
      return;
    }
    const lightIds: string[] =
      (groupResult.json as { lights?: string[] } | undefined)?.lights ?? [];
    if (lightIds.length === 0) {
      console.warn("No lights found in group", groupId);
      return;
    }

    // Each frame enqueues one update per light at effect priority. The
    // queue paces them within the radio budget, and per-light coalescing
    // keys mean a slow bridge drops stale frames instead of building a
    // backlog. Cues always jump ahead of party traffic.
    const sendFrame = () => {
      for (const lightId of lightIds) {
        void this.queue.enqueue({
          key: `light:${lightId}:state`,
          kind: "light",
          priority: "effect",
          label: `Party light ${lightId}`,
          execute: () =>
            this.trackedPut(`Party light ${lightId}`, `lights/${lightId}/state`, {
              on: true,
              hue: Math.floor(Math.random() * 65536),
              sat: 200 + Math.floor(Math.random() * 56),
              bri: 200 + Math.floor(Math.random() * 56),
              transitiontime: Math.max(1, Math.floor(speed / 100)),
            }),
        });
      }
    };
    sendFrame();
    this.partyInterval = setInterval(sendFrame, speed);
  }

  /** Event value: "groupId"  e.g. "0" */
  async stopEffect(groupId: string): Promise<void> {
    this.clearEffectTimers();
    this.queue.cancelPending("light:");
    await this.reported(
      `Stop Effect (group ${groupId})`,
      undefined,
      this.queue.enqueue({
        key: `group:${groupId}:action`,
        kind: "group",
        priority: "cue",
        label: "Stop effect",
        execute: () =>
          this.trackedPut("Stop effect", `groups/${groupId}/action`, { effect: "none" }),
      })
    );
  }

  /** Show reset: stop all running effects (timers, pending frames, live flicker) */
  stopAllEffects(): void {
    const strobeGroupId = this.strobeGroupId;
    this.clearEffectTimers();
    this.queue.cancelPending("light:");
    if (strobeGroupId) {
      void this.queue.enqueue({
        key: `group:${strobeGroupId}:alert`,
        kind: "group",
        priority: "cue",
        label: "Stop flicker (show reset)",
        execute: () =>
          this.trackedPut("Stop flicker (show reset)", `groups/${strobeGroupId}/action`, {
            alert: "none",
          }),
      });
    }
  }

  private clearEffectTimers(): void {
    // Invalidates any effect start still awaiting a network call, so it
    // can't install its timer after being superseded (which would leak
    // an uncancellable "ghost" interval — found by the 30-minute soak).
    this.effectGeneration++;
    this.strobeGroupId = undefined;
    if (this.strobeKeepAlive !== undefined) {
      clearInterval(this.strobeKeepAlive);
      this.strobeKeepAlive = undefined;
    }
    if (this.partyInterval !== undefined) {
      clearInterval(this.partyInterval);
      this.partyInterval = undefined;
    }
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  dispose(): void {
    this.clearEffectTimers();
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.queue.dispose();
  }
}
