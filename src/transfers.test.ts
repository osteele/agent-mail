import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransferStore } from "./transfers.ts";
import { type WorkOwner, WorkStore } from "./work.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): {
  project: string;
  workStore: WorkStore;
  transferStore: TransferStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-transfers-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const workStore = new WorkStore(join(root, "work"));
  return {
    project,
    workStore,
    transferStore: new TransferStore(join(root, "transfers"), workStore),
  };
}

const holder: WorkOwner = {
  id: "holder",
  label: "Holder",
  sessionId: "holder",
  pid: 10,
  instanceId: "holder-instance",
};
const requester: WorkOwner = {
  id: "requester",
  label: "Requester",
  sessionId: "requester",
  pid: 20,
  instanceId: "requester-instance",
};

test("a holder can atomically accept an idempotent transfer request", () => {
  const { project, workStore, transferStore } = fixture();
  const lease = workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    holder,
  );
  const first = transferStore.request(lease, requester, { timeoutSeconds: 60 });
  const second = transferStore.request(lease, requester, {
    timeoutSeconds: 60,
  });
  expect(first.changed).toBe(true);
  expect(second.changed).toBe(false);
  expect(second.request.id).toBe(first.request.id);

  const accepted = transferStore.respond(
    first.request.id,
    holder,
    "accept",
    "handoff complete",
  );
  expect(accepted.request.status).toBe("accepted");
  expect(workStore.list(project)[0].owner).toEqual(requester);
  expect(
    transferStore.respond(first.request.id, holder, "accept").changed,
  ).toBe(false);
});

test("only the captured holder process can answer a transfer", () => {
  const { project, workStore, transferStore } = fixture();
  const lease = workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    holder,
  );
  const request = transferStore.request(lease, requester).request;
  expect(() =>
    transferStore.respond(
      request.id,
      { ...holder, pid: 11, instanceId: "replacement-instance" },
      "decline",
    ),
  ).toThrow("only be answered by Holder");
});

test("timeout transfers unchanged work and supersedes a changed version", () => {
  const { project, workStore, transferStore } = fixture();
  const lease = workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    holder,
  );
  const request = transferStore.request(lease, requester, {
    timeoutSeconds: 5,
  }).request;
  expect(
    transferStore.settleExpired(Date.parse(request.deadline) + 1)[0].status,
  ).toBe("timed-out");
  expect(workStore.list(project)[0].owner).toEqual(requester);

  const other = workStore.acquire(
    project,
    { type: "research-plan", key: "other" },
    holder,
  );
  const stale = transferStore.request(other, requester, {
    timeoutSeconds: 5,
  }).request;
  workStore.update(project, other.id, holder, { activity: "still working" });
  expect(
    transferStore.settleExpired(Date.parse(stale.deadline) + 1)[0].status,
  ).toBe("superseded");
  expect(
    workStore.list(project).find((item) => item.id === other.id)?.owner,
  ).toEqual(holder);
});

test("a response after the deadline resolves as timeout", () => {
  const { project, workStore, transferStore } = fixture();
  const lease = workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    holder,
  );
  const request = transferStore.request(lease, requester, {
    timeoutSeconds: 5,
  }).request;
  const result = transferStore.respond(
    request.id,
    holder,
    "decline",
    "too late",
    Date.parse(request.deadline) + 1,
  );
  expect(result.request.status).toBe("timed-out");
  expect(workStore.list(project)[0].owner).toEqual(requester);
});

test("transfer requests capture and CAS on lease revision", () => {
  const { project, workStore, transferStore } = fixture();
  const lease = workStore.acquire(
    project,
    { type: "research-plan", key: "plan" },
    holder,
  );
  const request = transferStore.request(lease, requester, {
    timeoutSeconds: 5,
  }).request;
  expect(request.expectedRevision).toBe(lease.revision);

  workStore.update(project, lease.id, holder, { activity: "changed" });
  expect(
    transferStore.settleExpired(Date.parse(request.deadline) + 1)[0].status,
  ).toBe("superseded");
  expect(workStore.list(project)[0].owner).toEqual(holder);
});
