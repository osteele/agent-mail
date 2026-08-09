#!/usr/bin/env bun
/** Optional Claude Code PostToolUse hook that records native SendMessage calls.
 * Audit entries feed dashboards and Slack, but never enter a recipient inbox. */

import { loadConfig } from "./config.ts";
import { canonicalProject } from "./paths.ts";
import {
  type AdmissionOptions,
  type Message,
  appendMessageGuarded,
} from "./spool.ts";

interface NativeAuditFields {
  cwd: string;
  sessionId?: string;
  recipient: string;
  message: string;
  toolUseId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(
  object: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key]) {
      return object[key] as string;
    }
  }
  return undefined;
}

/** Parse the documented PostToolUse envelope while accepting SendMessage field
 * names used by independent sessions, subagents, and agent teams. */
export function nativeAuditFields(input: unknown): NativeAuditFields | null {
  if (!isObject(input) || input.tool_name !== "SendMessage") return null;
  if (!isObject(input.tool_input) || typeof input.cwd !== "string") return null;
  const recipient = firstString(input.tool_input, [
    "to",
    "recipient",
    "agent_id",
    "name",
  ]);
  const message = firstString(input.tool_input, [
    "message",
    "content",
    "prompt",
  ]);
  if (!recipient || !message) return null;
  return {
    cwd: input.cwd,
    recipient,
    message,
    ...(typeof input.session_id === "string"
      ? { sessionId: input.session_id }
      : {}),
    ...(typeof input.tool_use_id === "string"
      ? { toolUseId: input.tool_use_id }
      : {}),
  };
}

export function nativeAuditMessage(
  fields: NativeAuditFields,
  nowMs = Date.now(),
): Message {
  const project = canonicalProject(fields.cwd);
  return {
    ts: new Date(nowMs).toISOString(),
    from: project,
    project,
    message: fields.message,
    delivery: "audit",
    origin: {
      kind: "agent",
      transport: "native-audit",
      client: "claude-code",
      ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
      authority: "untrusted",
    },
    ...(fields.toolUseId ? { idempotencyKey: fields.toolUseId } : {}),
    meta: {
      nativeRecipient: fields.recipient,
      ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    },
  };
}

function admissionOptions(): AdmissionOptions {
  const config = loadConfig();
  return {
    duplicateWindowSeconds: config.duplicateWindowSeconds,
    messageRateLimitPerMinute: config.messageRateLimitPerMinute,
    defaultMessageTtlSeconds: config.defaultMessageTtlSeconds,
  };
}

async function recordAudit(input: unknown): Promise<void> {
  const fields = nativeAuditFields(input);
  if (!fields) return;
  const message = nativeAuditMessage(fields);
  const config = loadConfig();
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok || response.status === 429) return;
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof DOMException))
      throw error;
  }
  appendMessageGuarded(message, admissionOptions());
}

if (import.meta.main) {
  try {
    await recordAudit(JSON.parse(await Bun.stdin.text()) as unknown);
  } catch (error) {
    // Auditing must never change whether the native SendMessage succeeds.
    if (!(error instanceof SyntaxError || error instanceof Error)) throw error;
  }
}
