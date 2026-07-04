// Framework-free Hue bridge client. Owns the scene cache, all effect
// timers, and routes every bridge command through the CommandQueue so
// that cues are never silently dropped by the bridge's rate limits and
// a newer cue always supersedes a stale one.

import { CommandQueue, QueuedCommandResult } from "./commandQueue";
import { hueGet, huePut } from "./hueApi";
import { HueScenes } from "./types";

export interface HueClientConfig {
  bridgeIp: string;
  apiKey: string;
  /** Project-default transition time in deciseconds (Hue units) */
  defaultTransitionTime?: number;
}

interface SceneInfo {
  id: string;
  name: string;
  lastupdated?: string;
}

const PUT_TIMEOUT_MS = 2000;

export class HueClient {
  private queue = new CommandQueue();
  private scenesByName = new Map<string, SceneInfo>();
  private strobeGroupId: string | undefined;
  private strobeKeepAlive: ReturnType<typeof setInterval> | undefined;
  private partyInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private config: HueClientConfig) {}

  private url(path: string): string {
    return `http://${this.config.bridgeIp}/api/${this.config.apiKey}/${path}`;
  }

  // ------------------------------------------------------------- scenes

  async refreshScenes(): Promise<boolean> {
    const result = await hueGet("Fetch scenes", this.url("scenes"));
    if (!result.ok || !result.json) return false;

    const byName = new Map<string, SceneInfo>();
    const duplicates = new Set<string>();
    for (const [id, scene] of Object.entries(result.json as HueScenes)) {
      const existing = byName.get(scene.name);
      if (existing) {
        duplicates.add(scene.name);
        // Names collide: keep the most recently updated scene
        if ((scene.lastupdated ?? "") > (existing.lastupdated ?? "")) {
          byName.set(scene.name, { id, name: scene.name, lastupdated: scene.lastupdated });
        }
      } else {
        byName.set(scene.name, { id, name: scene.name, lastupdated: scene.lastupdated });
      }
    }
    if (duplicates.size > 0) {
      console.warn(
        "[Hue] Duplicate scene names on bridge — using the most recently updated of each:",
        Array.from(duplicates).join(", ")
      );
    }
    this.scenesByName = byName;
    return true;
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
    const pipeIndex = eventValue.lastIndexOf("|");
    let sceneName = eventValue;
    let cueTransitionTime: number | undefined;
    if (pipeIndex !== -1) {
      const parsed = parseInt(eventValue.slice(pipeIndex + 1), 10);
      if (!isNaN(parsed)) {
        sceneName = eventValue.slice(0, pipeIndex);
        cueTransitionTime = parsed;
      }
    }

    const scene = await this.resolveScene(sceneName);
    if (!scene) {
      console.error(`[Hue] Show Scene "${sceneName}": no scene with this name on bridge`);
      return { outcome: "failed", errors: [`scene "${sceneName}" not found`] };
    }

    const body: Record<string, unknown> = { scene: scene.id };
    const transitionTime = cueTransitionTime ?? this.config.defaultTransitionTime;
    if (transitionTime !== undefined) {
      body.transitiontime = transitionTime;
    }

    return this.queue.enqueue({
      key: "group:0:action",
      kind: "group",
      priority: "cue",
      label: `Show Scene "${sceneName}"`,
      execute: () =>
        huePut(`Show Scene "${sceneName}"`, this.url("groups/0/action"), body, PUT_TIMEOUT_MS),
    });
  }

  // ------------------------------------------------------------ effects

  /** Event value: "groupId" or "groupId|sceneName" */
  async startFlicker(eventValue: string): Promise<void> {
    const [groupId, sceneName] = eventValue.split("|");
    if (!groupId) {
      console.error("[Hue] Start Flicker: missing group ID in event value", eventValue);
      return;
    }
    this.clearEffectTimers();
    this.strobeGroupId = groupId;
    const actionUrl = this.url(`groups/${groupId}/action`);

    if (sceneName) {
      const scene = await this.resolveScene(sceneName);
      if (scene) {
        void this.queue.enqueue({
          key: `group:${groupId}:action`,
          kind: "group",
          priority: "cue",
          label: `Flicker scene recall "${sceneName}"`,
          execute: () =>
            huePut(`Flicker scene recall "${sceneName}"`, actionUrl, {
              scene: scene.id,
              transitiontime: 0,
            }, PUT_TIMEOUT_MS),
        });
      } else {
        console.warn("Flicker: scene not found —", sceneName);
      }
    }

    const enqueueAlert = (priority: "cue" | "effect") =>
      this.queue.enqueue({
        key: `group:${groupId}:alert`,
        kind: "group",
        priority,
        label: "Flicker alert",
        execute: () => huePut("Flicker alert", actionUrl, { alert: "lselect" }, PUT_TIMEOUT_MS),
      });

    void enqueueAlert("cue");
    // lselect runs for 15s — re-send every 10s to keep it going indefinitely
    this.strobeKeepAlive = setInterval(() => void enqueueAlert("effect"), 10000);
  }

  async stopFlicker(): Promise<void> {
    const groupId = this.strobeGroupId;
    this.clearEffectTimers();
    if (groupId) {
      await this.queue.enqueue({
        key: `group:${groupId}:alert`,
        kind: "group",
        priority: "cue",
        label: "Stop flicker",
        execute: () =>
          huePut("Stop flicker", this.url(`groups/${groupId}/action`), { alert: "none" }, PUT_TIMEOUT_MS),
      });
    }
  }

  /** Event value: "groupId|brightness|saturation"  e.g. "0|254|254" */
  async startColorloop(eventValue: string): Promise<void> {
    const parts = eventValue.split("|");
    const groupId = parts[0];
    if (!groupId) {
      console.error("[Hue] Start Colorloop: missing group ID in event value", eventValue);
      return;
    }
    const bri = parseInt(parts[1], 10) || 254;
    const sat = parseInt(parts[2], 10) || 254;
    this.clearEffectTimers();

    await this.queue.enqueue({
      key: `group:${groupId}:action`,
      kind: "group",
      priority: "cue",
      label: "Start colorloop",
      execute: () =>
        huePut("Start colorloop", this.url(`groups/${groupId}/action`), {
          on: true,
          bri,
          sat,
          effect: "colorloop",
        }, PUT_TIMEOUT_MS),
    });
  }

  /** Event value: "groupId|speedMs"  e.g. "0|300" */
  async startParty(eventValue: string): Promise<void> {
    const [groupId, speedStr] = eventValue.split("|");
    if (!groupId) {
      console.error("[Hue] Start Party: missing group ID in event value", eventValue);
      return;
    }
    const speed = Math.max(100, parseInt(speedStr, 10) || 300);
    this.clearEffectTimers();

    const groupResult = await hueGet("Fetch group lights", this.url(`groups/${groupId}`));
    if (!groupResult.ok) return;
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
            huePut(`Party light ${lightId}`, this.url(`lights/${lightId}/state`), {
              on: true,
              hue: Math.floor(Math.random() * 65536),
              sat: 200 + Math.floor(Math.random() * 56),
              bri: 200 + Math.floor(Math.random() * 56),
              transitiontime: Math.max(1, Math.floor(speed / 100)),
            }, PUT_TIMEOUT_MS),
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
    await this.queue.enqueue({
      key: `group:${groupId}:action`,
      kind: "group",
      priority: "cue",
      label: "Stop effect",
      execute: () =>
        huePut("Stop effect", this.url(`groups/${groupId}/action`), { effect: "none" }, PUT_TIMEOUT_MS),
    });
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
          huePut(
            "Stop flicker (show reset)",
            this.url(`groups/${strobeGroupId}/action`),
            { alert: "none" },
            PUT_TIMEOUT_MS
          ),
      });
    }
  }

  private clearEffectTimers(): void {
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
    this.queue.dispose();
  }
}
