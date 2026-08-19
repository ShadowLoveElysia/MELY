import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConversionWorkerLifecycle,
  type ConversionWorkerPort,
} from "../src/core/workerLifecycle";
import type { WorkerCommand, WorkerEvent } from "../src/types";

class FakeWorker implements ConversionWorkerPort {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posts: WorkerCommand[] = [];
  terminated = false;

  postMessage(message: WorkerCommand, _transfer: Transferable[]) {
    this.posts.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(event: WorkerEvent) {
    this.onmessage?.({ data: event } as MessageEvent<WorkerEvent>);
  }

  crash() {
    this.onerror?.({ preventDefault() {} } as ErrorEvent);
  }

  emitMessageError() {
    this.onmessageerror?.({ data: null } as MessageEvent<unknown>);
  }

  emitInvalid(value: unknown) {
    this.onmessage?.({ data: value } as MessageEvent<WorkerEvent>);
  }
}

const command = (jobId: string): WorkerCommand => ({
  type: "GENERATE_HOLOGRAM",
  jobId,
  options: {
    targetHeight: 320,
    sampleSpacing: 2,
    material: "mixed",
    directionMode: "vertical",
    preserveFace: true,
    glow: 72,
  },
  generationSeed: { contentHash: "fixture", minecraftVersion: "1.20.1" },
  versionId: "1.20.1",
  targetDimension: { minY: -64, height: 384 },
  placementBottomY: -64,
  source: { kind: "demo" },
});

test("starting a replacement job terminates the previous worker and blocks late events", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("first");
  const first = workers.at(-1)!;
  const firstHandler = first.onmessage;
  const firstErrorHandler = first.onerror;
  const firstMessageErrorHandler = first.onmessageerror;
  assert.equal(lifecycle.post("first", command("first")), true);

  lifecycle.start("second");
  const second = workers.at(-1)!;
  assert.equal(first.terminated, true);
  firstHandler?.({
    data: { type: "PROGRESS", jobId: "first", stage: "voxelizing", progress: 0.5 },
  } as MessageEvent<WorkerEvent>);
  firstErrorHandler?.({ preventDefault() {} } as ErrorEvent);
  firstMessageErrorHandler?.({ data: null } as MessageEvent<unknown>);
  second.emit({ type: "PROGRESS", jobId: "second", stage: "sampling", progress: 0.25 });

  assert.deepEqual(events, [
    { type: "PROGRESS", jobId: "second", stage: "sampling", progress: 0.25 },
  ]);
  assert.equal(lifecycle.post("first", command("first")), false);
  assert.equal(lifecycle.post("second", command("second")), true);
});

test("cancel terminates active work, recreates an idle worker, and rejects stale posts", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("active");
  const active = workers.at(-1)!;
  const lateHandler = active.onmessage;
  const lateErrorHandler = active.onerror;
  lifecycle.cancel();

  assert.equal(active.terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(lifecycle.isCurrent("active"), false);
  assert.equal(lifecycle.post("active", command("active")), false);
  lateHandler?.({
    data: { type: "PROGRESS", jobId: "active", stage: "matching", progress: 0.9 },
  } as MessageEvent<WorkerEvent>);
  lateErrorHandler?.({ preventDefault() {} } as ErrorEvent);
  assert.deepEqual(events, []);
});

test("dispose terminates without recreating and permanently blocks events", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("active");
  const active = workers.at(-1)!;
  const lateHandler = active.onmessage;
  lifecycle.dispose();

  assert.equal(active.terminated, true);
  assert.equal(workers.length, 1);
  lateHandler?.({
    data: { type: "PROGRESS", jobId: "active", stage: "complete", progress: 1 },
  } as MessageEvent<WorkerEvent>);
  assert.deepEqual(events, []);
  assert.equal(lifecycle.post("active", command("active")), false);
  assert.throws(() => lifecycle.start("next"), /disposed/);
});

test("worker crashes fail the current job once, reset the port, and allow retry", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("failed");
  const failed = workers.at(-1)!;
  const lateCrash = failed.onerror;
  failed.crash();

  assert.equal(failed.terminated, true);
  assert.equal(lifecycle.isCurrent("failed"), false);
  assert.equal(workers.length, 2);
  assert.deepEqual(events, [
    { type: "ERROR", jobId: "failed", code: "error.worker.crashed" },
  ]);
  lateCrash?.({ preventDefault() {} } as ErrorEvent);
  assert.equal(events.length, 1);

  lifecycle.start("retry");
  assert.equal(lifecycle.post("retry", command("retry")), true);
  workers.at(-1)!.emit({ type: "PROGRESS", jobId: "retry", stage: "sampling", progress: 0.3 });
  assert.deepEqual(events.at(-1), {
    type: "PROGRESS",
    jobId: "retry",
    stage: "sampling",
    progress: 0.3,
  });
});

test("message deserialization failures stop only the active generation", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("protocol");
  const failed = workers.at(-1)!;
  failed.emitMessageError();

  assert.equal(failed.terminated, true);
  assert.equal(lifecycle.isCurrent("protocol"), false);
  assert.deepEqual(events, [
    { type: "ERROR", jobId: "protocol", code: "error.worker.protocol" },
  ]);
});

test("an idle worker crash is replaced without reporting a phantom job", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  const idle = workers[0];
  idle.crash();

  assert.equal(idle.terminated, true);
  assert.equal(workers.length, 2);
  assert.deepEqual(events, []);
  lifecycle.start("after-idle-crash");
  assert.equal(lifecycle.post("after-idle-crash", command("after-idle-crash")), true);
});

test("invalid worker payloads fail closed instead of throwing in the UI handler", () => {
  const workers: FakeWorker[] = [];
  const events: WorkerEvent[] = [];
  const lifecycle = createConversionWorkerLifecycle({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onEvent: (event) => events.push(event),
  });

  lifecycle.start("invalid-payload");
  const failed = workers.at(-1)!;
  failed.emitInvalid(null);

  assert.equal(failed.terminated, true);
  assert.deepEqual(events, [
    { type: "ERROR", jobId: "invalid-payload", code: "error.worker.protocol" },
  ]);
  assert.equal(workers.length, 2);
});
