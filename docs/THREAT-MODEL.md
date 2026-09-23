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

## Hosted broker

The hosted broker (`src/http.ts`, [HOSTED.md](HOSTED.md)) is a Turnkey-operated fill service. Describe it that way. It does not keep the claim that Turnkey never sees your secrets.

**Who can see plaintext, and when.**

| Party                                    | Sees plaintext? | When                                                                                                                                                                 |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent and the agent platform         | No              | Never. The tool surface and redaction are the same as stdio.                                                                                                         |
| Consensus approvers                      | No              | Never. The export is encrypted to the broker's ephemeral key.                                                                                                        |
| The broker process (Turnkey-operated)    | Yes             | During a fill: from the export decrypt until the value is in the page. Also while the value stays in the redaction registry for scrubbing, until the session closes. |
| The session's browser (Turnkey-operated) | Yes             | From injection until the session closes. The filled page holds the value as any form does.                                                                           |
| Operators with access to the broker host | Yes             | Anyone who can read the broker's memory, attach a debugger, or change its image can read a value during a fill.                                                      |
| The state volume                         | No              | Parked fills hold the export decryption key, encrypted with `SBM_STATE_KEY`. The key is not on the volume.                                                           |
| The target site                          | Yes             | By design, as in v1.                                                                                                                                                 |

**Parked fills hold key material.** A parked fill contains the ephemeral private key for an export that approvers may still approve. Anyone with both the state volume and `SBM_STATE_KEY` can decrypt that export after approval. The broker encrypts each parked fill with AES-256-GCM and binds it to its file name, and drops parked fills after 24 hours.

**Sessions.** Each MCP session gets its own Chrome process with a fresh profile, driven over a pipe, so "nothing else attached" holds per session. A session sees only its own pending fills. A fill whose session is gone (after a restart or reconnect) can be claimed by the session that presents its `fill_id`. The broker gave that random id only to the original session, but any holder of the bearer token and the id can claim the fill. Step 1 has one bearer token and one Turnkey key for all sessions, so every caller with the token can list and fill every secret the key can export. Per-tenant keys come in step 2.

**The agent controls navigation.** The browser can reach every address the broker host can reach. Restrict egress to the public internet, so an agent (or a page that injects instructions into it) cannot use the browser to read internal services or cloud metadata.

**Chrome's sandbox stays on.** The broker holds plaintext during a fill, so a renderer that escapes into the broker's process can read it. Do not run the hosted browser with `--no-sandbox`.

**Planned.** Design 2 (EMG-89) moves decryption into the browser extension from demo-runner-tk, so the hosted service never holds plaintext. Design 3 runs the broker and browser in an attested enclave.

## Assumptions that must hold

- The broker owns the browser exclusively: fresh profile, no extensions, no open remote-debugging TCP port, nothing else attached. If another debugger can connect, redaction is theater.
- Redaction registration happens before injection (see `src/browser/inject.ts` ordering contract).
- Turnkey static properties are immutable after import.
