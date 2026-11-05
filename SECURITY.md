# Security Policy

We take the security of Basis and the data our customers entrust to it
seriously. This document explains how to report a vulnerability.

## Reporting a vulnerability

Please report suspected security issues privately. **Do not** open a public
GitHub issue, pull request, or discussion for a security report.

- **Email:** security@basis1.tech
- Encrypt sensitive details if possible, and include:
  - a description of the issue and its impact,
  - steps to reproduce (a minimal proof of concept is ideal),
  - affected component (API, engine/parser, SDK, app) and version or date,
  - any relevant logs or request/response samples with secrets redacted.

We aim to acknowledge reports within **2 business days** and to provide a
remediation timeline after triage.

## Scope

In scope:

- The clients in this repository: the TypeScript SDK (`@basis1/parse`) and
  the MCP server (`@basis1/mcp`).
- The hosted parsing API (`api.basis1.tech`) and the Basis engine/parser they
  talk to.
- The web application.

Out of scope:

- Denial of service via volumetric traffic.
- Findings that require a compromised host, browser, or credentials already
  under your control.
- Automated scanner output without a demonstrated, exploitable impact.

## Safe harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service degradation, only interact with accounts
they own or have explicit permission to test, and give us a reasonable chance
to remediate before any public disclosure.

## Handling of uploaded files

The parser accepts untrusted spreadsheet files. If you believe you can cause
memory exhaustion, decompression amplification ("zip bomb"), path traversal, or
code execution through a crafted upload, treat it as **in scope and high
priority** and report it via the channel above.
