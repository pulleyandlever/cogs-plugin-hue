import {
  useCogsConfig,
  useCogsConnection,
  useCogsEvent,
  useWhenShowReset,
} from "@clockworkdog/cogs-client-react";
import { useCallback, useEffect, useState } from "react";
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

function findSceneByName(scenes: HueScenes, sceneName: string) {
  if (scenes) {
    return Object.entries(scenes).find(
      ([id, scene]) => scene.name === sceneName
    )?.[0];
  }
}

// Module-level refs so stop actions can always reach the running timers
let strobeGroupId: string | undefined;
let strobeKeepAlive: ReturnType<typeof setInterval> | undefined;
let partyInterval: ReturnType<typeof setInterval> | undefined;

function clearEffectIntervals() {
  strobeGroupId = undefined;
  if (strobeKeepAlive !== undefined) {
    clearInterval(strobeKeepAlive);
    strobeKeepAlive = undefined;
  }
  if (partyInterval !== undefined) {
    clearInterval(partyInterval);
    partyInterval = undefined;
  }
}

export default function HueController() {
  const connection = useCogsConnection<CogsConnectionParams>();

  const apiKey = useCogsConfig(connection)["API Key"];
  const bridgeIpAddress = useCogsConfig(connection)["Bridge IP Address"];
  const defaultScene = useCogsConfig(connection)["Default Scene"];
  const transitionTime = useCogsConfig(connection)["Transition Time (Project Default)"];

  const [scenes, setScenes] = useState<HueScenes>();

  const getScenesFromBridge = useCallback(async () => {
    if (!bridgeIpAddress) {
      console.warn("Bridge IP address not set");
      return;
    }
    if (!apiKey) {
      console.warn("API Key not set");
      return;
    }
    try {
      const response = await fetch(getScenesUrl(bridgeIpAddress, apiKey), {
        method: "GET",
      });

      if (response.status === 200) {
        const scenesData = (await response.json()) as HueScenes;
        setScenes(scenesData);
        return scenesData;
      }

      return undefined;
    } catch (e) {
      console.error("Error fetching Hue scenes", e);
      return undefined;
    }
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

      console.log("Showing scene with name", sceneName);
      try {
        let sceneId = scenes ? findSceneByName(scenes, sceneName) : undefined;
        console.log("Found sceneId", sceneId);

        // If can't find the scene, maybe we don't have the scenes yet or the scene is newly added - try and fetch again
        if (!sceneId) {
          console.log("Couldn't find scene ID - fetching scenes again");
          const refreshedScenes = await getScenesFromBridge();

          if (refreshedScenes) {
            sceneId = findSceneByName(refreshedScenes, sceneName);
            console.log("Now found sceneId", sceneId);
          }
        }

        // If we now have an ID - recall the scene
        if (sceneId) {
          const body: Record<string, unknown> = { scene: sceneId };
          if (effectiveTransitionTime !== undefined) {
            body.transitiontime = effectiveTransitionTime;
          }
          await fetch(recallSceneUrl(bridgeIpAddress, apiKey), {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
      } catch (e) {
        console.error("Failed to set scene", sceneName);
      }
    },
    [getScenesFromBridge, apiKey, bridgeIpAddress, scenes, transitionTime]
  );

  const showDefaultScene = useCallback(
    () => showScene(defaultScene),
    [showScene, defaultScene]
  );

  // "Start Flicker" event value: "groupId" or "groupId|sceneName"
  //   e.g. "1" — flicker group 1 at its current light state
  //   e.g. "1|Candlelight" — recall the Candlelight scene on group 1, then flicker
  //
  // Uses the bridge's native alert:lselect effect (firmware-level, ~2Hz).
  // When a scene name is given the scene is recalled first so the flicker
  // uses that scene's colours and brightness rather than whatever state the
  // lights happen to be in.
  const startFlicker = useCallback(
    async (eventValue: string) => {
      const [groupId, sceneName] = eventValue.split("|");
      const url = groupActionUrl(bridgeIpAddress, apiKey, groupId);

      clearEffectIntervals();
      strobeGroupId = groupId;

      // If a scene name was provided, recall it before triggering the flicker
      if (sceneName) {
        let sceneId = scenes ? findSceneByName(scenes, sceneName) : undefined;
        if (!sceneId) {
          const refreshed = await getScenesFromBridge();
          if (refreshed) sceneId = findSceneByName(refreshed, sceneName);
        }
        if (sceneId) {
          await fetch(url, {
            method: "PUT",
            body: JSON.stringify({ scene: sceneId, transitiontime: 0 }),
          }).catch((e) => console.error("Flicker scene recall error", e));
          // Short pause so lights settle into the scene before the alert fires
          await new Promise<void>((r) => setTimeout(r, 200));
        } else {
          console.warn("Flicker: scene not found —", sceneName);
        }
      }

      const sendAlert = () =>
        fetch(url, {
          method: "PUT",
          body: JSON.stringify({ alert: "lselect" }),
        }).catch((e) => console.error("Flicker error", e));

      await sendAlert();

      // lselect runs for 15s — re-send every 10s to keep it going indefinitely
      strobeKeepAlive = setInterval(sendAlert, 10000);
    },
    [apiKey, bridgeIpAddress, scenes, getScenesFromBridge]
  );

  // "Stop Flicker" value is "stop" (option type) — sends alert:none for an
  // immediate clean stop, then clears the keep-alive interval
  const stopFlicker = useCallback(async () => {
    const groupId = strobeGroupId;
    clearEffectIntervals();
    if (groupId) {
      await fetch(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        method: "PUT",
        body: JSON.stringify({ alert: "none" }),
      }).catch((e) => console.error("Stop flicker error", e));
    }
  }, [apiKey, bridgeIpAddress]);

  // "Start Colorloop" event value: "groupId|brightness|saturation"  e.g. "0|254|254"
  // Uses the bridge's native colorloop effect — zero plugin overhead
  const startColorloop = useCallback(
    async (eventValue: string) => {
      const parts = eventValue.split("|");
      const groupId = parts[0];
      const bri = parseInt(parts[1], 10) || 254;
      const sat = parseInt(parts[2], 10) || 254;

      clearEffectIntervals();

      await fetch(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        method: "PUT",
        body: JSON.stringify({ on: true, bri, sat, effect: "colorloop" }),
      }).catch((e) => console.error("Colorloop fetch error", e));
    },
    [apiKey, bridgeIpAddress]
  );

  // "Start Party" event value: "groupId|speedMs"  e.g. "0|300"
  // Fetches the group's individual light IDs then fires staggered random-hue updates
  const startParty = useCallback(
    async (eventValue: string) => {
      const [groupId, speedStr] = eventValue.split("|");
      const speed = Math.max(100, parseInt(speedStr, 10) || 300);
      const staggerMs = 150;

      clearEffectIntervals();

      let lightIds: string[] = [];
      try {
        const res = await fetch(groupUrl(bridgeIpAddress, apiKey, groupId));
        if (res.ok) {
          const data = await res.json();
          lightIds = data.lights ?? [];
        }
      } catch (e) {
        console.error("Failed to fetch group lights for party mode", e);
        return;
      }

      if (lightIds.length === 0) {
        console.warn("No lights found in group", groupId);
        return;
      }

      partyInterval = setInterval(() => {
        lightIds.forEach((lightId, i) => {
          setTimeout(() => {
            fetch(lightStateUrl(bridgeIpAddress, apiKey, lightId), {
              method: "PUT",
              body: JSON.stringify({
                on: true,
                hue: Math.floor(Math.random() * 65536),
                sat: 200 + Math.floor(Math.random() * 56),
                bri: 200 + Math.floor(Math.random() * 56),
                transitiontime: Math.max(1, Math.floor(speed / 100)),
              }),
            }).catch((e) => console.error("Party fetch error", e));
          }, i * staggerMs);
        });
      }, speed);
    },
    [apiKey, bridgeIpAddress]
  );

  // "Stop Effect" event value: "groupId"  e.g. "0"
  // Clears any running intervals and sends effect:"none" to the bridge
  const stopEffect = useCallback(
    async (groupId: string) => {
      clearEffectIntervals();
      await fetch(groupActionUrl(bridgeIpAddress, apiKey, groupId), {
        method: "PUT",
        body: JSON.stringify({ effect: "none" }),
      }).catch((e) => console.error("Stop effect fetch error", e));
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
  useCogsEvent(connection, "Start Flicker", startFlicker);
  useCogsEvent(connection, "Stop Flicker", stopFlicker);
  useCogsEvent(connection, "Start Colorloop", startColorloop);
  useCogsEvent(connection, "Start Party", startParty);
  useCogsEvent(connection, "Stop Effect", stopEffect);

  useWhenShowReset(connection, () => {
    clearEffectIntervals();
    showDefaultScene();
  });

  return null;
}
