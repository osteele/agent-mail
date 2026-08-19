/** Runtime primitives that differ between Bun and Node.
 *
 * agent-mail is developed and run under Bun. This module exists so it can also
 * run under Node, without forking the codebase: every Bun-only API is reached
 * through one of the functions here, which dispatch on the host at import time.
 *
 * Two rules keep the seam honest.
 *
 * - **Bun stays the fast path.** Under Bun each function delegates to the Bun
 *   API it replaced, so the port cannot slow down or subtly change the runtime
 *   everyone actually uses. The Node branch is the one that has to prove
 *   itself.
 * - **No call site tests the host.** `isBun` is not exported. A conditional in
 *   application code is a second seam that drifts from this one, and the
 *   difference between the hosts is exactly what this module is for.
 *
 * What is deliberately *not* here: `bun:test`. The suite is Bun-only and stays
 * that way, so a Node run is verified by the same MCP and CLI smoke paths a
 * user exercises, not by a second test framework.
 */

import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import {
  constants,
  accessSync,
  closeSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:http";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Whether the module identified by `metaUrl` is the program being run.
 *
 * `import.meta.main` says this in one word, but only on Bun and on Node 24.2
 * and later; on Node 22 it is `undefined`, so the guarded block silently never
 * runs. Comparing against `argv[1]` works everywhere. Both sides are resolved
 * through the filesystem because the entry point is often reached through a
 * symlink — `bun link` and `npm link` both install one — while `import.meta.url`
 * always names the real file. */
export function isEntryPoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(entry))
    );
  } catch {
    return false; // one of the two no longer exists
  }
}

/** Typed handle on Bun's globals without importing them, so this module still
 * compiles and loads under Node, where `Bun` does not exist. */
type BunGlobal = {
  sleepSync(ms: number): void;
  file(path: string): {
    slice(start: number, end: number): { text(): Promise<string> };
  };
  stdin: { text(): Promise<string> };
  which(command: string): string | null;
  spawn(
    argv: string[],
    options: { stdout: "pipe"; stderr: "ignore" },
  ): { stdout: ReadableStream; exited: Promise<number> };
  spawnSync(
    argv: string[],
    options: { stdout: "pipe"; stderr: "ignore" },
  ): { exitCode: number; stdout: { toString(): string } };
  readableStreamToText(stream: ReadableStream): Promise<string>;
  serve(options: {
    port: number;
    hostname: string;
    fetch: (
      request: Request,
    ) => Response | undefined | Promise<Response | undefined>;
  }): { port: number; stop(force?: boolean): void };
};

const bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;

/** Block the thread for `ms`. Used only in retry backoff, where the caller is
 * holding a lock or polling a file and has nothing to yield to. */
