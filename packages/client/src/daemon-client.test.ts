import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { DaemonClient, type DaemonTransport, type Logger } from "./daemon-client";

function useHeartbeatClock(): void {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
}

class DaemonClientSession {
  private readonly daemon = new FakeDaemon();
  private readonly client: DaemonClient;

  constructor() {
    this.client = new DaemonClient({
      url: "ws://test",
      clientId: "clsk_heartbeat_test",
      logger: noopLogger,
      reconnect: { enabled: false },
      transportFactory: () => this.daemon.transport,
    });
    clients.push(this.client);
  }

  async connect(): Promise<void> {
    const connection = this.client.connect();
    this.daemon.openConnection();
    await connection;
  }

  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  daemonAnswersPingsAfter(delay: "fast" | `${number}s`): void {
    this.daemon.daemonAnswersPingsAfter(delay);
  }

  daemonGoesSilent(): void {
    this.daemon.daemonGoesSilent();
  }

  daemonWithholdsNextPongThenAnswersFast(): void {
    this.daemon.daemonWithholdsNextPongThenAnswersFast();
  }

  daemonClosesWith(reason: string): void {
    this.daemon.daemonClosesWith(reason);
  }

  pingTimestamps(): string[] {
    return this.daemon.pingTimestamps();
  }

  state(): ReturnType<DaemonClient["getConnectionState"]> {
    return this.client.getConnectionState();
  }

  lastError(): string | null {
    return this.client.lastError;
  }

  teardownCount(): number {
    return this.daemon.teardownCount();
  }

  closesFromClient(): Array<{ code?: number; reason?: string }> {
    return this.daemon.closesFromClient();
  }

  lastLivenessRttMs(): number | null {
    return this.client.getLastLivenessRttMs();
  }

  measureLatency(input: { timeoutMs: number }): Promise<number> {
    return this.client.measureLatency(input);
  }
}

class FakeDaemon {
  private onMessage: (data: unknown) => void = () => {};
  private onOpen: () => void = () => {};
  private onClose: (event?: unknown) => void = () => {};
  private onError: (event?: unknown) => void = () => {};
  private pongMode: PongMode = { kind: "answer", delayMs: 0 };
  private withheldPongs = 0;
  private pingsSentAt: number[] = [];
  private closeEvents: Array<{ code?: number; reason?: string }> = [];

  readonly transport: DaemonTransport = {
    send: (data) => {
      if (typeof data !== "string") {
        return;
      }
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type !== "ping") {
        return;
      }
      this.pingsSentAt.push(performance.now());
      if (this.withheldPongs > 0) {
        this.withheldPongs -= 1;
        return;
      }
      if (this.pongMode.kind === "silent") {
        return;
      }
      if (this.pongMode.delayMs === 0) {
        this.onMessage(JSON.stringify({ type: "pong" }));
        return;
      }
      setTimeout(() => {
        this.onMessage(JSON.stringify({ type: "pong" }));
      }, this.pongMode.delayMs);
    },
    close: (code?: number, reason?: string) => {
      this.closeEvents.push({ code, reason });
    },
    onMessage: (handler) => {
      this.onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      this.onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      this.onClose = handler;
      return () => {};
    },
    onError: (handler) => {
      this.onError = handler;
      return () => {};
    },
  };

  openConnection(): void {
    this.onOpen();
    this.onMessage(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            serverId: "srv_heartbeat_test",
            hostname: null,
            version: null,
          },
        },
      }),
    );
  }

  daemonAnswersPingsAfter(delay: "fast" | `${number}s`): void {
    this.pongMode = {
      kind: "answer",
      delayMs: delay === "fast" ? 0 : Number.parseFloat(delay) * 1000,
    };
  }

  daemonGoesSilent(): void {
    this.pongMode = { kind: "silent" };
  }

  daemonWithholdsNextPongThenAnswersFast(): void {
    this.withheldPongs += 1;
    this.daemonAnswersPingsAfter("fast");
  }

  daemonClosesWith(reason: string): void {
    this.onClose({ reason });
  }

  triggerError(event?: unknown): void {
    this.onError(event);
  }

  pingTimestamps(): string[] {
    return this.pingsSentAt.map((timestamp) => `${timestamp / 1000}s`);
  }

  teardownCount(): number {
    return this.closeEvents.filter((event) => event.reason === "Liveness check timed out").length;
  }

  closesFromClient(): Array<{ code?: number; reason?: string }> {
    return this.closeEvents;
  }
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type PongMode = { kind: "answer"; delayMs: number } | { kind: "silent" };

expectTypeOf<"getGitDiff" extends keyof DaemonClient ? true : false>().toEqualTypeOf<false>();
expectTypeOf<
  "getHighlightedDiff" extends keyof DaemonClient ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  "exploreFileSystem" extends keyof DaemonClient ? true : false
>().toEqualTypeOf<false>();

