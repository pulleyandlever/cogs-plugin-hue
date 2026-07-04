import { CommandQueue, EnqueueOptions, ExecuteResult } from "./commandQueue";

// Helper: an execute() we can resolve from the test, to hold the queue
// mid-flight deterministically.
function controlledExecute() {
  let release: (result: ExecuteResult) => void = () => {};
  const calls = { count: 0 };
  const execute = () => {
    calls.count++;
    return new Promise<ExecuteResult>((resolve) => {
      release = resolve;
    });
  };
  return { execute, calls, release: (result: ExecuteResult = { ok: true, errors: [] }) => release(result) };
}

const immediateOk = () => Promise.resolve<ExecuteResult>({ ok: true, errors: [] });

function cmd(overrides: Partial<EnqueueOptions>): EnqueueOptions {
  return {
    key: "light:1:state",
    kind: "light",
    priority: "cue",
    label: "test",
    execute: immediateOk,
    ...overrides,
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("CommandQueue", () => {
  let queue: CommandQueue;

  beforeEach(() => {
    queue = new CommandQueue();
  });

  afterEach(() => {
    queue.dispose();
  });

  it("pass-through: an idle queue sends immediately", async () => {
    const result = await queue.enqueue(cmd({}));
    expect(result.outcome).toBe("sent");
  });

  it("latest-wins: pending command with same key is superseded, never executed", async () => {
    const first = controlledExecute();
    const second = controlledExecute();
    const third = controlledExecute();

    const p1 = queue.enqueue(cmd({ execute: first.execute }));
    await tick(20); // first is now in flight
    const p2 = queue.enqueue(cmd({ execute: second.execute }));
    const p3 = queue.enqueue(cmd({ execute: third.execute }));

    expect(await p2).toEqual({ outcome: "superseded" }); // superseded immediately by p3

    first.release();
    await tick(50);
    third.release();

    expect((await p1).outcome).toBe("sent");
    expect((await p3).outcome).toBe("sent");
    expect(second.calls.count).toBe(0); // the superseded command never reached the bridge
    expect(third.calls.count).toBe(1);
  });

  it("cue priority preempts queued effect commands", async () => {
    const gate = controlledExecute();
    const order: string[] = [];
    const track = (name: string) => () => {
      order.push(name);
      return immediateOk();
    };

    const pGate = queue.enqueue(cmd({ key: "gate", execute: gate.execute }));
    await tick(20);
    const pEffect = queue.enqueue(
      cmd({ key: "effect:1", priority: "effect", execute: track("effect") })
    );
    const pCue = queue.enqueue(cmd({ key: "cue:1", priority: "cue", execute: track("cue") }));

    gate.release();
    await Promise.all([pGate, pEffect, pCue]);
    expect(order).toEqual(["cue", "effect"]);
  });

  it("retries once on failure, then reports sent", async () => {
    let attempts = 0;
    const result = await queue.enqueue(
      cmd({
        execute: () => {
          attempts++;
          return Promise.resolve(
            attempts === 1 ? { ok: false, errors: ["boom"] } : { ok: true, errors: [] }
          );
        },
      })
    );
    expect(attempts).toBe(2);
    expect(result.outcome).toBe("sent");
  });

  it("reports failed after both attempts fail", async () => {
    const result = await queue.enqueue(
      cmd({ execute: () => Promise.resolve({ ok: false, errors: ["boom"] }) })
    );
    expect(result.outcome).toBe("failed");
    expect(result.errors).toEqual(["boom"]);
  });

  it("never retries a superseded command", async () => {
    const first = controlledExecute();
    const p1 = queue.enqueue(cmd({ execute: first.execute }));
    await tick(20); // first in flight
    const p2 = queue.enqueue(cmd({})); // supersedes first mid-flight

    first.release({ ok: false, errors: ["boom"] }); // fails — but must not retry
    const r1 = await p1;
    expect(first.calls.count).toBe(1);
    expect(r1.outcome).toBe("superseded");
    expect((await p2).outcome).toBe("sent");
  });

  it("cancelPending cancels queued commands by key prefix", async () => {
    const gate = controlledExecute();
    const effect = controlledExecute();

    const pGate = queue.enqueue(cmd({ key: "gate", execute: gate.execute }));
    await tick(20);
    const pEffect = queue.enqueue(
      cmd({ key: "light:2:state", priority: "effect", execute: effect.execute })
    );

    queue.cancelPending("light:");
    expect(await pEffect).toEqual({ outcome: "superseded" });

    gate.release();
    await pGate;
    expect(effect.calls.count).toBe(0);
  });

  it("dispose settles pending commands and blocks new ones", async () => {
    const gate = controlledExecute();
    const pGate = queue.enqueue(cmd({ key: "gate", execute: gate.execute }));
    await tick(20);
    const pQueued = queue.enqueue(cmd({ key: "queued" }));

    queue.dispose();
    expect(await pQueued).toEqual({ outcome: "superseded" });
    expect((await queue.enqueue(cmd({ key: "after" }))).outcome).toBe("superseded");
    gate.release();
    await pGate;
  });

  it("rate budget: a group command after a burst waits for tokens", async () => {
    // Drain the 10-token budget with a group command (cost 8) + 2 lights
    await queue.enqueue(cmd({ key: "g1", kind: "group" }));
    await queue.enqueue(cmd({ key: "l1" }));
    await queue.enqueue(cmd({ key: "l2" }));

    const t0 = Date.now();
    await queue.enqueue(cmd({ key: "g2", kind: "group" }));
    const waited = Date.now() - t0;
    // Needs 8 tokens at 9/sec ≈ 890ms (minus jitter margin)
    expect(waited).toBeGreaterThan(500);
  });
});
