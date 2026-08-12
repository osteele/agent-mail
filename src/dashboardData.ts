/** Shared aggregation for the web and Slack dashboards.
 *
 * Reads the spools and the live registry directly — no daemon dependency, so a
 * dashboard works even when the daemon is down. */

import { type CoordinationEntry, listCoordination } from "./coordination.ts";
import { displayName } from "./paths.ts";
import { type Registration, listLive } from "./registry.ts";
import {
  activityTag,
  claudeSessions,
  lastActivityMs,
  sessionNames,
} from "./sessions.ts";
import { type StoredMessage, readAllMessages } from "./spool.ts";

export interface FlowRoute {
  from: string;
  to: string;
  count: number;
}

export interface LogEntry {
  ts: string;
  from: string;
  to: string;
  thread: boolean; // true when this message is a reply
  preview: string;
}

export interface PresenceEntry {
  project: string;
  sessionId?: string;
  fullName: string;
  displayName: string;
  status?: string;
  activity: string; // recency tag: "busy" / "active" / "idle 26h — stale?"
  lastActive: string; // ISO 8601 of the most recent sign of life
  client?: string; // host client: "claude-code", "codex", ...
  capabilities: string[];
  inboundPolicy: string;
  muted?: boolean; // channel push paused
  pid: number;
}

export interface VolumeBucket {
  hour: string; // ISO hour bucket start
  count: number;
}

export interface WorkEntry {
  id: string;
  project: string;
  resourceType: string;
  resourceKey: string;
  resourceLabel?: string;
  sourcePath?: string;
  owner: string;
  ownerSessionId?: string;
  ownerLive: boolean;
  state: string;
  activity?: string;
  updatedAt: string;
}

export interface DashboardState {
  now: string;
  totals: {
    messages: number;
    projects: number;
    threads: number;
    live: number;
    work: number;
    claims: number;
    coordination: number;
  };
  presence: PresenceEntry[];
  work: WorkEntry[];
  coordination: CoordinationEntry[];
  routes: FlowRoute[];
  log: LogEntry[];
  volume: VolumeBucket[];
}

function activeWork(entries: CoordinationEntry[]): WorkEntry[] {
  return entries
    .filter((entry) => entry.kind === "work")
    .map((entry) => ({
      id: entry.id,
      project: entry.projectLabel,
      resourceType: entry.resourceType,
      resourceKey: entry.resourceKey,
      resourceLabel: entry.resourceLabel,
      sourcePath: entry.sourcePaths[0],
      owner: entry.owner.label,
      ownerSessionId: entry.owner.sessionId,
      ownerLive: entry.ownerStatus !== "offline",
      state: entry.state ?? "working",
      activity: entry.activity,
      updatedAt: entry.updatedAt,
    }));
}

/** One-line snippet of a message body. */
function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function presence(registrations: Registration[]): PresenceEntry[] {
  const meta = claudeSessions();
  return registrations
    .map((r) => {
      // Derive the label from live Claude meta + cwd; the registry `name`
      // snapshot may be stale (a rename) or a legacy synthetic id.
      const sessionMeta = r.sessionId ? meta.get(r.sessionId) : undefined;
      const lastActive = lastActivityMs(r, sessionMeta);
      const names = r.sessionId
        ? sessionNames(r.sessionId, sessionMeta, r.cwd)
        : {
            fullName: r.client ?? "unnamed",
            displayName: r.client ?? "unnamed",
          };
      return {
        project: displayName(r.cwd),
        sessionId: r.sessionId,
        fullName: names.fullName,
        displayName: names.displayName,
        status: sessionMeta?.status,
        activity: activityTag(sessionMeta?.status, lastActive),
        lastActive: new Date(lastActive).toISOString(),
        client: r.client,
        capabilities: r.capabilities
          ? [
              r.capabilities.channelPush ? "channel" : "poll",
              r.capabilities.nativePeerMessaging ? "native-peer" : undefined,
              r.capabilities.claims ? "claims" : undefined,
              r.capabilities.workLeases ? "work" : undefined,
              r.capabilities.receipts ? "receipts" : undefined,
            ].filter((value): value is string => Boolean(value))
          : [],
        inboundPolicy: r.inboundPolicy ?? "accept",
        muted: r.muted,
        pid: r.pid,
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}

function recipient(msg: StoredMessage): string {
  return msg.delivery === "audit" && msg.meta?.nativeRecipient
    ? msg.meta.nativeRecipient
    : displayName(msg.project);
}

/** Map-key separator for from/to pairs. A control character cannot occur in a
 * project label, so it cannot collide with one; it is written as an escape
 * because a literal NUL in the source makes git treat this file as binary and
 * makes grep skip it entirely. */
const ROUTE_KEY_SEP = "\u0000";

function routes(msgs: StoredMessage[]): FlowRoute[] {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    const key = `${displayName(m.from)}${ROUTE_KEY_SEP}${recipient(m)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(ROUTE_KEY_SEP);
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** Hourly message counts for the trailing `hours` window, oldest bucket first. */
function volume(msgs: StoredMessage[], now: Date, hours = 24): VolumeBucket[] {
  const buckets: VolumeBucket[] = [];
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const startMs = top.getTime() - (hours - 1) * 3600_000;
  for (let i = 0; i < hours; i++) {
    buckets.push({
      hour: new Date(startMs + i * 3600_000).toISOString(),
      count: 0,
    });
  }
  for (const m of msgs) {
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((t - startMs) / 3600_000);
    if (idx >= 0 && idx < hours) buckets[idx].count++;
  }
  return buckets;
}

export function buildState(opts: { logLimit?: number } = {}): DashboardState {
  const logLimit = opts.logLimit ?? 60;
  const msgs = readAllMessages();
  const now = new Date();
  const live = listLive();
  const coordination = listCoordination({
    allProjects: true,
    registrations: live,
  });
  const leases = activeWork(coordination);
  const log: LogEntry[] = msgs
    .slice(-logLimit)
    .reverse()
    .map((m) => ({
      ts: m.ts,
      from: displayName(m.from),
      to: recipient(m),
      thread: Boolean(m.replyTo),
      preview: preview(m.message),
    }));
  return {
    now: now.toISOString(),
    totals: {
      messages: msgs.length,
      projects: new Set(msgs.map((m) => m.project)).size,
      threads: new Set(msgs.map((m) => m.threadId ?? m.id)).size,
      live: live.length,
      work: leases.length,
      claims: coordination.filter((entry) => entry.kind !== "work").length,
      coordination: coordination.length,
    },
    presence: presence(live),
    work: leases,
    coordination,
    routes: routes(msgs),
    log,
    volume: volume(msgs, now),
  };
}
