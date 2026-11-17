# Security policy

PromptHole sits between your tools and AI providers, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository. Include steps to reproduce and the impact. Expect an acknowledgement within a few days.

## Scope notes

In scope: bypassing the loopback / Host / Origin protections, leaking credentials or stored matched text, crashing the gateway with crafted traffic, a way to make PromptHole execute or forward something unintended.

Known and documented limits (not vulnerabilities): pattern matching can be evaded by encoding; PromptHole has no login and relies on being bound to loopback; it cannot stop tools that bypass the base URL. See "Limitations" in the README.

## Supported versions

Only the latest release receives fixes.
