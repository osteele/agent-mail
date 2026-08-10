import { canonicalProject, displayName } from "./paths.ts";
import type { Registration } from "./registry.ts";
import { type ClaudeSessionMeta, sessionDisplayName } from "./sessions.ts";
import type { Message } from "./spool.ts";

const SLACK_SECTION_LIMIT = 3000;
const LIVE_NAME_LIMIT = 3;

export interface SlackEchoFormat {
  sectionText: string;
  fallbackText: string;
  listening: boolean;
}

function escapeSlack(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function bold(text: string): string {
  return `*${escapeSlack(text).replaceAll("*", "∗")}*`;
}

function code(text: string): string {
  return `\`${escapeSlack(text).replaceAll("`", "ˋ")}\``;
}

function slackDate(ts: string): string {
  const epoch = Math.floor(Date.parse(ts) / 1000);
  if (!Number.isFinite(epoch)) return "";
  const fallback = new Date(ts).toLocaleTimeString();
  return ` · <!date^${epoch}^{time}|${fallback}>`;
}

function sameProject(left: string, right: string): boolean {
  return (
    left.includes("/") && canonicalProject(left) === canonicalProject(right)
  );
}

function liveRecipientNames(
  msg: Message,
  registrations: Registration[],
  sessions: Map<string, ClaudeSessionMeta>,
): string[] {
  const senderSid = msg.meta?.sessionId;
  return registrations
    .filter(
      (registration) =>
        registration.sessionId &&
        registration.sessionId !== senderSid &&
        canonicalProject(registration.cwd) === canonicalProject(msg.project),
    )
    .map((registration) =>
      sessionDisplayName(
        registration.sessionId as string,
        sessions.get(registration.sessionId as string),
        registration.cwd,
      ),
    )
    .sort((a, b) => a.localeCompare(b));
}

function liveSummary(names: string[]): { mrkdwn: string; plain: string } {
  if (names.length === 0) return { mrkdwn: "", plain: "" };
  const shown = names.slice(0, LIVE_NAME_LIMIT);
  const remaining = names.length - shown.length;
  const suffix = remaining > 0 ? ` +${remaining}` : "";
  return {
    mrkdwn: ` _(live: ${shown.map(code).join(", ")}${suffix})_`,
    plain: ` (live: ${shown.join(", ")}${suffix})`,
  };
}

function route(
  msg: Message,
  registrations: Registration[],
  sessions: Map<string, ClaudeSessionMeta>,
): { mrkdwn: string; plain: string; listening: boolean } {
  const senderSid = msg.meta?.sessionId;
  const sourceProject = displayName(msg.from);
  const targetProject = displayName(msg.project);
  const senderSession = senderSid
    ? sessionDisplayName(senderSid, sessions.get(senderSid), msg.from)
    : undefined;

  if (msg.delivery === "audit" && msg.meta?.nativeRecipient) {
    const target = msg.meta.nativeRecipient;
    const listening = registrations.some(
      (registration) =>
        canonicalProject(registration.cwd) === canonicalProject(msg.project),
    );
    if (senderSession && sameProject(msg.from, msg.project)) {
      return {
        mrkdwn: `${bold(targetProject)} · ${code(`${senderSession} → ${target}`)}`,
        plain: `${targetProject} · ${senderSession} → ${target}`,
        listening,
      };
    }
    return {
      mrkdwn: `${senderSession ? `${bold(sourceProject)} ${code(senderSession)}` : bold(sourceProject)} → ${bold(targetProject)} ${code(target)}`,
      plain: `${sourceProject}${senderSession ? ` ${senderSession}` : ""} → ${targetProject} ${target}`,
      listening,
    };
  }

  const directSid = msg.meta?.toSession;
  const liveNames = liveRecipientNames(msg, registrations, sessions);
  const listening = directSid
    ? registrations.some(
        (registration) =>
          registration.sessionId === directSid &&
          canonicalProject(registration.cwd) === canonicalProject(msg.project),
      )
    : liveNames.length > 0;
  const targetSession = directSid
    ? sessionDisplayName(directSid, sessions.get(directSid), msg.project)
    : "all";
  const live = directSid ? { mrkdwn: "", plain: "" } : liveSummary(liveNames);

  if (senderSession && sameProject(msg.from, msg.project)) {
    return {
      mrkdwn: `${bold(targetProject)} · ${code(`${senderSession} → ${targetSession}`)}${live.mrkdwn}`,
      plain: `${targetProject} · ${senderSession} → ${targetSession}${live.plain}`,
      listening,
    };
  }

  const source = senderSession
    ? `${bold(sourceProject)} ${code(senderSession)}`
    : bold(sourceProject);
  const sourcePlain = `${sourceProject}${senderSession ? ` ${senderSession}` : ""}`;
  return {
    mrkdwn: `${source} → ${bold(targetProject)} ${code(targetSession)}${live.mrkdwn}`,
    plain: `${sourcePlain} → ${targetProject} ${targetSession}${live.plain}`,
    listening,
  };
}

function truncateBody(body: string, available: number): string {
  if (available <= 0) return "";
  if (body.length <= available) return body;
  return available === 1 ? "…" : `${body.slice(0, available - 1)}…`;
}

/** Build the visible Slack section and notification fallback for one message. */
export function formatSlackEcho(
  msg: Message,
  registrations: Registration[],
  sessions: Map<string, ClaudeSessionMeta>,
): SlackEchoFormat {
  const formattedRoute = route(msg, registrations, sessions);
  const lines = [`:mailbox: ${formattedRoute.mrkdwn}${slackDate(msg.ts)}`];
  if (msg.replyTo) {
    const re = msg.meta?.replyToFrom
      ? `${bold(msg.meta.replyToFrom)}: ${msg.meta.replyToPreview ?? ""}`
      : `message ${msg.replyTo.slice(0, 8)}`;
    lines.push(`↩︎ re ${re}`);
  }
  const prefix = `${lines.join("\n")}\n`;
  const body = truncateBody(msg.message, SLACK_SECTION_LIMIT - prefix.length);
  const sectionText = truncateBody(`${prefix}${body}`, SLACK_SECTION_LIMIT);
  return {
    sectionText,
    fallbackText: `📬 ${formattedRoute.plain}: ${body}`,
    listening: formattedRoute.listening,
  };
}
