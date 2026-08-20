# Development

Development runs from a checkout under [Bun](https://bun.com/docs/installation),
which executes the TypeScript sources directly:

```bash
git clone https://github.com/osteele/agent-mail
cd agent-mail
bun install
bun link
agent-mail install
```

[`bun link`](https://bun.com/docs/pm/cli/link) points the `agent-mail` command
at the checkout instead of the installed package; make sure Bun's global binary
directory, usually `~/.bun/bin`, is on `PATH`.

```bash
bun run check    # biome + tsc --noEmit
bun test
bun run build    # emit dist/, as the published package ships
```

The code runs under both Bun and Node. Everything that differs between them
(subprocesses, the HTTP server, synchronous sleeps, reading a slice of a file)
goes through `src/runtime.ts`, which dispatches on the host; no other module
tests which runtime it is on. Under Bun each function delegates to the Bun API
it replaced, so the runtime used in development stays the fast path.

The published package ships JavaScript rather than the TypeScript sources
because Node refuses to strip types for files under `node_modules`, so a
package shipping `.ts` installs but cannot run. `bun run
build` is what `npm` runs through `prepare` on a GitHub install.

The test suite uses `bun:test` and is not part of the published package.

Further reading: [docs/architecture.md](docs/architecture.md) covers how
agent-mail works underneath, [docs/http-api.md](docs/http-api.md) lists the
daemon's HTTP endpoints, and [docs/automation.md](docs/automation.md) specifies
the machine-readable state outputs.
