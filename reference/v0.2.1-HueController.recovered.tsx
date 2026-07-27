import {
  useCogsConfig,
  useCogsConnection,
  useCogsEvent,
  useWhenShowReset,
} from "@clockworkdog/cogs-client-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CogsConnectionParams } from "./App";
import { HueScenes } from "./types";

const getScenesUrl = (ipAddress: string, apiKey: string) =>
  `http://${ipAddress}/api/${apiKey}/scenes`;

const recallSceneUrl = (ipAddress: string, apiKey: string) =>
  `http://${ipAddress}/api/${apiKey}/groups/0/action`;

const groupActionUrl = (ipAddress: string, apiKey: string, groupId: string) =>
  `http://${ipAddress}/api/${apiKey}/groups/${groupId}/action`;

const groupUrl = (ipAddress: string, apiKey: string, groupId: string) =>
  `http://${ipAddress}/api/${apiKey}/groups/${groupId}`;

const lightStateUrl = (ipAddress: string, apiKey: string, lightId: string) =>
  `http://${ipAddress}/api/${apiKey}/lights/${lightId}/state`;

// Returns ALL scene IDs that match the name.
function findSceneIdsByName(scenes: HueScenes, sceneName: string): string[] {
  if (!scenes) return [];
  return Object.entries(scenes)
    .filter(([, scene]) => scene.name === sceneName)
    .map(([id]) => id);
}

// Returns scene IDs whose name matches AND whose lights overlap with the given set.
function findSceneIdsForLights(
  scenes: HueScenes,
  sceneName: string,
  lightIds: string[]
): string[] {
  if (!scenes) return [];
  const lightSet = new Set(lightIds);
  return Object.entries(scenes)
    .filter(
      ([, scene]) =>
        scene.name === sceneName &&
        scene.lights?.some((l) => lightSet.has(l))
    )
    .map(([id]) => id);
}

// Module-level state for effects that use intervals
let partyInterval: ReturnType<typeof setInterval> | undefined;
// Prevents overlapping flicker sequences
let flickerRunning = false;

function clearEffectIntervals() {
  flickerRunning = false;
  if (partyInterval !== undefined) {
    clearInterval(partyInterval);
    partyInterval = undefined;
  }
}

// Send a PUT to the bridge. Awaits and drains the response so the HTTP
// connection is released back to the pool immediately.
async function bridgePut(url: string, body: object): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await res.text();
    return res.ok;
  } catch (e) {
    console.error("Bridge PUT failed", url, e);
    return false;
  }
}

// Send a GET to the bridge. Always drains the response body — even on
// non-200 — so connections are never left hanging in the pool.
async function bridgeGet<T = unknown>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) {
      return JSON.parse(text) as T;
    }
    return undefined;
  } catch (e) {
    console.error("Bridge GET failed", url, e);
    return undefined;
  }
}

