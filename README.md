# Meta Muse Code for Paseo

A native, server-only Paseo v0.8 provider using `@muse-code/sdk` and `muse serve` over MSP. No ACP adapter or per-turn CLI wrapper is required.

## Install

Requires Node 20+, **Paseo 0.8.x** (tested with `0.8.0-beta.1`), and an authenticated Muse installation on the daemon machine. From this repository's directory:

```sh
muse login
npm ci --omit=dev --ignore-scripts
paseo plugin install "$PWD"
paseo plugin ls --json
paseo provider models muse --json
```

Enable **Settings → Plugins → Enable plugins** in Paseo if it is off. Confirm `paseo-muse` is enabled and `running`, and that the model list is nonempty. Select **Meta Muse Code** when creating an agent. Alternatively:

```sh
paseo run 'Explain this repository' \
  --provider muse --model muse-spark-1.3 --mode promptUnmatched
```

For a Git installation, the manifest runs `npm ci --omit=dev --ignore-scripts`. Paseo supplies its plugin SDK and Zod at runtime. Muse remains a separate executable. The SVG is a simple plugin icon, not Meta branding.

Authentication stays with Muse. `META_API_KEY` may be supplied through the daemon/session environment; do not put credentials in plugin settings, the manifest, or provider options. Each session gets a fresh host with `{...process.env, ...session.env}`.

A directory install uses that directory as its source; keep the checkout and its runtime dependencies available. Run these commands on the daemon machine. The daemon must be able to find `muse` in its own environment, even if your interactive shell can find it.

## Supported behavior

| Surface             | Implementation                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Models              | Live `model/list`, descriptions and context limits; committed model selection at open and configure        |
| Modes               | `promptUnmatched` (default), `denyUnmatched`, `onRequest`, `allowAll`                                      |
| Thinking            | Schema-pinned `none` through `ultra`, passed on turns/steers                                               |
| Messages and images | Text and inline PNG/JPEG/WebP/GIF; complete assistant/reasoning snapshots with stable IDs                  |
| Tools               | Built-in Paseo tool rows, including subagent activity and generic fallback for unknown tool kinds          |
| Approvals           | Server-offered choices with the exact requirement token; both notification and request presentation paths  |
| Queue and steer     | Queue admission stays distinct from starting; steering targets the current turn explicitly                 |
| Stop                | Retracts queued turns, interrupts the foreground turn, waits for authoritative terminal events             |
| Persistence         | Muse durable ID in Paseo's opaque persistence; paged history replay before ready                           |
| Usage               | Session input/output totals and context usage                                                              |
| Failures            | Bounded startup/command/shutdown, same-command admission retries, SDK gap recovery, runtime-failure events |

One Muse host belongs to each active Paseo session. The provider limits itself to eight hosts across its connections, 32 pending turns per session, 64 pending approvals, and 10,000 buffered startup events. Stderr is drained by the SDK and is not mirrored into plugin logs.

The adapter uses the SDK `Connection` for typed commands and `Session` for the authoritative fold and gap recovery. It does not retry an uncertain prompt as a new command. After transport death, reopen the durable session to inspect the recovered history before submitting more work.

## Launch options and boundaries

MSP has no native fields for Paseo system prompts, MCP-server injection, or arbitrary tool preapproval rules. The installed plugin explicitly uses Muse's own MCP configuration and displays a session notice when Paseo MCP servers are present but not injected. This lets Muse work with Paseo's default host-tool injection setting without changing other providers. Paseo host tools are not attached to Muse. Unsupported system prompts and tool preapproval rules are still rejected.

Advanced callers may pass `config.providerOptions` when creating an agent:

```json
{
  "museBin": "/absolute/path/to/muse",
  "serveArgs": [],
  "schemaMismatch": "fail",
  "systemPromptStrategy": "reject",
  "unsupportedMcpStrategy": "use-muse-native-config",
  "requestTimeoutMs": 30000,
  "shutdownTimeoutMs": 5000
}
```

Configuration choices:

- `systemPromptStrategy: "prepend-user-context"` supplies Paseo's prompt as **user-level context on each submission**. It does not change Muse's system instructions.
- `unsupportedMcpStrategy: "use-muse-native-config"` permits opening with Paseo MCP configuration present, while displaying a notice that those servers were not injected.
- `unsupportedMcpStrategy: "reject"` rejects any supplied Paseo MCP configuration. The adapter library retains this strict default; the plugin entry point explicitly selects native configuration.
- `schemaMismatch: "warn"` permits an untested fingerprint and displays a notice. The default is to fail.

