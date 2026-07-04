import {
  useCogsConfig,
  useCogsConnection,
  useCogsEvent,
  useWhenShowReset,
} from "@clockworkdog/cogs-client-react";
import { useEffect, useRef } from "react";
import { CogsConnectionParams } from "./App";
import { HueClient, HueStatusEvent } from "./hueClient";

// Thin wiring layer: creates a HueClient from the COGS config and
// forwards COGS events to it. All bridge logic (scene cache, command
// queue, effect timers) lives in HueClient, outside React.
export default function HueController({
  onStatus,
}: {
  onStatus?: (event: HueStatusEvent) => void;
}) {
  const connection = useCogsConnection<CogsConnectionParams>();

  // Ref keeps the client's callback stable so a re-rendered inline
  // onStatus prop doesn't tear down and recreate the client
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const apiKey = useCogsConfig(connection)["API Key"];
  const bridgeIpAddress = useCogsConfig(connection)["Bridge IP Address"];
  const defaultScene = useCogsConfig(connection)["Default Scene"];
  const transitionTime = useCogsConfig(connection)["Transition Time (Project Default)"];

  const clientRef = useRef<HueClient | null>(null);
  // The default scene must fire only on genuine startup. Without this
  // guard, any config re-delivery mid-show (COGS reconnect, a setting
  // edited) recreates the client and would blast the default scene
  // onstage.
  const defaultSceneShownRef = useRef(false);

  useEffect(() => {
    if (!apiKey || !bridgeIpAddress) {
      if (!bridgeIpAddress) console.warn("Bridge IP address not set");
      if (!apiKey) console.warn("API Key not set");
      return;
    }
    const client = new HueClient({
      bridgeIp: bridgeIpAddress,
      apiKey,
      defaultTransitionTime: transitionTime,
      onStatus: (event) => onStatusRef.current?.(event),
    });
    clientRef.current = client;

    client.refreshScenes().then((ok) => {
      if (ok && defaultScene && !defaultSceneShownRef.current) {
        defaultSceneShownRef.current = true;
        client.showScene(defaultScene);
      }
    });

    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [apiKey, bridgeIpAddress, transitionTime, defaultScene]);

  useCogsEvent(connection, "Show Scene", (value) => clientRef.current?.showScene(value));
  useCogsEvent(connection, "Start Flicker", (value) => clientRef.current?.startFlicker(value));
  useCogsEvent(connection, "Stop Flicker", () => clientRef.current?.stopFlicker());
  useCogsEvent(connection, "Start Colorloop", (value) => clientRef.current?.startColorloop(value));
  useCogsEvent(connection, "Start Party", (value) => clientRef.current?.startParty(value));
  useCogsEvent(connection, "Stop Effect", (value) => clientRef.current?.stopEffect(value));

  useWhenShowReset(connection, () => {
    const client = clientRef.current;
    if (!client) return;
    client.stopAllEffects();
    if (defaultScene) {
      client.showScene(defaultScene);
    }
  });

  return null;
}
