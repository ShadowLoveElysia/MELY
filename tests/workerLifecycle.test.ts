import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConversionWorkerLifecycle,
  type ConversionWorkerPort,
} from "../src/core/workerLifecycle";
import type { WorkerCommand, WorkerEvent } from "../src/types";

class FakeWorker implements ConversionWorkerPort {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
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
}

const command = (jobId: string): WorkerCommand => ({
  type: "GENERATE_HOLOGRAM",
  jobId,
  options: {
    targetHeight: 320,
    sampleSpacing: 2,
    material: "mixed",
    directionMode: "vertical",
    isolatePanes: true,
    preserveFace: true,
    glow: 72,
  },
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
  assert.equal(lifecycle.post("first", command("first")), true);

  lifecycle.start("second");
  const second = workers.at(-1)!;
  assert.equal(first.terminated, true);
  firstHandler?.({
    data: { type: "PROGRESS", jobId: "first", stage: "voxelizing", progress: 0.5 },
  } as MessageEvent<WorkerEvent>);
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
  lifecycle.cancel();

  assert.equal(active.terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(lifecycle.isCurrent("active"), false);
  assert.equal(lifecycle.post("active", command("active")), false);
  lateHandler?.({
    data: { type: "PROGRESS", jobId: "active", stage: "matching", progress: 0.9 },
  } as MessageEvent<WorkerEvent>);
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