Model, mode, and thinking are normal Paseo composer controls, not provider options. `museBin` in session options only affects that session; to change discovery as well, set the `createMuseProvider({museBin: ...})` default in `index.server.ts`.

Structured user-input elicitation is currently canceled with an explicit notice. Uploaded file paths are rejected; ask Muse to read a workspace-relative file instead. Text/forge/review attachments are serialized as labeled user context without local file reads. Muse children appear as tool rows; provider-owned child sessions, subagent control buttons, slash commands, revert, archive, and automatic reconnection are not implemented or advertised.

Two observed upstream limitations affect the tested releases:

1. The tested Muse host returns a placeholder view cursor and no turn events for `--no-session-log`. The adapter detects this and rejects the session. **Use durable sessions (`persist: true`).** Catalog-only probes can still use a memory-only host.
2. **Paseo `0.8.0-beta.1` retains a closed provider runtime for existing agents after plugin reload.** Normal agent reload works. After reloading the plugin, restart the daemon to restore existing agents; the end-to-end test verifies this recovery. Plugin reload/removal still shuts down active Muse hosts.

## Verification

Pinned and tested on September 8, 2026:

- `@getpaseo/plugin` and the real Paseo CLI/daemon: `0.8.0-beta.1`
- `@muse-code/sdk`: `0.1.1`
- Muse launcher: `1.0.2-R2040.1`; the MSP handshake reports server `1.0.3`
- MSP fingerprint: `sha256:03312c213efd14277a0e0a102f70adeae497a469ca4edf7242f479953ed758b7`

```sh
npm ci --ignore-scripts     # Include development dependencies for these checks
npm run check              # Typecheck, 17 contract/schema tests, formatting
npm run test:schema         # Installed Muse's exported fingerprint
npm run test:live           # Real model, tools, config, persistence, replay
npm run test:live:controls  # Real images, allow/deny, queue, steer, stop
PASEO_CLI=/path/to/paseo npm run test:paseo
```

Live tests use your existing Muse authentication and consume model tokens. The controls test deliberately disables sandboxing **only for its temporary host**, to force approval prompts for harmless shell writes to temporary test files; it checks both allow and deny. Production hosts keep Muse's sandbox defaults. Files are cleaned up; Muse's durable test transcripts remain in Muse's own session store.

`test:paseo` starts an isolated beta daemon with its own temporary home, port, and workspace; it disables MCP injection, relay, and speech downloads. It checks plugin compilation/loading, live catalog, prompts/timeline, durable reload, continuation, mode/thinking controls, interruption, plugin reload and removal during active work, and the beta reload workaround. It stops the daemon afterward. Diagnostic logs and a result summary go into ignored `.tmp/` files.

The credential-free CI lane typechecks the pinned SDKs and runs contract tests. Releases additionally require the host-schema and live tests above. The schema gate fails on a changed fingerprint; review and adapt the generated types before repinning.

The image schema fixture is extracted from `muse schema generate-json-schema`. The text transcript fixture was captured from a real test turn and contains only synthetic test content. These complement fixtures for pre-ack events, delayed terminals, stale snapshots, queued launch failure, approvals, transport death, admission backpressure, and gap replay.

## API references

- [Paseo v0.8 provider guide](https://paseo.sh/docs/plugins/v0.8/providers)
- [Paseo v0.8 plugin reference](https://paseo.sh/docs/plugins/v0.8/reference)
- [Meta Muse SDK source and protocol documentation](https://github.com/meta-models/muse-code-sdk)

The installed package declarations and the host-exported schema are the implementation's type authority. The starting design's illustrative field names were adjusted to those contracts.

## Maintaining this checkout

Commit `package-lock.json` and `.npmrc` together with dependency changes. SDK versions are exact pins; do not update them independently of the compatibility fixture and host-schema check. `npm run check` needs no Muse login, model calls, or running Paseo daemon. The live commands above provide the release checks.

Before using a changed version, run the checks, inspect `git diff --check`, and commit the tested files. Check installation from a separate checkout with only production dependencies to catch accidental dependencies on development packages. Plugin reload in the tested Paseo beta has the existing-agent limitation described above; schedule it when you can also restart Paseo if necessary.

This repository is a private, source-installed plugin. Publishing to npm is disabled by `private: true`; no remote, registry publication, deployment, or infrastructure configuration is required for local usage. `HANDOVER.md` and `.tmp/` hold local operational notes and test diagnostics and are intentionally ignored by Git.
