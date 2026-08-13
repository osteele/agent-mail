import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug } from "./paths.ts";
import { WorkConflictError, type WorkOwner, WorkStore } from "./work.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): { project: string; workRoot: string; store: WorkStore } {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-work-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workRoot = join(root, "work");
  return { project, workRoot, store: new WorkStore(workRoot) };
}

const ownerA: WorkOwner = {
  id: "agent-a",
  label: "Agent A",
  sessionId: "session-a",
  pid: 101,
  instanceId: "instance-a",
};
const ownerB: WorkOwner = {
  id: "agent-b",
  label: "Agent B",
  sessionId: "session-b",
  pid: 202,
  instanceId: "instance-b",
};

test("a logical resource has one active owner", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  expect(() =>
    store.acquire(
      project,
      { type: "research-plan", key: "2026-08-12-pilot" },
      ownerB,
    ),
  ).toThrow(WorkConflictError);
  expect(store.list(project)).toEqual([lease]);
});

test("acquisition is idempotent for the current owner", () => {
  const { project, store } = fixture();
  const first = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
    { activity: "Startup audit" },
  );
  const second = store.acquire(
    project,
    {
      type: "research-plan",
      key: "2026-08-12-pilot",
      label: "Pilot campaign",
    },
    ownerA,
    { activity: "Running G1" },
  );

  expect(second.id).toBe(first.id);
  expect(second.resource.label).toBe("Pilot campaign");
  expect(second.activity).toBe("Running G1");
  expect(store.list(project)).toHaveLength(1);
});

test("a stable session id does not let a replacement adopt live work", () => {
  const { project, store } = fixture();
  const original = store.acquire(
    project,
    { type: "research-plan", key: "same-session" },
    ownerA,
  );
  let livenessChecks = 0;
  const replacement = {
    ...ownerA,
    pid: 303,
    instanceId: "replacement-instance",
  };

  expect(() =>
    store.acquire(
      project,
      { type: "research-plan", key: "same-session" },
      replacement,
      {
        ownerIsLive: () => {
          livenessChecks += 1;
          return true;
        },
      },
    ),
  ).toThrow(WorkConflictError);
  expect(livenessChecks).toBe(1);
  expect(() =>
    store.update(project, original.id, replacement, { state: "waiting" }),
  ).toThrow("only its owner can update it");
  expect(() => store.release(project, original.id, replacement)).toThrow(
    "only its owner can release it",
  );
  expect(store.list(project)).toEqual([original]);
});

test("a definitively dead owner can be displaced", () => {
  const { project, store } = fixture();
  store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  const replacement = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerB,
    { ownerIsLive: (owner) => owner.id !== ownerA.id },
  );

  expect(replacement.owner).toEqual(ownerB);
  expect(store.list(project)).toEqual([replacement]);
});

test("takeover checks every duplicate record left by an interruption", () => {
  const { project, workRoot, store } = fixture();
  const canonical = realpathSync(project);
  const directory = join(workRoot, projectSlug(canonical));
  mkdirSync(directory, { recursive: true });
  const resource = { type: "task", key: "same" };
  const records = [
    {
      version: 1,
      id: "00-stale",
      project: canonical,
      resource,
      owner: ownerA,
      state: "working",
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
    },
    {
      version: 1,
      id: "01-live",
      project: canonical,
      resource,
      owner: ownerB,
      state: "working",
      createdAt: "2026-08-13T10:01:00.000Z",
      updatedAt: "2026-08-13T10:01:00.000Z",
    },
  ];
  for (const record of records) {
    writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  }

  expect(() =>
    store.acquire(
      project,
      resource,
      { id: "agent-c", label: "Agent C" },
      { ownerIsLive: (owner) => owner.id === ownerB.id },
    ),
  ).toThrow(WorkConflictError);
  expect(store.list(project).map((lease) => lease.id)).toEqual([
    "00-stale",
    "01-live",
  ]);
});

test("only the owner can update or release a work lease", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "2026-08-12-pilot" },
    ownerA,
  );

  expect(() =>
    store.update(project, lease.id, ownerB.id, { state: "waiting" }),
  ).toThrow("only its owner can update it");
  const waiting = store.update(project, lease.id, ownerA.id, {
    state: "waiting",
    activity: "Waiting for job 42",
  });
  expect(waiting.state).toBe("waiting");
  expect(() => store.release(project, lease.id, ownerB.id)).toThrow(
    "only its owner can release it",
  );
  expect(store.release(project, lease.id, ownerA.id)).toEqual(waiting);
});

test("listAll and releaseOwner span independent projects", () => {
  const { project, store } = fixture();
  const other = join(project, "other");
  mkdirSync(other);
  store.acquire(project, { type: "research-plan", key: "plan-a" }, ownerA);
  store.acquire(other, { type: "research-plan", key: "plan-b" }, ownerA);

  expect(store.listAll()).toHaveLength(2);
  expect(store.releaseOwner(project, ownerA.id)).toBe(1);
  expect(store.listAll().map((lease) => lease.resource.key)).toEqual([
    "plan-b",
  ]);
});

test("shutdown cleanup only releases work from the same owner process", () => {
  const { project, store } = fixture();
  const oldOwner = { ...ownerA, pid: 101 };
  const replacementOwner = { ...ownerA, pid: 202 };
  store.acquire(project, { type: "task", key: "old" }, oldOwner);
  const replacement = store.acquire(
    project,
    { type: "task", key: "replacement" },
    replacementOwner,
  );

  expect(store.releaseOwner(project, ownerA.id, oldOwner.pid)).toBe(1);
  expect(store.list(project)).toEqual([replacement]);
});

test("recovery only removes a lease whose owner is definitively offline", () => {
  const { project, store } = fixture();
  const lease = store.acquire(
    project,
    { type: "research-plan", key: "plan-a" },
    ownerA,
  );
  expect(() => store.recover(project, lease.id, () => true)).toThrow(
    "live or cannot be verified offline",
  );
  expect(store.recover(project, lease.id, () => false)).toEqual(lease);
  expect(store.listAll()).toEqual([]);
});
