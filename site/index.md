---
title: Secure Browser MCP
canonical: https://tkhq.github.io/secure-browser-mcp/
html: https://tkhq.github.io/secure-browser-mcp/
---

# Secure Browser MCP

> Credentials without context leakage.

Secure Browser MCP lets an agent log in, check out, and fill forms while credentials remain in Turnkey Secrets. The agent receives a reference; the broker injects the secret directly into the browser.

## Why use it?

### Bound at import

Secrets are constrained to an origin, URL pattern, selector, or defined group of fields before an agent can request a fill.

### Approval when it matters

Turnkey consensus can park an export for human approval. The page is re-validated immediately before a fill completes.

### Designed to be boring

There are no secret values in model context, MCP output, or logs, and no arbitrary script-evaluation tool.

## Read next

- [Setup](setup.md) ([HTML](setup.html))
- [Workflow guide](docs.md) ([HTML](docs.html))
- [MCP reference](reference.md) ([HTML](reference.html))
- [LLM index](llms.txt)
