---
title: Secure Browser MCP reference
canonical: https://tkhq.github.io/secure-browser-mcp/reference.html
html: https://tkhq.github.io/secure-browser-mcp/reference.html
---

# MCP operations

The tool surface is intentionally small. All results pass through the server's redaction layer.

| Operation               | Input                                         | Result / behavior                                                                                |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `list_secret_refs`      | None                                          | Opaque IDs, names, and destination bindings. Never returns secret values.                        |
| `navigate`              | `url`                                         | Navigates the broker-owned browser and returns its final URL and title.                          |
| `snapshot`              | None                                          | Returns interactive element IDs. Filled values are redacted.                                     |
| `click`                 | `element_uid`                                 | Clicks an element from the most recent snapshot.                                                 |
| `type_text`             | `element_uid`, `text`                         | Types visible, non-secret text. Never use it for a credential.                                   |
| `fill_secret`           | `secret_id` plus `element_uid`, or `fields`   | Checks the binding, requests export, then injects via CDP. May return `pending_approval`.        |
| `await_fill`            | `fill_id`, optional `timeout_seconds` (1–120) | Waits for approval, revalidates the target, and completes a pending fill; it can remain pending. |
| `list_network_requests` | None                                          | Reserved scaffold; currently returns `not_implemented`.                                          |

## Fill shapes

### Single field

```json
{ "secret_id": "secret_123", "element_uid": "input_4" }
```

### Multi-field JSON payload

```json
{
  "secret_id": "card_123",
  "fields": [
    { "key": "number", "element_uid": "input_4" },
    { "key": "expiry", "element_uid": "input_5" },
    { "key": "cvc", "element_uid": "input_6" }
  ]
}
```

Each payload key must be declared in the secret's `sbm:fields` binding. The multi-field call uses one export and, when configured, one approval.

## Configuration

| Variable                  | Meaning                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `SBM_CHROME_PATH`         | Optional explicit path to a Chromium-based browser.         |
| `SBM_HEADLESS=false`      | Shows the broker-owned browser instead of running headless. |
| `TURNKEY_API_PUBLIC_KEY`  | Turnkey API public key for the real Secrets backend.        |
| `TURNKEY_API_PRIVATE_KEY` | Turnkey API private key for the real Secrets backend.       |
| `TURNKEY_ORGANIZATION_ID` | Turnkey organization containing the secrets.                |

## Read next

- [Workflow guide](docs.md) ([HTML](docs.html))
- [Setup](setup.md) ([HTML](setup.html))
