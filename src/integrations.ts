/** Pure configuration transforms for host integrations. */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeAuditHandler(value: unknown, scriptPath: string): boolean {
  if (!isObject(value) || value.type !== "command") return false;
  const args = Array.isArray(value.args) ? value.args : [];
  return (
    args.includes(scriptPath) ||
    (typeof value.command === "string" && value.command.includes(scriptPath))
  );
}

/** Add the optional SendMessage audit hook without disturbing other hooks. */
export function addNativeAuditHook(
  document: Record<string, unknown>,
  command: string,
  scriptPath: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  const hooks = isObject(output.hooks) ? output.hooks : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  for (const group of postToolUse) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    if (
      group.hooks.some((handler) => isNativeAuditHandler(handler, scriptPath))
    ) {
      return { document: output, changed: false };
    }
  }
  postToolUse.push({
    matcher: "SendMessage",
    hooks: [
      {
        type: "command",
        command,
        args: [scriptPath],
        timeout: 10,
      },
    ],
  });
  hooks.PostToolUse = postToolUse;
  output.hooks = hooks;
  return { document: output, changed: true };
}

/** Remove only handlers installed by agent-mail, retaining neighboring hooks. */
export function removeNativeAuditHook(
  document: Record<string, unknown>,
  scriptPath: string,
): { document: Record<string, unknown>; changed: boolean } {
  const output = structuredClone(document);
  if (!isObject(output.hooks) || !Array.isArray(output.hooks.PostToolUse)) {
    return { document: output, changed: false };
  }
  let changed = false;
  const groups: unknown[] = [];
  for (const group of output.hooks.PostToolUse) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => {
      const remove = isNativeAuditHandler(handler, scriptPath);
      if (remove) changed = true;
      return !remove;
    });
    if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
  }
  output.hooks.PostToolUse = groups;
  return { document: output, changed };
}

/** Whether `codex mcp get --json` describes this checkout's server. */
export function codexRegistrationMatches(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  if (!isObject(value) || !isObject(value.transport)) return false;
  const transport = value.transport;
  return (
    transport.type === "stdio" &&
    transport.command === command &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    transport.args[0] === channelPath
  );
}

/** Whether a Claude user-scope mcpServers entry belongs to this checkout. */
export function claudeRegistrationMatches(
  value: unknown,
  command: string,
  channelPath: string,
): boolean {
  if (!isObject(value)) return false;
  return (
    value.type === "stdio" &&
    value.command === command &&
    Array.isArray(value.args) &&
    value.args.length === 1 &&
    value.args[0] === channelPath
  );
}
