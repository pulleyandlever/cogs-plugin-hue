import React, { useCallback, useRef, useState } from "react";
import {
  useCogsConfig,
  useCogsConnection,
  useIsConnected,
} from "@clockworkdog/cogs-client-react";

import "./App.css";
import HueController from "./HueController";
import { HueStatusEvent } from "./hueClient";

export type CogsConnectionParams = {
  config: {
    "API Key": string;
    "Bridge IP Address": string;
    "Default Scene": string;
    "Transition Time (Project Default)": number;
  };
  inputEvents: {
    "Show Scene": string;
    "Show Scene On Group": string;
    "Blackout": string;
    "Strobe On": string;
    "Strobe Off": string;
    "Disco Balls On": string;
    "Disco Balls Off": string;
    "Start Flicker": string;
    "Stop Flicker": string;
    "Start Colorloop": string;
    "Start Party": string;
    "Stop Effect": string;
  };
  outputEvents: {
    "Scene Shown": string;
    "Cue Failed": string;
    "Bridge Online": boolean;
  };
};

interface LogEntry {
  id: number;
  time: string;
  level: "ok" | "info" | "warn" | "error";
  text: string;
}

const MAX_LOG_ENTRIES = 30;

export default function App() {
  const connection = useCogsConnection<CogsConnectionParams>();
  const isConnected = useIsConnected(connection);

  const apiKey = useCogsConfig(connection)["API Key"];
  const bridgeIpAddress = useCogsConfig(connection)["Bridge IP Address"];

  const [bridgeOnline, setBridgeOnline] = useState<boolean | undefined>(undefined);
  const [lastScene, setLastScene] = useState<{ name: string; outcome: string } | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextLogId = useRef(1);

  const addLog = useCallback((level: LogEntry["level"], text: string) => {
    const entry: LogEntry = {
      id: nextLogId.current++,
      time: new Date().toLocaleTimeString(),
      level,
      text,
    };
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  const handleStatus = useCallback(
    (event: HueStatusEvent) => {
      switch (event.type) {
        case "command": {
          const detail = event.errors?.length ? ` — ${event.errors.join("; ")}` : "";
          if (event.outcome === "sent") {
            addLog("ok", `${event.label} ✓`);
            if (event.scene) {
              setLastScene({ name: event.scene, outcome: "shown" });
              connection.sendEvent("Scene Shown", event.scene);
            }
          } else if (event.outcome === "superseded") {
            addLog("info", `${event.label} superseded by a newer cue`);
            if (event.scene) setLastScene({ name: event.scene, outcome: "superseded" });
          } else {
            addLog("error", `${event.label} FAILED${detail}`);
            if (event.scene) setLastScene({ name: event.scene, outcome: "FAILED" });
            connection.sendEvent("Cue Failed", `${event.label}${detail}`);
          }
          break;
        }
        case "bridge":
          setBridgeOnline(event.online);
          addLog(
            event.online ? "ok" : "error",
            event.online ? "Bridge reachable" : "Bridge UNREACHABLE"
          );
          connection.sendEvent("Bridge Online", event.online);
          break;
        case "warning":
          addLog("warn", event.message);
          break;
      }
    },
    [addLog, connection]
  );

  const bridgeStatusText =
    bridgeOnline === undefined ? "unknown" : bridgeOnline ? "online" : "UNREACHABLE";
  const bridgeStatusClass =
    bridgeOnline === undefined ? "dot-unknown" : bridgeOnline ? "dot-ok" : "dot-error";

  return (
    <div className="App">
      <div className="status-grid">
        <div className="status-row">
          <span className={`dot ${isConnected ? "dot-ok" : "dot-error"}`} />
          COGS: {isConnected ? "connected" : "disconnected"}
        </div>
        <div className="status-row">
          <span className={`dot ${bridgeStatusClass}`} />
          Bridge: {bridgeStatusText} {bridgeIpAddress ? `(${bridgeIpAddress})` : "(IP not set)"}
        </div>
        {!apiKey && <div className="status-row warn-text">API Key not set</div>}
        <div className="status-row">
          Last scene:{" "}
          {lastScene ? (
            <span className={lastScene.outcome === "FAILED" ? "error-text" : undefined}>
              {lastScene.name} ({lastScene.outcome})
            </span>
          ) : (
            "—"
          )}
        </div>
      </div>

      <div className="log">
        {log.length === 0 && <div className="log-entry log-info">No activity yet</div>}
        {log.map((entry) => (
          <div key={entry.id} className={`log-entry log-${entry.level}`}>
            <span className="log-time">{entry.time}</span> {entry.text}
          </div>
        ))}
      </div>

      <HueController onStatus={handleStatus} />
    </div>
  );
}
