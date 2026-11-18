# PromptHole

**PromptHole — the Pi-hole for AI.** A gateway that shows and controls every request your tools send to AI.

![PromptHole demo: logos in the Overview, masking a secret, blocking a private key, paging through the audit trail, blocking a command the model asked to run, and importing command and secret rules](docs/demo.gif)

<sub>The demo uses a scripted stand-in for the model and a week of made-up history so it is reproducible; the masking, blocking, command interception, audit paging and rule imports (the Gitleaks rules are downloaded live) are PromptHole's real behaviour.</sub>

A local gateway for AI API traffic. Point your AI tools at PromptHole instead of the provider and you get:

- **See** every request: which tool sent it, to which model, how many tokens, and what matched your rules.
- **Protect** what you send: mask or block secrets and keywords *before* they leave your machine.
- **Control** what the model asks your tools to run: audit every command the model wants to execute, and block one with a single click. PromptHole swaps it for a text note, so the client never runs it.

No client-side plugins or hooks. You change one thing: the base URL.

```
Claude Code / Codex / SDK  ──►  PromptHole (127.0.0.1:8787)  ──►  Anthropic / OpenAI / Gemini / LM Studio / your company gateway
                                  │ rules, audit, dashboard
```

**If you have used Pi-hole, you will feel at home:** it is the same idea for AI. One gateway on your network, a dashboard that shows who is talking to what, and rules that decide what gets through.

Zero runtime dependencies. Node 22+. MIT licensed.

## Quick start

```bash
git clone <this repo> && cd prompthole
node server.mjs            # or: docker compose up -d
# open http://127.0.0.1:8787
```

Then point a tool at it (the **Setup** tab shows the exact line and has a Copy button):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic      # Claude Code, Anthropic SDK
export OPENAI_BASE_URL=http://127.0.0.1:8787/openai/v1         # OpenAI SDK, Codex CLI
```

Your own API key is forwarded to the provider unchanged and is never stored.

## What you can do in the dashboard

| Tab | Purpose |
|---|---|
| **Overview** | Requests, tokens (cache and reasoning aware), blocked / masked counts, commands blocked, top rules, tools, models. Tools, providers and models are shown with their logos. |
| **Requests** | Every request with its action, matched rules and tokens. Pick a time range (last hour … all time, or your own dates) and the days are loaded from disk automatically; search, filter (including “commands flagged or blocked”) and move between pages by number. Click one for details: matched text (hidden until you click Reveal) and the commands the model asked for, each with a **Block…** button. |
| **Commands** | Your command rules (flag / block) and the on/off switch. One click imports a built-in library of 33 sensitive commands, or import your own YAML/JSON file from a link (format: `lib/sensitive-commands.yml`). Blocking a command from a request lands here with the rule ready to confirm. |
| **Rules** | Your keyword / regex rules (Mask, Block, Log). Bulk-import from Gitleaks (~220 patterns) or Secrets Patterns DB, paste a keyword list, import a `.env`, or paste a link to any Gitleaks / Secrets DB / plain-list file (public links only). |
| **Clients** | How PromptHole recognises which tool sent a request. Editable, first match wins. |
| **Setup** | Upstreams (provider URL, error format, the line to configure your tool). Add any provider from the UI. |

### Content rules: Mask, Block, Log

- **Mask** replaces the match with a placeholder such as `[PROMPTHOLE_AWSKEY_1a5d44]` *before sending*. It is one-way: PromptHole does not restore the original in responses.
- **Block** rejects the request locally with a provider-shaped error (so the SDK shows a normal error).
- **Log** only records it.

### Commands: audit first, block when you decide

PromptHole reads the tool calls in the model's response. Built-in rules only **flag** risky ones (`rm -r`, `curl | sh`, force push, `sudo`, credential files, uploading a local file). Nothing is blocked until you open a request, click **Block…** next to a command under “Tool calls the model asked for”, and choose how to match it (exact, starts with, contains, regex). The next time the model asks for it, PromptHole replaces the tool call with a text note (`⛔ PromptHole blocked this tool call … It was NOT executed`) and corrects the stop reason, so the client carries on without running it.

Command text is masked with your content rules before it is stored or matched, so secrets never reach the audit log.

Supported for inspection: Anthropic Messages and OpenAI Chat Completions, streaming and non-streaming. Anything else passes through untouched.

## Configuration

Everything is editable in the UI and stored as JSON in the data directory (files are `0600`).

| Env var | Default | |
|---|---|---|
| `PROMPTHOLE_PORT` | `8787` | Listen port |
| `PROMPTHOLE_DATA` | `./data` | Where rules, settings and the audit trail (`audit/YYYY-MM-DD.jsonl`) live |
| `PROMPTHOLE_AUDIT_DAYS` | `0` | Delete audit days older than this many days. `0` keeps everything |
| `PROMPTHOLE_MAX_EVENTS` | `5000` | Recent requests kept in memory for the Overview (minimum 100). The audit trail is not limited by this |
| `PROMPTHOLE_HOST` | `127.0.0.1` | Only change inside a container (see Docker) |
| `PROMPTHOLE_MAX_BODY_MB` | `64` | Largest request body PromptHole will buffer and scan (larger gets HTTP 413) |
| `PROMPTHOLE_SCAN_TIMEOUT_MS` | `3000` | A rule scan that takes longer is stopped |
| `PROMPTHOLE_ON_SCAN_TIMEOUT` | `block` | `block` rejects the request (safe); `allow` forwards it unscanned |
| `PROMPTHOLE_SCAN_WORKERS` | CPU count − 1 (1–4) | Worker threads that run the rules |
| `PROMPTHOLE_UPSTREAM_IDLE_SECONDS` | `900` | Give up on a provider that sends nothing for this long |
| `PROMPTHOLE_ALLOW_PRIVATE_URLS` | unset | Set to `1` to let "Import from a link" reach internal hosts (default: public links only) |

### Keeping up with new tool versions

You should not need a code change for a new client version:

- **Recognising a tool:** *Clients* tab. "Recently seen" lists the user-agents PromptHole has met; click **Create rule** to turn one into a client.
- **A new provider or gateway:** *Setup* tab → add a name, a prefix, the upstream URL and the error format (`openai`, `anthropic` or `gemini`).
- **New risky commands:** *Commands* tab → add a rule, or import more content rules in *Rules*.

## Docker

```bash
docker compose up -d      # dashboard on http://127.0.0.1:8787, data in the "prompthole-data" volume
```

The compose file publishes the port to **127.0.0.1 only**. Do not publish it on all interfaces: PromptHole has no login, the loopback binding is its access control. To reach LM Studio / Ollama on your machine, set the upstream URL to `http://host.docker.internal:1234`.

