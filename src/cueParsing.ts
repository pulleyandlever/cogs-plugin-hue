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
