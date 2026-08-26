# Threat model

## What we defend against

**Secret leakage into the LLM context.** The primary goal. Values never appear in tool results, so they never reach the model, the transcript, provider logs, or anything downstream of the conversation. Enforced by the handle-passing tool surface plus the redaction choke point in `src/server.ts`.

**Prompt-injection exfiltration.** A malicious page instructs the agent to fill a credential into an attacker-controlled field or site. Defenses, in order:

1. Destination bindings (`sbm:origin`, `sbm:url-pattern`, `sbm:selector`) fixed at import time. The broker refuses non-matching fills.
2. No `evaluate_script` tool, so the agent cannot plant page JS that reads or intercepts a fill.
3. Read-back scrubbing: snapshots, network logs, and screenshots cannot echo a filled value back into the context.
4. (Planned) Human confirmation via MCP Apps / elicitation before sensitive fills.
5. (End state) The same binding enforced in Turnkey's policy engine, so the export itself fails for a wrong destination.

**Approver exposure.** Consensus approvers sign the export activity but cannot read the secret. The payload is encrypted to the broker's ephemeral key.

## What we do NOT defend against (v1, local)

**An adversarial agent with a shell on the broker's host.** In Claude Code the agent has Bash on the same machine. It could attach a debugger to the broker, reach the browser's CDP endpoint, or edit the broker's config. v1's guarantee is honest-agent: it keeps secrets out of the context, it does not survive the agent attacking the host. Mitigations in order of strength: run the broker in a container the agent cannot reach, then TVC (v2), where no agent-reachable machine ever holds plaintext.

**The target site.** The filled page receives the secret by design. XSS on the destination origin, a compromised destination, or a phishing page on an _allowed_ origin path are out of scope. Prefer `sbm:url-pattern` over bare origins to shrink this surface: an allowed origin with attacker-controlled pages (user content, comments) is exactly the case a path pattern catches.

**JS memory.** JavaScript cannot reliably zeroize strings (see tkhq/sdk#1479 design notes). `release()` drops references; it does not wipe memory. The real story is process isolation (v1) and enclaves (v2).

## Assumptions that must hold

- The broker owns the browser exclusively: fresh profile, no extensions, no open remote-debugging TCP port, nothing else attached. If another debugger can connect, redaction is theater.
- Redaction registration happens before injection (see `src/browser/inject.ts` ordering contract).
- Turnkey static properties are immutable after import.
