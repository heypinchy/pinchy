# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Pinchy, **please do not open a public issue.**

Instead, email us at **hey@clemenshelm.com** with:

1. A description of the vulnerability
2. Steps to reproduce it
3. Potential impact
4. Suggested fix (if you have one)

We will acknowledge your report within **48 hours** and aim to release a fix within **7 days** for critical issues.

## Scope

This policy applies to the Pinchy codebase and its official distributions. Issues in dependencies should be reported to the respective maintainers.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |

## Recognition

We appreciate responsible disclosure. Contributors who report valid security issues will be credited in our release notes (unless they prefer to remain anonymous).

## Security Design Principles

Pinchy is built with security as a core design principle:

- **Self-hosted by default** — your data never leaves your infrastructure
- **Agent permission layer** — agents get scoped tool access via an allow-list model. No tools are available by default; admins explicitly enable them per agent.
- **Two-tier access control** — admin and user roles with agent-level access checks (personal vs. shared agents)
- **Encryption at rest** — provider API keys are encrypted with AES-256-GCM
- **Offline-capable** — works without any external network calls
