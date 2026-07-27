// Pure parsers for COGS event values. Kept free of side effects so
// they can be unit tested exhaustively — malformed cue values must
// never produce a malformed bridge command.

export interface ShowSceneCue {
  sceneName: string;
  /** Transition time in deciseconds (Hue units: 10 = 1 second) */
  transitionTime?: number;
}

/** "sceneName" or "sceneName|transitionTime". A scene name may itself
 *  contain pipes — only a trailing "|<integer>" is treated as a
 *  transition time. */
export function parseShowSceneValue(value: string): ShowSceneCue {
  const pipeIndex = value.lastIndexOf("|");
  if (pipeIndex !== -1) {
    const parsed = parseInt(value.slice(pipeIndex + 1), 10);
    if (!isNaN(parsed)) {
      return { sceneName: value.slice(0, pipeIndex), transitionTime: parsed };
    }
  }
  return { sceneName: value };
}

export interface ShowSceneOnGroupCue {
  groupId?: string;
  sceneName?: string;
  /** Deciseconds. NOTE: a cue value of 0 is treated as "unset" by the
   *  engine (falls back to the project default) — this matches the
   *  v0.2.1 plugin the show's cues were authored against. */
  transitionTime?: number;
}

/** "groupId|sceneName" or "groupId|sceneName|transitionTime" (v0.2.1 compat) */
export function parseShowSceneOnGroupValue(value: string): ShowSceneOnGroupCue {
  const parts = value.split("|");
  const parsed = parts[2] !== undefined ? parseInt(parts[2], 10) : NaN;
  return {
    groupId: parts[0] || undefined,
    sceneName: parts[1] || undefined,
    transitionTime: isNaN(parsed) ? undefined : parsed,
  };
}

export interface BlackoutCue {
  groupId?: string;
  /** Deciseconds; 0 means "unset" — see ShowSceneOnGroupCue note */
  transitionTime?: number;
}

/** "groupId" or "groupId|transitionTime" (v0.2.1 compat) */
export function parseBlackoutValue(value: string): BlackoutCue {
  const parts = value.split("|");
  const parsed = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN;
  return {
    groupId: parts[0] || undefined,
    transitionTime: isNaN(parsed) ? undefined : parsed,
  };
}

/** "groupId" — Strobe On/Off, Disco Balls On/Off (v0.2.1 compat) */
export function parseGroupSwitchValue(value: string): { groupId?: string } {
  return { groupId: value.split("|")[0] || undefined };
}

export interface FlickerCue {
  groupId?: string;
  sceneName?: string;
}

/** "groupId" or "groupId|sceneName" */
export function parseFlickerValue(value: string): FlickerCue {
  const [groupId, sceneName] = value.split("|");
  return { groupId: groupId || undefined, sceneName: sceneName || undefined };
}

export interface ColorloopCue {
  groupId?: string;
  bri: number;
  sat: number;
}

/** "groupId|brightness|saturation" — brightness/saturation default 254 */
export function parseColorloopValue(value: string): ColorloopCue {
  const parts = value.split("|");
  return {
    groupId: parts[0] || undefined,
    bri: clampChannel(parseInt(parts[1], 10)),
    sat: clampChannel(parseInt(parts[2], 10)),
  };
}

function clampChannel(n: number): number {
  if (isNaN(n)) return 254;
  return Math.min(254, Math.max(1, n));
}

export interface PartyCue {
  groupId?: string;
  /** Milliseconds between frames, floor 100ms */
  speedMs: number;
}

/** "groupId|speedMs" — speed defaults to 300ms, floor 100ms */
export function parsePartyValue(value: string): PartyCue {
  const [groupId, speedStr] = value.split("|");
  return {
    groupId: groupId || undefined,
    speedMs: Math.max(100, parseInt(speedStr, 10) || 300),
  };
}
