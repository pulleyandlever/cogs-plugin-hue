// Instrumented access to the Hue bridge v1 API.
//
// The v1 API reports most failures inside a 200 response as
// [{ "error": { "type": ..., "address": ..., "description": ... } }]
// so transport-level checks alone say nothing about whether a command
// actually applied. Every call in the plugin goes through here so that
// each command's real outcome (applied / rejected / unreachable) and
// timing is visible in the console.

export interface HueCallResult {
  /** Transport succeeded AND the bridge reported no error objects */
  ok: boolean;
  httpStatus?: number;
  /** Bridge error descriptions, or the transport error message */
  errors: string[];
  durationMs: number;
  json?: unknown;
}

let callCounter = 0;

function extractV1Errors(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((entry) => entry && typeof entry === "object" && "error" in entry)
    .map((entry) => {
      const err = (entry as { error: { description?: string; address?: string } }).error;
      return `${err.description ?? "unknown error"}${err.address ? ` (${err.address})` : ""}`;
    });
}

export async function hueRequest(
  label: string,
  url: string,
  init?: RequestInit
): Promise<HueCallResult> {
  const id = ++callCounter;
  const method = init?.method ?? "GET";
  const started = performance.now();

  try {
    const response = await fetch(url, init);
    const durationMs = Math.round(performance.now() - started);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }

    const errors = extractV1Errors(json);
    if (!response.ok) {
      errors.unshift(`HTTP ${response.status}`);
    }
    const ok = errors.length === 0;

    if (ok) {
      console.log(`[Hue #${id}] ${label}: ${method} ${url} — OK in ${durationMs}ms`);
    } else {
      console.error(
        `[Hue #${id}] ${label}: ${method} ${url} — FAILED in ${durationMs}ms:`,
        errors.join("; ")
      );
    }

    return { ok, httpStatus: response.status, errors, durationMs, json };
  } catch (e) {
    const durationMs = Math.round(performance.now() - started);
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[Hue #${id}] ${label}: ${method} ${url} — UNREACHABLE in ${durationMs}ms:`,
      message
    );
    return { ok: false, errors: [message], durationMs };
  }
}

export function huePut(label: string, url: string, body: unknown): Promise<HueCallResult> {
  return hueRequest(label, url, { method: "PUT", body: JSON.stringify(body) });
}

export function hueGet(label: string, url: string): Promise<HueCallResult> {
  return hueRequest(label, url);
}
