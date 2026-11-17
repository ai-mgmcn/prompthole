# Contributing to PromptHole

Thanks for helping. Bug reports, rule libraries, client/provider support and docs are all welcome.

Looking for something to work on? See [ROADMAP.md](ROADMAP.md); items marked 🟢 are good first issues.

## Ground rules

- **Zero runtime dependencies.** Dev dependencies (the official SDKs used by tests) are fine; anything `server.mjs` imports must be Node built-ins or in this repo.
- **Fail open.** If PromptHole cannot understand a response, it must pass it through unchanged. Never break the user's tool because of our inspection.
- **Never store credentials** and never log request bodies. Anything stored that may contain a secret must be masked first.
- Keep `lib/` **pure** (no I/O) so it stays easy to test.

## Setup

```bash
git clone <repo> && cd prompthole
npm install
npm test                 # must pass
npm run test:coverage    # CI requires >= 95% line coverage
node server.mjs          # http://127.0.0.1:8787
```

Use `PROMPTHOLE_DATA=/tmp/prompthole-dev` to keep experiments away from your real rules.

## Where things go

| Change | Place | Test |
|---|---|---|
| New secret / rule parsing | `lib/rulelib.mjs` | `test/rulelib.test.mjs` |
| Matching, tokens, client detection | `lib/core.mjs` | `test/core.test.mjs` |
| Tool-call audit / blocking | `lib/toolcalls.mjs` (+ `src/inspect.mjs` for a new API shape) | `test/toolcalls.test.mjs`, `test/commands.test.mjs` |
| New HTTP endpoint | `src/api.mjs` | `test/gateway.test.mjs` |
| Dashboard page | `public/js/pages/*.js`, register in `public/js/main.js` | `test/ui.test.mjs` |

A page is `{ id, title, init?, load(first) }`. Add the tab button and `<section id="…">` to `public/index.html`.

### Adding support for a new API shape (e.g. OpenAI Responses)

1. Teach `src/inspect.mjs` to recognise it.
2. Add a JSON rewriter and an SSE filter to `lib/toolcalls.mjs`.
3. Test it at every chunk size (see the existing SSE tests) and with a truncated stream.
4. Add an integration test with a mock upstream, and an SDK test if an official SDK exists.

## Pull requests

- One topic per PR; explain the *why*.
- Add tests for new behaviour. Bug fixes need a test that fails without the fix.
- Run `npm test` before pushing; CI runs Node 22 and 24 and builds the Docker image.
- Do not paste real keys, tokens or request bodies in issues or tests. Use obviously fake values.

By contributing you agree your work is released under the [MIT License](LICENSE).
