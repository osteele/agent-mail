/** Pure delivery-state helpers.
 *
 * These functions decide what receipt transitions occur when a message is
 * processed or when held messages are settled. They do not perform channel push
 * or filesystem I/O, so they are suitable for deterministic state-machine tests.
 */

import type { InboundPolicy } from "./registry.ts";
import {
  type DeliveryReceipt,
  type Message,
  type ReceiptStatus,
  hasReceipt,
  isExpired,
  messageVisibleToSession,
} from "./spool.ts";

export const TERMINAL_RECEIPTS: readonly ReceiptStatus[] = [
  "pushed",
  "read",
  "refused",
  "expired",
];

export function isTerminalReceipt(status: ReceiptStatus): boolean {
  return TERMINAL_RECEIPTS.includes(status);
}

export function settled(
  receipts: DeliveryReceipt[],
  messageId: string,
  sessionId: string,
): boolean {
  return hasReceipt(receipts, messageId, sessionId, [...TERMINAL_RECEIPTS]);
}

export function pendingHeldIds(
  receipts: DeliveryReceipt[],
  sessionId: string,
): string[] {
  const held: string[] = [];
  for (const receipt of receipts) {
    if (receipt.sessionId !== sessionId) continue;
    if (receipt.status === "held" && !held.includes(receipt.messageId)) {
      held.push(receipt.messageId);
    }
    if (isTerminalReceipt(receipt.status)) {
      const index = held.indexOf(receipt.messageId);
      if (index >= 0) held.splice(index, 1);
    }
  }
  return held;
}

export type DeliverAction =
  | { type: "push" }
  | { type: "hold" }
  | { type: "refuse"; detail: string }
  | { type: "expired" }
  | { type: "skip"; reason: "already settled" | "not visible" };

export interface DeliverDecision {
  action: DeliverAction;
  /** Oldest held message that must be refused to make room when policy=hold and
   * the queue is at capacity. */
  overflowHeldId?: string;
}

/** Events that drive a single delivery receipt through its lifecycle. */
export type ReceiptEvent =
  | { type: "deliver"; action: DeliverAction }
  | { type: "settle"; action: SettleAction };

/** Pure transition table for a delivery receipt. Terminal states are absorbing:
 *  once a receipt reaches `pushed`, `read`, `refused`, or `expired` it never
 *  changes again. */
export function receiptTransition(
  currentStatus: ReceiptStatus,
  event: ReceiptEvent,
): ReceiptStatus {
  switch (currentStatus) {
    case "spooled":
      if (event.type === "deliver") {
        switch (event.action.type) {
          case "skip":
            return "spooled";
          case "expired":
            return "expired";
          case "refuse":
            return "refused";
          case "hold":
            return "held";
          case "push":
            return "pushed";
        }
      }
      break;
    case "held":
      if (event.type === "settle") {
        switch (event.action.type) {
          case "push":
            return "pushed";
          case "expired":
            return "expired";
          case "refuse":
            return "refused";
        }
      }
      break;
    // `pushed`, `read`, `refused`, and `expired` are terminal.
  }
  return currentStatus;
}

/** Decide the delivery action for a newly spooled message destined to one
 * session. Mirrors the per-message logic in `poll()` from `channel.ts`. */
export function decideNewMessageDelivery(
  msg: Message & { id: string },
  sessionId: string,
  policy: InboundPolicy,
  muted: boolean,
  channelPush: boolean,
  heldLimit: number,
  receipts: DeliveryReceipt[],
  nowMs: number,
): DeliverDecision {
  if (settled(receipts, msg.id, sessionId)) {
    return { action: { type: "skip", reason: "already settled" } };
  }
  if (isExpired(msg, nowMs)) {
    return { action: { type: "expired" } };
  }
  if (!messageVisibleToSession(msg, sessionId)) {
    return { action: { type: "skip", reason: "not visible" } };
  }
  if (policy === "refuse") {
    return { action: { type: "refuse", detail: "policy" } };
  }
  if (policy === "hold") {
    const pending = pendingHeldIds(receipts, sessionId);
    const overflowHeldId =
      pending.length >= heldLimit && pending.length > 0
        ? pending[0]
        : undefined;
    return { action: { type: "hold" }, overflowHeldId };
  }
  // policy === "accept"
  if (muted || !channelPush) {
    return { action: { type: "hold" } };
  }
  return { action: { type: "push" } };
}

