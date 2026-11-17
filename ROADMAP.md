# Roadmap

PromptHole started as a single-user gateway on your own machine. The direction is a **shared gateway for a team or a company**:
one place that every AI tool talks to, so requests can be seen, protected and controlled centrally, without installing
anything inside each tool. Combined with an egress rule that only lets the gateway reach the AI providers, people cannot
bypass it.

None of the items below exist yet. Pick one, open an issue to say so, and send a PR. Items marked 🟢 are good first
issues; the others touch security-sensitive code, so please discuss the design in an issue first.

## Team / company deployment

Today PromptHole has **no login** and only accepts loopback traffic. That is the only thing protecting the dashboard, so do not
expose it to a network until the first three items are done.

- [ ] **1. Dashboard authentication.** Admin token (and later OIDC/SSO) for the dashboard and `/api`. Read-only role for auditors.
- [ ] **2. Configurable listen address and allowed hosts.** `PROMPTHOLE_ALLOWED_HOSTS` for the Host/Origin checks so it can sit behind a reverse proxy; documented TLS setup.
- [ ] **3. Identify *who*, not just *which tool*.** Issue each person or team a virtual key that PromptHole maps to a user and optional upstream key; show it in the log and allow per-user / per-team rules.
- [ ] **4. Central log export.** Syslog / OpenTelemetry / Prometheus metrics / webhook so audit data reaches the company's existing tooling. Configurable retention.
- [ ] **5. Shared deployment guide.** Docker/Kubernetes examples, running behind nginx or Caddy, sizing, and an egress-firewall recipe that forces traffic through the gateway.

## Coverage

- [ ] **OpenAI Responses API** tool-call inspection (used by newer Codex versions). 🟢 for the JSON path, SSE needs care.
- [ ] **Gemini** tool-call inspection (`functionCall`).
- [ ] Scan compressed (`content-encoding`) request bodies.
- [ ] Detect secrets in tool *results* sent back to the model, not only in user messages.
- [ ] Rule match types for tool calls beyond the command text (file paths for Write/Edit, URLs for fetch tools). 🟢

## Rules and policy

- [ ] Per-upstream / per-client rule sets (for example stricter rules for a CI bot). 🟢
- [ ] Approval flow: hold a flagged command and let an admin allow or deny it.
- [ ] Optional more robust detection for encoded secrets (base64, split values).
- [ ] Auto-update of imported rule libraries. 🟢
- [ ] Cost estimates from token usage and a model price table. 🟢

## Quality and project

- [ ] Browser end-to-end test of the dashboard. 🟢
- [ ] Windows testing and an install guide. 🟢
- [ ] Publish a Docker image from CI on release.
- [ ] Final project name (PromptHole is a placeholder).