export default function HueController() {
  const connection = useCogsConnection<CogsConnectionParams>();

  const apiKey = useCogsConfig(connection)["API Key"];
  const bridgeIpAddress = useCogsConfig(connection)["Bridge IP Address"];
  const defaultScene = useCogsConfig(connection)["Default Scene"];
  const transitionTime =
    useCogsConfig(connection)["Transition Time (Project Default)"];

  const [scenes, setScenes] = useState<HueScenes>();

  // A ref mirrors the scenes state so async callbacks always see the latest
  // value without needing scenes in their dependency array.
  const scenesRef = useRef<HueScenes | undefined>(undefined);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  // Cache of groupId → lightIds so we don't re-fetch every time
  const groupLightsCache = useRef<Record<string, string[]>>({});

  const getGroupLights = useCallback(
    async (groupId: string): Promise<string[]> => {
      if (groupLightsCache.current[groupId]) {
        return groupLightsCache.current[groupId];
      }
      const data = await bridgeGet<{ lights?: string[] }>(
        groupUrl(bridgeIpAddress, apiKey, groupId)
      );
      const lights = data?.lights ?? [];
      if (lights.length > 0) {
        groupLightsCache.current[groupId] = lights;
      }
      return lights;
    },
    [apiKey, bridgeIpAddress]
  );

  const getScenesFromBridge = useCallback(async () => {
    if (!bridgeIpAddress || !apiKey) {
      console.warn("Bridge IP or API Key not set");
      return;
    }
    const scenesData = await bridgeGet<HueScenes>(
      getScenesUrl(bridgeIpAddress, apiKey)
    );
    if (scenesData) {
      setScenes(scenesData);
      scenesRef.current = scenesData;
      return scenesData;
    }
    return undefined;
  }, [apiKey, bridgeIpAddress]);

  const showScene = useCallback(
    async (eventValue: string) => {
      const pipeIndex = eventValue.lastIndexOf("|");
      let sceneName: string;
      let cueTransitionTime: number | undefined;

      if (pipeIndex !== -1) {
        sceneName = eventValue.slice(0, pipeIndex);
        const parsed = parseInt(eventValue.slice(pipeIndex + 1), 10);
        if (!isNaN(parsed)) {
          cueTransitionTime = parsed;
        }
      } else {
        sceneName = eventValue;
      }

      const effectiveTransitionTime = cueTransitionTime ?? transitionTime;

      try {
        let currentScenes = scenesRef.current;
        let sceneIds = findSceneIdsByName(currentScenes ?? {}, sceneName);

        if (sceneIds.length === 0) {
          currentScenes = await getScenesFromBridge();
          if (currentScenes) {
            sceneIds = findSceneIdsByName(currentScenes, sceneName);
          }
        }

        for (const sceneId of sceneIds) {
          const body: Record<string, unknown> = { scene: sceneId };
          if (effectiveTransitionTime !== undefined) {
            body.transitiontime = effectiveTransitionTime;
          }
          await bridgePut(recallSceneUrl(bridgeIpAddress, apiKey), body);
        }
      } catch (e) {
        console.error("Failed to set scene", sceneName);
      }
    },
    [getScenesFromBridge, apiKey, bridgeIpAddress, transitionTime]
  );

  const showDefaultScene = useCallback(
    () => showScene(defaultScene),
    [showScene, defaultScene]
  );

  // "Show Scene On Group" — only recalls scenes whose lights overlap with
  // the target group, avoiding unnecessary bridge traffic.
  const showSceneOnGroup = useCallback(
    async (eventValue: string) => {
      const parts = eventValue.split("|");
      const groupId = parts[0];
      const sceneName = parts[1];
      const cueTransitionTime =
        parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
      const effectiveTransitionTime =
        !cueTransitionTime || isNaN(cueTransitionTime)
          ? transitionTime
          : cueTransitionTime;

      if (!groupId || !sceneName) {
        console.warn(
          "Show Scene On Group: expected 'groupId|sceneName'",
          eventValue
        );
        return;
      }

      try {
        const groupLights = await getGroupLights(groupId);

        let currentScenes = scenesRef.current;
        let sceneIds = findSceneIdsForLights(
          currentScenes ?? {},
          sceneName,
          groupLights
        );

        if (sceneIds.length === 0) {
          currentScenes = await getScenesFromBridge();
          if (currentScenes) {
            sceneIds = findSceneIdsForLights(
              currentScenes,
              sceneName,
              groupLights
            );
          }
        }

        if (sceneIds.length > 0) {
          for (const sceneId of sceneIds) {
            const body: Record<string, unknown> = { scene: sceneId };
            if (effectiveTransitionTime !== undefined) {
              body.transitiontime = effectiveTransitionTime;
            }
            await bridgePut(
              groupActionUrl(bridgeIpAddress, apiKey, groupId),
              body
            );
          }
        } else {
          console.warn("Show Scene On Group: scene not found —", sceneName);
        }
      } catch (e) {
        console.error("Failed to set scene on group", groupId, sceneName);
      }
    },
    [
      getScenesFromBridge,
      getGroupLights,
      apiKey,
      bridgeIpAddress,
      transitionTime,
    ]
  );

  // "Start Flicker" event value: "groupId"  e.g. "83"
  //
  // Uses the bridge's native alert:select — the bridge flashes the lights
  // once and returns them to their current state automatically. No state
  // capture or restore needed. 3 commands total.
  const startFlicker = useCallback(
    async (eventValue: string) => {
      if (flickerRunning) return;

      const groupId = eventValue.split("|")[0];
      if (!groupId) {
        console.warn("Start Flicker: no groupId in event value", eventValue);
        return;
      }

      flickerRunning = true;

      const url = groupActionUrl(bridgeIpAddress, apiKey, groupId);
      const wait = (ms: number) =>
        new Promise<void>((r) => setTimeout(r, ms));

      try {
        await bridgePut(url, { alert: "select" });
        await wait(600);
        await bridgePut(url, { alert: "select" });
        await wait(600);
        await bridgePut(url, { alert: "select" });
      } finally {
        flickerRunning = false;
      }
    },
    [apiKey, bridgeIpAddress]
  );

  // "Stop Flicker" — resets the guard flag
  const stopFlicker = useCallback(async () => {
    clearEffectIntervals();
  }, []);

  // "Start Colorloop" event value: "groupId|brightness|saturation"
  const startColorloop = useCallback(
    async (eventValue: string) => {
      const parts = eventValue.split("|");
      const groupId = parts[0];
      if (!groupId) {
        console.warn("Start Colorloop: no groupId in event value", eventValue);
        return;
      }
      const bri = parseInt(parts[1], 10) || 254;
      const sat = parseInt(parts[2], 10) || 254;

      clearEffectIntervals();

      // Do not include `on: true` — that causes the bridge to switch on every
      // light in the group and can bleed across zones sharing the same room.
      // Colorloop applies only to lights that are already on.
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        bri,
        sat,
        effect: "colorloop",
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // "Start Party" event value: "groupId|speedMs"
  const startParty = useCallback(
    async (eventValue: string) => {
      const [groupId, speedStr] = eventValue.split("|");
      const speed = Math.max(100, parseInt(speedStr, 10) || 300);
      const staggerMs = 150;

      clearEffectIntervals();

      const lightIds = await getGroupLights(groupId);

      if (lightIds.length === 0) {
        console.warn("No lights found in group", groupId);
        return;
      }

      partyInterval = setInterval(() => {
        lightIds.forEach((lightId, i) => {
          setTimeout(() => {
            bridgePut(lightStateUrl(bridgeIpAddress, apiKey, lightId), {
              on: true,
              hue: Math.floor(Math.random() * 65536),
              sat: 200 + Math.floor(Math.random() * 56),
              bri: 200 + Math.floor(Math.random() * 56),
              transitiontime: Math.max(1, Math.floor(speed / 100)),
            });
          }, i * staggerMs);
        });
      }, speed);
    },
    [apiKey, bridgeIpAddress, getGroupLights]
  );

  // "Blackout" event value: "groupId" or "groupId|transitionTime"
  const blackout = useCallback(
    async (eventValue: string) => {
      const parts = eventValue.split("|");
      const groupId = parts[0];
      const cueTransitionTime =
        parts[1] !== undefined ? parseInt(parts[1], 10) : undefined;
      const effectiveTransitionTime =
        !cueTransitionTime || isNaN(cueTransitionTime)
          ? transitionTime
          : cueTransitionTime;

      const body: Record<string, unknown> = { on: false };
      if (effectiveTransitionTime !== undefined) {
        body.transitiontime = effectiveTransitionTime;
      }

      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), body);
    },
    [apiKey, bridgeIpAddress, transitionTime]
  );

  // "Stop Effect" event value: "groupId"
  const stopEffect = useCallback(
    async (groupId: string) => {
      clearEffectIntervals();
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        effect: "none",
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // "Strobe On" event value: "groupId"  e.g. "85"
  const strobeOn = useCallback(
    async (eventValue: string) => {
      const groupId = eventValue.split("|")[0];
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        on: true,
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // "Strobe Off" event value: "groupId"  e.g. "85"
  const strobeOff = useCallback(
    async (eventValue: string) => {
      const groupId = eventValue.split("|")[0];
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        on: false,
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // "Disco Balls On" event value: "groupId"  e.g. "86"
  const discoBallsOn = useCallback(
    async (eventValue: string) => {
      const groupId = eventValue.split("|")[0];
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        on: true,
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // "Disco Balls Off" event value: "groupId"  e.g. "86"
  const discoBallsOff = useCallback(
    async (eventValue: string) => {
      const groupId = eventValue.split("|")[0];
      await bridgePut(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        on: false,
      });
    },
    [apiKey, bridgeIpAddress]
  );

  // Find scenes on first load
  useEffect(() => {
    if (
      !scenes &&
      apiKey !== undefined &&
      bridgeIpAddress !== undefined &&
      defaultScene !== undefined
    ) {
      getScenesFromBridge().then(() => {
        if (defaultScene) {
          showDefaultScene();
        }
      });
    }
  }, [
    scenes,
    apiKey,
    bridgeIpAddress,
    defaultScene,
    getScenesFromBridge,
    showDefaultScene,
  ]);

  // Clean up any running intervals when the component unmounts
  useEffect(() => {
    return () => {
      clearEffectIntervals();
    };
  }, []);

  useCogsEvent(connection, "Show Scene", showScene);
  useCogsEvent(connection, "Show Scene On Group", showSceneOnGroup);
  useCogsEvent(connection, "Blackout", blackout);
  useCogsEvent(connection, "Start Flicker", startFlicker);
  useCogsEvent(connection, "Stop Flicker", stopFlicker);
  useCogsEvent(connection, "Start Colorloop", startColorloop);
  useCogsEvent(connection, "Start Party", startParty);
  useCogsEvent(connection, "Stop Effect", stopEffect);
  useCogsEvent(connection, "Strobe On", strobeOn);
  useCogsEvent(connection, "Strobe Off", strobeOff);
  useCogsEvent(connection, "Disco Balls On", discoBallsOn);
  useCogsEvent(connection, "Disco Balls Off", discoBallsOff);

  useWhenShowReset(connection, () => {
    clearEffectIntervals();
    showDefaultScene();
  });

  return null;
}
