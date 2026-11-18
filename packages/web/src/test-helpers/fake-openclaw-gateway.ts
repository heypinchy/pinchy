/**
 * A fake OpenClaw Gateway for driving the REAL `openclaw-node` client in tests.
 *
 * Why not a `chat`/`chatAbort` mock: the client's own behaviour is part of what
 * is under test. `OpenClawClient.chatAbort` ends the local `chat()` stream
 * synchronously and that stream then yields a plain `done` carrying the run's
 * id — before OpenClaw has answered, and whether or not OpenClaw stopped
 * anything. A hand-written mock that keeps streaming after the abort tests a
 * client that does not exist.
 *
 * What the fake models of OpenClaw 2026.7.1, and nothing more:
 *  - `agent` is held until the test calls `accept` — OpenClaw awaits a lot
 *    (attachments, session store, admission) before it registers a run, and a
 *    run that is not registered yet cannot be aborted.
 *  - `chat.abort` stops only a run it is running (by runId, or every run on the
 *    session when no runId is given) and otherwise answers `aborted: false`,
 *    leaving no tombstone: a run accepted afterwards runs normally.
 *  - `agent.wait` answers a terminal snapshot (`endedAt`) for a run that is
 *    over and `status: "timeout"` otherwise — it does not long-poll. A run
 *    that was stopped answers `status: "error"` with `stopReason: "rpc"`, as
 *    OpenClaw's normalised snapshot does.
 *  - A tool runs only when the test says the model got there (`runTool`), and
 *    only if the run is still running.
 *  - A dispatch OpenClaw turns away (`reject`) is answered `ok: false` before
 *    any run exists, so `agent.wait` never reports it over. A run that fails
 *    once accepted (`fail`) ends in error, like a model OpenClaw cannot resolve.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer, type WebSocket } from "ws";
import { OpenClawClient } from "openclaw-node";

export interface FakeRun {
  runId: string;
  sessionKey: string;
  state: "received" | "running" | "aborted" | "ended" | "failed" | "rejected";
  text: string;
  toolsRun: string[];
  endedAt?: number;
}

export interface FakeGatewayCall {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeGateway {
  url: string;
  /** Every request the client sent, in order (the handshake excluded). */
  calls: FakeGatewayCall[];
  /** The params of every `connect` handshake, in order. */
  handshakes: Array<Record<string, unknown>>;
  /** `chat.abort` calls with the answer each one got. */
  aborts: Array<{ sessionKey: string; runId?: string; aborted: boolean }>;
  runs: Map<string, FakeRun>;
  /** The run for the n-th `agent` request (0-based), once it arrived. */
  runAt(index: number): FakeRun | undefined;
  /**
   * OpenClaw registers the run and answers `accepted`. `silent`: registered,
   * but nothing has reached the client yet.
   */
  accept(runId: string, opts?: { silent?: boolean }): void;
  /** The model streams text. Ignored unless the run is running. */
  emitText(runId: string, text: string): void;
  /**
   * OpenClaw turns the held `agent` request away before registering a run
   * (`respond(false)` during validation, e.g. an unknown agent id).
   */
  reject(runId: string, message: string): void;
  /** The accepted run fails (e.g. `FailoverError: Unknown model`). */
  fail(runId: string, error: string): void;
  /** The model calls a tool. Returns false — nothing ran — unless the run is running. */
  runTool(runId: string, tool: string): boolean;
  /**
   * The run ends normally. `silent`: it ended on OpenClaw, but its last frames
   * have not reached the client yet.
   */
  finish(runId: string, opts?: { silent?: boolean }): void;
  /** The next `chat.abort` fails at the RPC level (the client's promise rejects). */
  failNextAbort(): void;
  /** A connected real client. */
  connectClient(
    options?: Partial<ConstructorParameters<typeof OpenClawClient>[0]>
  ): Promise<OpenClawClient>;
  close(): Promise<void>;
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("no port");

  const sockets = new Set<WebSocket>();
  const clients: OpenClawClient[] = [];
  const calls: FakeGatewayCall[] = [];
  const handshakes: Array<Record<string, unknown>> = [];
  const aborts: FakeGateway["aborts"] = [];
  const runs = new Map<string, FakeRun>();
  const runOrder: string[] = [];
  let failNextAbort = false;

  const broadcast = (msg: unknown) => {
    for (const s of sockets) s.send(JSON.stringify(msg));
  };
  const agentEvent = (runId: string, stream: string, data: Record<string, unknown>) =>
    broadcast({ type: "event", event: "agent", payload: { runId, stream, data } });
  const respond = (ws: WebSocket, id: string, payload: unknown) =>
    ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));

  const stop = (run: FakeRun) => {
    run.state = "aborted";
    run.endedAt = Date.now();
    agentEvent(run.runId, "lifecycle", { phase: "error", error: "Request was aborted" });
    broadcast({
      type: "res",
      id: run.runId,
      ok: true,
      payload: { runId: run.runId, status: "timeout", summary: "aborted" },
    });
  };

  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      const params = msg.params ?? {};
      if (msg.method === "connect") {
        handshakes.push(params);
        respond(ws, msg.id, {
          type: "hello-ok",
          features: { methods: ["agent", "chat.abort", "agent.wait", "artifacts.list"] },
        });
        return;
      }
      calls.push({ method: msg.method, params });
      switch (msg.method) {
        case "agent": {
          // OpenClaw's runId IS the request's idempotencyKey (`const runId = idem`).
          const runId = String(params.idempotencyKey);
          runs.set(runId, {
            runId,
            sessionKey: String(params.sessionKey),
            state: "received",
            text: "",
            toolsRun: [],
          });
          runOrder.push(runId);
          return; // answered by `accept`
        }
        case "chat.abort": {
          const sessionKey = String(params.sessionKey);
          const runId = typeof params.runId === "string" ? params.runId : undefined;
          if (failNextAbort) {
            failNextAbort = false;
            aborts.push({ sessionKey, runId, aborted: false });
            ws.send(
              JSON.stringify({
                type: "res",
                id: msg.id,
                ok: false,
                error: { message: "gateway unavailable" },
              })
            );
            return;
          }
          const targets = [...runs.values()].filter(
            (r) =>
              r.state === "running" &&
              r.sessionKey === sessionKey &&
              (runId === undefined || r.runId === runId)
          );
          targets.forEach(stop);
          aborts.push({ sessionKey, runId, aborted: targets.length > 0 });
          respond(ws, msg.id, {
            ok: true,
            aborted: targets.length > 0,
            runIds: targets.map((r) => r.runId),
          });
          return;
        }
        case "agent.wait": {
          const run = runs.get(String(params.runId));
          if (run?.endedAt !== undefined) {
            // A stopped run is recorded as `timeout` + `stopReason: "rpc"`, but
            // `agent.wait` normalises its terminal snapshot first
            // (`buildDedupeTerminalSnapshot` → `buildAgentRunTerminalOutcome`):
            // a non-ok status with a cancellation stopReason is `cancelled`,
            // and `cancelled` answers `status: "error"`. So the oracle reports
            // a run the user stopped exactly like one that failed, told apart
            // only by `stopReason` (#1301).
            respond(ws, msg.id, {
              runId: run.runId,
              status: run.state === "aborted" || run.state === "failed" ? "error" : "ok",
              endedAt: run.endedAt,
              ...(run.state === "aborted" ? { stopReason: "rpc", error: "aborted" } : {}),
            });
          } else {
            respond(ws, msg.id, {
              runId: params.runId,
              status: "timeout",
              timeoutPhase: run?.state === "running" ? "gateway_draining" : "queue",
            });
          }
          return;
        }
        case "artifacts.list":
          respond(ws, msg.id, { artifacts: [] });
          return;
        default:
          respond(ws, msg.id, {});
      }
    });
  });

  const mustGet = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`fake gateway: no run ${runId}`);
    return run;
  };

  return {
    url: `ws://127.0.0.1:${address.port}`,
    calls,
    handshakes,
    aborts,
    runs,
    runAt: (index) => {
      const runId = runOrder.at(index);
      return runId === undefined ? undefined : runs.get(runId);
    },
    accept(runId, opts) {
      const run = mustGet(runId);
      if (run.state !== "received") throw new Error(`fake gateway: ${runId} is ${run.state}`);
      run.state = "running";
      if (opts?.silent) return;
      broadcast({
        type: "res",
        id: runId,
        ok: true,
        payload: { runId, status: "accepted", acceptedAt: Date.now() },
      });
      agentEvent(runId, "lifecycle", { phase: "start" });
    },
    reject(runId, message) {
      const run = mustGet(runId);
      if (run.state !== "received") throw new Error(`fake gateway: ${runId} is ${run.state}`);
      run.state = "rejected";
      broadcast({
        type: "res",
        id: runId,
        ok: false,
        error: { code: "INVALID_REQUEST", message },
      });
    },
    fail(runId, error) {
      const run = mustGet(runId);
      if (run.state !== "running") throw new Error(`fake gateway: ${runId} is ${run.state}`);
      run.state = "failed";
      run.endedAt = Date.now();
      agentEvent(runId, "lifecycle", { phase: "error", error });
      broadcast({ type: "res", id: runId, ok: true, payload: { runId, status: "error" } });
    },
    emitText(runId, text) {
      const run = mustGet(runId);
      if (run.state !== "running") return;
      run.text += text;
      agentEvent(runId, "assistant", { delta: text, text: run.text });
    },
    runTool(runId, tool) {
      const run = mustGet(runId);
      if (run.state !== "running") return false;
      run.toolsRun.push(tool);
      agentEvent(runId, "tool", { phase: "start", tool });
      return true;
    },
    finish(runId, opts) {
      const run = mustGet(runId);
      if (run.state !== "running") return;
      run.state = "ended";
      run.endedAt = Date.now();
      if (opts?.silent) return;
      agentEvent(runId, "lifecycle", { phase: "end" });
      broadcast({ type: "res", id: runId, ok: true, payload: { runId, status: "ok" } });
    },
    failNextAbort() {
      failNextAbort = true;
    },
    async connectClient(options = {}) {
      const client = new OpenClawClient({
        deviceIdentityPath: join(mkdtempSync(join(tmpdir(), "fake-oc-")), "device.json"),
        ...options,
        url: `ws://127.0.0.1:${address.port}`,
        autoReconnect: false,
      });
      await client.connect();
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) await client.disconnect();
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