## Performance

PromptHole is a proxy, so it is built not to be the bottleneck. Measured on a laptop (Node 22):

- **Overhead:** about 0.25 ms per request (this includes writing the audit record); roughly 3,000 requests/second on one machine. A model call takes seconds, so this is invisible.
- **Rules run in worker threads**, each scan has a time limit, and a rule that hangs only stalls its own scan: with 1,100 imported rules, a 5 MB prompt takes about 1.2 s to scan, and other requests were delayed by 11 ms (not seconds).
- **Long chats stay cheap:** text already found clean is remembered, so each turn only scans what is new.
- **Memory is bounded:** only the latest 5,000 requests are kept in memory (for the Overview); after 45,000 requests (some of them aborted by the client) memory stayed under 190 MB. Every request is also appended to a per-day audit file on disk, which is read only for the days you ask for and cached with a size limit. Lifetime totals are counted separately and never roll off.
- **Slow regexes are refused** when you save or import a rule (catastrophic backtracking), and stopped at the time limit if one still gets through.

## Security model

- Binds to `127.0.0.1` only; the dashboard and API reject foreign `Host` headers (DNS-rebinding) and cross-origin writes.
- Strict CSP on the dashboard; no remote assets.
- Credentials are forwarded, never stored; request bodies are never stored, only rule names, a masked sample and (optionally) the matched text, which you can switch off and purge.
- Data files are owner-readable only.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Limitations (please read)

- **Not a sandbox.** PromptHole sees the model's *request* to run a command. It cannot stop a tool that runs things on its own, or an agent that was not pointed at PromptHole.
- **Only traffic through the base URL.** Web apps and desktop apps that ignore a custom URL are out of scope.
- **Tool-call inspection** covers Anthropic Messages and OpenAI Chat Completions today. OpenAI Responses and Gemini are not inspected yet.
- **Command rules look at the first 64 KB** of a tool call (commands are short; a Write call carrying a large file is matched on its first 64 KB only).
- Compressed (`content-encoding`) request bodies are not scanned.
- WebSocket traffic (for example OpenAI Realtime) is not proxied.
- The Overview breakdowns (top rules, tools, models) cover the latest 5,000 requests; the headline totals are lifetime. The Requests page covers the whole audit trail.
- The audit files are plain JSON lines, one file per UTC day, never rewritten (except “Purge stored text” and the optional `PROMPTHOLE_AUDIT_DAYS` cleanup). They hold metadata and, only if you keep the option on, the matched text; request bodies are never stored. Very busy days are slower to open the first time (a record is about 0.5 KB, so a day with a million requests is a file of roughly half a gigabyte).
- Pattern matching can be evaded by encoding (base64, splitting a value across messages). Treat it as a safety net for accidents, not a barrier against a determined attacker.
- Imported Go-regex rules are converted to JavaScript; a few are marked *adapted* because case-insensitivity can only be applied to the whole pattern.

## Roadmap

PromptHole works today as a single-user gateway. The goal is a **shared gateway for teams and companies**: authentication,
per-person identity, central log export and a deployment guide are not built yet. See [ROADMAP.md](ROADMAP.md); contributions are very welcome.

## Development

```bash
npm install            # dev dependencies only (official SDKs used in tests)
npm test               # unit + integration + real-SDK tests, no network needed
npm run test:coverage
```

Layout: `server.mjs` (entry) · `src/` (config, store, http, proxy, api, static) · `lib/` (pure logic: rules, parsing, tool calls) · `public/` (dashboard ES modules) · `test/`.

See [CONTRIBUTING.md](CONTRIBUTING.md). Third-party notices: [THIRD_PARTY.md](THIRD_PARTY.md). License: [MIT](LICENSE).
