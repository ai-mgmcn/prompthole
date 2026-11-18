# Changelog

## 0.1.0 — unreleased

- Gateway for Anthropic, OpenAI, Gemini, LM Studio and any compatible upstream, configured from the UI.
- Content rules (keyword / regex; Mask, Block, Log), bulk import from Gitleaks, Secrets Patterns DB, keyword lists and `.env`.
- Import from a link: paste a URL to a Gitleaks / Secrets DB / plain-list file; the format is detected and previewed first. Private addresses are refused (SSRF-safe).
- Audit trail: every request is appended to a per-day file (`audit/YYYY-MM-DD.jsonl`) that is never compacted. The Requests page loads the days for the time range you choose (presets or custom dates) and pages by number with a page-size choice. `PROMPTHOLE_AUDIT_DAYS` is an optional retention limit and `PROMPTHOLE_MAX_EVENTS` sets the in-memory window.
- Hardening found in review: links that point at a private address are refused in every spelling (including IPv4 hidden in IPv6); downloads have an overall time limit; an audit file cut short by a crash no longer swallows the next record; purge replaces files in one step; model, tool and group names such as `constructor` or `__proto__` are treated as plain names; the built-in command library was tightened (fewer false alarms, more variants caught, no slow patterns) and imports are capped at 2,000 rules per file.
- Overview chart: time labels under the bars, a "N in the last hour · peak / min" summary and a tooltip per minute.
- Logos next to tools, providers and models in Overview and Requests (96 local PNGs, nothing loaded from the internet); names without a logo, or a logo that fails to load, get a coloured letter.
- Command rules can be bulk-imported: a built-in library of 33 sensitive commands (recursive delete, curl | sh, force push, DROP TABLE, reverse shells, …), or your own YAML/JSON file from a link or pasted text. Format: see `lib/sensitive-commands.yml`.
- Request log with token usage (cache and reasoning aware); optional, purgeable matched-text logging.
- Command audit with one-click block: tool calls in model responses are flagged or replaced (Anthropic Messages, OpenAI Chat Completions; streaming and JSON).
- Editable client detection.
- Docker image and compose file; GitHub Actions CI.
- Robustness: rules are scanned in worker threads with a time limit; catastrophic regexes are refused at save time; request size, upstream idle time and memory are bounded.
- Dashboard: paging, search and filters on the request log; lifetime statistics; works on narrow screens; polling pauses when the tab is hidden.