export function sleepSync(ms: number): void {
  if (isBun) {
    bun.sleepSync(ms);
    return;
  }
  // Atomics.wait on a location that never changes is the only portable
  // synchronous sleep in Node; it always runs to the timeout.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read bytes `[start, end)` of a file as UTF-8.
 *
 * The spool is append-only and read from a saved offset, so this reads a
 * window rather than the whole file — the file grows without bound and the
 * window is usually one message. */
export async function readFileSlice(
  path: string,
  start: number,
  end: number,
): Promise<string> {
  if (isBun) return bun.file(path).slice(start, end).text();
  const length = end - start;
  if (length <= 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read all of stdin as UTF-8. Callers are one-shot CLI entry points that are
 * handed a JSON payload on stdin and exit. */
export async function readStdinText(): Promise<string> {
  if (isBun) return bun.stdin.text();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Absolute path of `command` on PATH, or undefined. */
export function which(command: string): string | undefined {
  if (isBun) return bun.which(command) ?? undefined;
  const path = process.env.PATH;
  if (!path) return undefined;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, or not executable
    }
  }
  return undefined;
}

export interface CapturedProcess {
  /** stdout, decoded. Rejects if the process could not be started. */
  stdout: Promise<string>;
  /** Exit code. Rejects if the process could not be started. */
  exited: Promise<number>;
}

/** Run `argv`, capturing stdout and discarding stderr.
 *
 * A missing executable is reported through the returned promises on both
 * hosts, never as a synchronous throw. `Bun.spawn` does throw synchronously,
 * which took the daemon down once under launchd, whose PATH omits weft; that
 * asymmetry is absorbed here so callers have one failure mode. */
export function spawnCapture(argv: string[]): CapturedProcess {
  if (isBun) {
    try {
      const proc = bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
      return {
        stdout: bun.readableStreamToText(proc.stdout),
        exited: proc.exited,
      };
    } catch (error) {
      return guarded(Promise.reject(error), Promise.reject(error));
    }
  }
  const child = nodeSpawn(argv[0] as string, argv.slice(1), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdout = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout?.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    child.on("error", reject);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });
  return guarded(stdout, exited);
}

/** Both promises reject together when the process cannot start, so whichever
 * one the caller does not await would otherwise surface as an unhandled
 * rejection — which Bun treats as fatal. Attaching an inert handler marks them
 * handled without consuming the rejection the caller still sees. */
function guarded(
  stdout: Promise<string>,
  exited: Promise<number>,
): CapturedProcess {
  void stdout.catch(() => {});
  void exited.catch(() => {});
  return { stdout, exited };
}

/** Run `argv` to completion, capturing stdout and discarding stderr.
 *
 * Reports a missing executable as a non-zero exit rather than throwing, so
 * callers distinguish "ran and failed" from "could not observe" by exit code
 * alone. */
export function spawnSyncCapture(argv: string[]): {
  exitCode: number;
  stdout: string;
} {
  if (isBun) {
    try {
      const result = bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
      return { exitCode: result.exitCode, stdout: result.stdout.toString() };
    } catch {
      return { exitCode: -1, stdout: "" };
    }
  }
  const result = nodeSpawnSync(argv[0] as string, argv.slice(1), {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (result.error) return { exitCode: -1, stdout: "" };
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "" };
}

export interface HttpServer {
  /** Bound port. Meaningful when the caller passed 0 for an ephemeral port. */
  readonly port: number;
  stop(force?: boolean): void;
}

/** Serve `fetch` over HTTP on `hostname:port`.
 *
 * Returns a promise because Node binds asynchronously and `port` is not known
 * until it has. `Bun.serve` is synchronous, so under Bun the promise is
 * already resolved; awaiting it costs a microtask and keeps one shape for both
 * hosts. */
export async function serve(options: {
  port: number;
  hostname: string;
  fetch: (
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>;
}): Promise<HttpServer> {
  if (isBun) {
    const server = bun.serve(options);
    return { port: server.port, stop: (force?: boolean) => server.stop(force) };
  }
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = `http://${incoming.headers.host ?? options.hostname}${incoming.url ?? "/"}`;
      const method = incoming.method ?? "GET";
      // Decoded as text, not bytes: the only server this backs is the daemon's
      // 127.0.0.1 JSON API. A binary request body would be corrupted here, so
      // if one is ever added this must move to a byte-preserving path.
      let body: string | undefined;
      if (method !== "GET" && method !== "HEAD") {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks).toString("utf8");
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value))
          for (const one of value) headers.append(name, one);
      }
      const request = new Request(url, { method, headers, body });
      const response =
        (await options.fetch(request)) ??
        new Response("not found", { status: 404 });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) =>
        outgoing.setHeader(name, value),
      );
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      // A handler that throws must not take the daemon down; the request fails
      // and the server keeps serving, matching Bun's behavior.
      if (!outgoing.headersSent) outgoing.statusCode = 500;
      outgoing.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port, options.hostname, resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    stop: (force?: boolean) => {
      server.close();
      if (force) server.closeAllConnections?.();
    },
  };
}