function receiptTs(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function addReceipt(
  receipts: DeliveryReceipt[],
  project: string,
  partial: Omit<DeliveryReceipt, "project">,
): DeliveryReceipt[] {
  return [...receipts, { ...partial, project }];
}

/** Apply `decideNewMessageDelivery` and return the resulting receipts. */
export function deliverNewMessage(
  project: string,
  msg: Message & { id: string },
  sessionId: string,
  policy: InboundPolicy,
  muted: boolean,
  channelPush: boolean,
  heldLimit: number,
  receipts: DeliveryReceipt[],
  nowMs: number,
): DeliveryReceipt[] {
  const { action, overflowHeldId } = decideNewMessageDelivery(
    msg,
    sessionId,
    policy,
    muted,
    channelPush,
    heldLimit,
    receipts,
    nowMs,
  );
  let next = receipts;
  if (overflowHeldId) {
    next = addReceipt(next, project, {
      messageId: overflowHeldId,
      ts: receiptTs(nowMs),
      status: receiptTransition("held", {
        type: "settle",
        action: {
          type: "refuse",
          messageId: overflowHeldId,
          detail: "held queue full",
        },
      }),
      sessionId,
      detail: "held queue full",
    });
  }
  const nextStatus = receiptTransition("spooled", { type: "deliver", action });
  if (action.type === "skip") {
    return next;
  }
  return addReceipt(next, project, {
    messageId: msg.id,
    ts: receiptTs(nowMs),
    status: nextStatus,
    sessionId,
    ...(action.type === "refuse" ? { detail: action.detail } : {}),
  });
}

export type SettleAction =
  | { type: "push"; messageId: string }
  | { type: "expired"; messageId: string }
  | { type: "refuse"; messageId: string; detail: string };

/** Decide which held messages should be released, expired, or delivered when a
 * session's policy or mute state changes. Mirrors `settleHeld()` from
 * `channel.ts`. */
export function decideHeldSettlements(
  sessionId: string,
  policy: InboundPolicy,
  muted: boolean,
  channelPush: boolean,
  messages: Map<string, Message>,
  receipts: DeliveryReceipt[],
  nowMs: number,
): SettleAction[] {
  const ids = pendingHeldIds(receipts, sessionId);
  if (ids.length === 0 || policy === "hold") return [];
  if (policy === "refuse") {
    return ids.map((messageId) => ({
      type: "refuse" as const,
      messageId,
      detail: "policy",
    }));
  }
  if (!channelPush || muted) return [];
  const actions: SettleAction[] = [];
  for (const messageId of ids) {
    if (settled(receipts, messageId, sessionId)) continue;
    const msg = messages.get(messageId);
    if (!msg) continue;
    if (isExpired(msg, nowMs)) {
      actions.push({ type: "expired", messageId });
    } else if (messageVisibleToSession(msg, sessionId)) {
      actions.push({ type: "push", messageId });
    }
  }
  return actions;
}

/** Apply `decideHeldSettlements` and return the resulting receipts. */
export function settleHeldMessages(
  project: string,
  sessionId: string,
  policy: InboundPolicy,
  muted: boolean,
  channelPush: boolean,
  messages: Map<string, Message>,
  receipts: DeliveryReceipt[],
  nowMs: number,
): DeliveryReceipt[] {
  const actions = decideHeldSettlements(
    sessionId,
    policy,
    muted,
    channelPush,
    messages,
    receipts,
    nowMs,
  );
  let next = receipts;
  for (const action of actions) {
    const nextStatus = receiptTransition("held", { type: "settle", action });
    if (nextStatus === "held") continue;
    next = addReceipt(next, project, {
      messageId: action.messageId,
      ts: receiptTs(nowMs),
      status: nextStatus,
      sessionId,
      ...(action.type === "refuse" ? { detail: action.detail } : {}),
    });
  }
  return next;
}
