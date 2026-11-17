# Changelog

## 0.1.0 — unreleased

- Gateway for Anthropic, OpenAI, Gemini, LM Studio and any compatible upstream, configured from the UI.
- Content rules (keyword / regex; Mask, Block, Log), bulk import from Gitleaks, Secrets Patterns DB, keyword lists and `.env`.
- Request log with token usage (cache and reasoning aware); optional, purgeable matched-text logging.
- Command audit with one-click block: tool calls in model responses are flagged or replaced (Anthropic Messages, OpenAI Chat Completions; streaming and JSON).
- Editable client detection.
- Docker image and compose file; GitHub Actions CI.
