// Command queue with theatrical semantics for the Hue bridge.
//
// Guarantees:
//  - Pass-through when idle: a command arriving with budget available is
//    sent immediately, with no queue-added delay.
//  - Latest-wins, never-stack: a new command supersedes any pending
//    command with the same key. Superseded commands are never sent, and
//    a superseded command is never retried — the bridge never receives a
//    command that is no longer the newest intent for its target.
//  - Rate budget mirrors the bridge's shared Zigbee radio budget
//    (~1 group command/sec, ~10 light commands/sec) so the bridge never
//    silently drops what we send. Slightly conservative (9 tokens/sec vs
//    the bridge's 10) to leave headroom for latency jitter.
//  - Cue priority preempts effect priority: scene GOs always go out
//    before queued effect frames.
//  - One command in flight at a time, so commands arrive in order.

export type CommandPriority = "cue" | "effect";
export type CommandKind = "group" | "light";

export interface ExecuteResult {
  ok: boolean;
  errors: string[];
}

export interface QueuedCommandResult {
  outcome: "sent" | "superseded" | "failed";
  errors?: string[];
}

export interface EnqueueOptions {
  /** Coalescing key: a new command replaces pending commands with the same key */
  key: string;
  kind: CommandKind;
  priority: CommandPriority;
  label: string;
  execute: () => Promise<ExecuteResult>;
}

interface QueuedCommand extends EnqueueOptions {
  resolve: (result: QueuedCommandResult) => void;
  superseded: boolean;
  inFlight: boolean;
  settled: boolean;
}

const COSTS: Record<CommandKind, number> = { group: 8, light: 1 };
// tokens/sec. The bridge refills ~10/sec; the 30-minute soak showed
// that at 9/sec sustained saturation leaves group commands only ~1
// token of margin at the bridge and ~20% of them get dropped. 8/sec
// keeps a 2-token/sec cushion even under hours of effect load.
const RATE = 8;
const CAPACITY = 10;
const RETRY_DELAY_MS = 250;
// Measured on real hardware (bridge-probe2): once a bridge starts
// returning "901 Internal error" it stays overloaded for a while —
// a fast retry just hits the same wall. Back off longer for 901s.
const OVERLOAD_RETRY_DELAY_MS = 800;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CommandQueue {
  private cueQueue: QueuedCommand[] = [];
  private effectQueue: QueuedCommand[] = [];
  private current: QueuedCommand | undefined;
  private tokens = CAPACITY;
  private lastRefill = Date.now();
  private running = false;
  private disposed = false;

  enqueue(options: EnqueueOptions): Promise<QueuedCommandResult> {
    return new Promise((resolve) => {
      const cmd: QueuedCommand = {
        ...options,
        resolve,
        superseded: false,
        inFlight: false,
        settled: false,
      };
      if (this.disposed) {
        this.settle(cmd, { outcome: "superseded" });
        return;
      }
      this.supersedeMatching(options.key);
      (options.priority === "cue" ? this.cueQueue : this.effectQueue).push(cmd);
      void this.run();
    });
  }

  /** Cancel pending (not in-flight) commands whose key starts with prefix */
  cancelPending(keyPrefix: string): void {
    for (const queue of [this.cueQueue, this.effectQueue]) {
      for (const cmd of queue) {
        if (cmd.key.startsWith(keyPrefix) && !cmd.superseded) {
          cmd.superseded = true;
          this.settle(cmd, { outcome: "superseded" });
        }
      }
    }
  }

  get depth(): number {
    return (
      this.cueQueue.filter((c) => !c.superseded).length +
      this.effectQueue.filter((c) => !c.superseded).length
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const queue of [this.cueQueue, this.effectQueue]) {
      for (const cmd of queue) this.settle(cmd, { outcome: "superseded" });
    }
    this.cueQueue = [];
    this.effectQueue = [];
  }

  // ----------------------------------------------------------- internals

  private settle(cmd: QueuedCommand, result: QueuedCommandResult): void {
    if (!cmd.settled) {
      cmd.settled = true;
      cmd.resolve(result);
    }
  }

  private supersedeMatching(key: string): void {
    const candidates = [...this.cueQueue, ...this.effectQueue];
    if (this.current) candidates.push(this.current);
    for (const cmd of candidates) {
      if (cmd.key === key && !cmd.superseded && !cmd.settled) {
        cmd.superseded = true;
        // In-flight commands were already sent — just block their retry.
        if (!cmd.inFlight) this.settle(cmd, { outcome: "superseded" });
      }
    }
  }

  private next(): QueuedCommand | undefined {
    for (const queue of [this.cueQueue, this.effectQueue]) {
      while (queue.length > 0) {
        const cmd = queue.shift() as QueuedCommand;
        if (!cmd.superseded && !cmd.settled) return cmd;
      }
    }
    return undefined;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(CAPACITY, this.tokens + ((now - this.lastRefill) / 1000) * RATE);
    this.lastRefill = now;
  }

  private async waitForTokens(cost: number, cmd: QueuedCommand): Promise<void> {
    this.refill();
    while (this.tokens < cost && !cmd.superseded && !this.disposed) {
      const deficitMs = Math.ceil(((cost - this.tokens) / RATE) * 1000);
      await sleep(Math.max(15, deficitMs));
      this.refill();
    }
  }

  private async execute(cmd: QueuedCommand): Promise<ExecuteResult> {
    cmd.inFlight = true;
    try {
      return await cmd.execute();
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    } finally {
      cmd.inFlight = false;
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (;;) {
        const cmd = this.next();
        if (!cmd) break;
        this.current = cmd;
        const cost = COSTS[cmd.kind];

        await this.waitForTokens(cost, cmd);
        if (this.disposed) {
          this.settle(cmd, { outcome: "superseded" });
          break;
        }
        if (cmd.superseded) {
          this.current = undefined;
          continue;
        }

        this.tokens -= cost;
        let result = await this.execute(cmd);

        // Retry once — but never retry a command that has been superseded.
        if (!result.ok && !cmd.superseded && !this.disposed) {
          const overloaded = result.errors.some((e) => e.includes("901"));
          console.warn(
            `[Queue] ${cmd.label} failed (${result.errors.join("; ")}) — retrying once${
              overloaded ? " after overload backoff" : ""
            }`
          );
          await sleep(overloaded ? OVERLOAD_RETRY_DELAY_MS : RETRY_DELAY_MS);
          if (!cmd.superseded && !this.disposed) {
            await this.waitForTokens(cost, cmd);
            if (!cmd.superseded && !this.disposed) {
              this.tokens -= cost;
              result = await this.execute(cmd);
            }
          }
        }

        this.settle(
          cmd,
          result.ok
            ? { outcome: "sent" }
            : cmd.superseded
            ? { outcome: "superseded" }
            : { outcome: "failed", errors: result.errors }
        );
        this.current = undefined;
      }
    } finally {
      this.running = false;
      this.current = undefined;
    }
    // A command may have been enqueued while the loop was settling the last one
    if (!this.disposed && this.depth > 0) void this.run();
  }
}