const clients: DaemonClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("stays online through ten minutes of pongs that arrive five seconds late", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("5.5s");

  await session.connect();
  await session.advance(10 * 60 * 1000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
  expect(session.lastError()).toBeNull();
  expect(session.pingTimestamps().length).toBeGreaterThan(0);
  expect(session.lastLivenessRttMs()).toBe(5500);
});

test("tears down and reports a liveness timeout after the daemon goes silent for two cycles", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();
  await session.advance(51_000);

  expect(session.state()).toEqual({
    status: "disconnected",
    reason: "Liveness check timed out (15000ms)",
  });
  expect(session.teardownCount()).toBe(1);
});

test("survives a single missed pong when answers resume", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonWithholdsNextPongThenAnswersFast();

  await session.connect();
  await session.advance(40_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
});

test("keeps the connection proven online from heartbeats alone when no other traffic flows", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(35_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.pingTimestamps()).toEqual(["10s", "20s", "30s"]);
});

test("starts pinging one interval after connecting and holds the cadence", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(9_999);
  expect(session.pingTimestamps()).toEqual([]);

  await session.advance(20_001);
  expect(session.pingTimestamps()).toEqual(["10s", "20s", "30s"]);
});

test("stops pinging once the connection is gone", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("fast");

  await session.connect();
  await session.advance(10_000);
  session.daemonClosesWith("daemon shutting down");
  await session.advance(30_000);

  expect(session.pingTimestamps()).toEqual(["10s"]);
});

test("sends only one ping while a slow pong is still outstanding", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("15.1s");

  await session.connect();
  await session.advance(20_000);

  expect(session.pingTimestamps()).toEqual(["10s"]);
});

test("reports the round-trip time of the last successful heartbeat", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonAnswersPingsAfter("2.3s");

  await session.connect();
  await session.advance(12_300);

  expect(session.lastLivenessRttMs()).toBe(2300);
});

test("treats a pong just under the timeout as alive and just over as a miss", async () => {
  useHeartbeatClock();
  const alive = new DaemonClientSession();
  alive.daemonAnswersPingsAfter("14.9s");

  await alive.connect();
  await alive.advance(24_900);

  expect(alive.state()).toEqual({ status: "connected" });

  const missed = new DaemonClientSession();
  missed.daemonAnswersPingsAfter("15.1s");

  await missed.connect();
  await missed.advance(25_000);

  expect(missed.state()).toEqual({ status: "connected" });
  expect(missed.lastLivenessRttMs()).toBeNull();
});

test("goes red with the daemon's reason when the connection is closed", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();

  await session.connect();
  session.daemonClosesWith("Control unresponsive");

  expect(session.state()).toEqual({
    status: "disconnected",
    reason: "Control unresponsive",
  });
  expect(session.lastError()).toBe("Control unresponsive");
  expect(session.closesFromClient()).toEqual([]);
});

test("two candidate latency timeouts do not tear down the live connection", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();
  const firstMeasurement = session.measureLatency({ timeoutMs: 1000 });
  const firstMeasurementError = firstMeasurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(1000);

  await expect(firstMeasurementError).resolves.toEqual(
    expect.objectContaining({
      message: "Latency measurement timed out (1000ms)",
    }),
  );

  const secondMeasurement = session.measureLatency({ timeoutMs: 1000 });
  const secondMeasurementError = secondMeasurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(1000);

  await expect(secondMeasurementError).resolves.toEqual(
    expect.objectContaining({
      message: "Latency measurement timed out (1000ms)",
    }),
  );
  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
  expect(session.pingTimestamps()).toEqual(["0s", "1s"]);
});

test("a candidate measurement that times out under a heartbeat tick does not count toward teardown", async () => {
  useHeartbeatClock();
  const session = new DaemonClientSession();
  session.daemonGoesSilent();

  await session.connect();

  // A candidate measurement is still in flight when the +10s heartbeat tick lands,
  // so the heartbeat shares the in-flight ping. Let the measurement time out.
  await session.advance(9_000);
  const measurement = session.measureLatency({ timeoutMs: 5_000 });
  const measurementError = measurement.then(
    () => null,
    (error) => error,
  );
  await session.advance(5_500);
  await expect(measurementError).resolves.toEqual(
    expect.objectContaining({ message: "Latency measurement timed out (5000ms)" }),
  );

  // The measurement timeout must not have been recorded as a liveness failure: a
  // single genuine heartbeat miss after it must still leave the connection up.
  await session.advance(25_000);

  expect(session.state()).toEqual({ status: "connected" });
  expect(session.teardownCount()).toBe(0);
});

test("requires non-empty clientId", () => {
  expect(() => {
    const _client = new DaemonClient({
      url: "ws://relay.test/ws?role=client&serverId=srv_test&v=2",
      clientId: "",
      reconnect: { enabled: false },
    });
    void _client;
  }).toThrow("Daemon client requires a non-empty clientId");
});

test("requires non-empty clientId for direct connections", () => {
  expect(() => {
    const _client = new DaemonClient({
      url: "ws://127.0.0.1:6767/ws",
      clientId: "   ",
      reconnect: { enabled: false },
    });
    void _client;
  }).toThrow("Daemon client requires a non-empty clientId");
});
