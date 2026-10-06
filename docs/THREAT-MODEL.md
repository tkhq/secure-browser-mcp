# Threat model

## What we defend against

**Secret leakage into the LLM context.** The primary goal. Values never appear in tool results, so they never reach the model, the transcript, provider logs, or anything downstream of the conversation. Enforced by the handle-passing tool surface plus the redaction choke point in `src/server.ts`.

**Prompt-injection exfiltration.** A malicious page instructs the agent to fill a credential into an attacker-controlled field or site. Defenses, in order:

1. Destination bindings (`sbm:origin`, `sbm:url-pattern`, `sbm:selector`) fixed at import time. The broker refuses non-matching fills.
2. No `evaluate_script` tool, so the agent cannot plant page JS that reads or intercepts a fill.
3. Read-back scrubbing: snapshots, network logs, and screenshots cannot echo a filled value back into the context. This includes copies the page reformats (`4242 4242 4242 4242`), re-renders as a new node, or mirrors into other fields and text. Values of 8 characters or more also match with separators removed and case folded. Shorter values match exactly only.
4. (Planned) Human confirmation via MCP Apps / elicitation before sensitive fills.
5. (End state) The same binding enforced in Turnkey's policy engine, so the export itself fails for a wrong destination.

**Approver exposure.** Consensus approvers sign the export activity but cannot read the secret. The payload is encrypted to the broker's ephemeral key.

## What we do NOT defend against (v1, local)

**An adversarial agent with a shell on the broker's host.** In Claude Code the agent has Bash on the same machine. It could attach a debugger to the broker, reach the browser's CDP endpoint, or edit the broker's config. v1's guarantee is honest-agent: it keeps secrets out of the context, it does not survive the agent attacking the host. Mitigations in order of strength: run the broker in a container the agent cannot reach, then TVC (v2), where no agent-reachable machine ever holds plaintext.

**The target site.** The filled page receives the secret by design. It can also encode the value (reverse it, base64 it) so that read-back scrubbing cannot recognize it. XSS on the destination origin, a compromised destination, or a phishing page on an _allowed_ origin path are out of scope. Prefer `sbm:url-pattern` over bare origins to shrink this surface: an allowed origin with attacker-controlled pages (user content, comments) is exactly the case a path pattern catches.

**JS memory.** JavaScript cannot reliably zeroize strings (see tkhq/sdk#1479 design notes). `release()` drops references; it does not wipe memory. The real story is process isolation (v1) and enclaves (v2).

## Hosted broker

The hosted broker (`src/http.ts`, [HOSTED.md](HOSTED.md)) is a Turnkey-operated fill service. Describe it that way. It does not keep the claim that Turnkey never sees your secrets.

**Who can see plaintext, and when.**

| Party                                    | Sees plaintext? | When                                                                                                                                                                                          |
| ---------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent and the agent platform         | No              | Never. The tool surface and redaction are the same as stdio.                                                                                                                                  |
| Consensus approvers                      | No              | Never. The export is encrypted to the broker's ephemeral key.                                                                                                                                 |
| The broker process (Turnkey-operated)    | Yes             | During a fill: from the export decrypt until the value is in the page. Also while the value stays in the redaction registry for scrubbing, until the session closes.                          |
| Browserbase (default browser host)       | Yes             | From the moment the value crosses the CDP WebSocket (TLS) until the session ends. The value is in their browser, and they operate the machine it runs on. Recording and session logs are off. |
| The session's browser                    | Yes             | From injection until the session closes. The filled page holds the value as any form does.                                                                                                    |
| Operators with access to the broker host | Yes             | Anyone who can read the broker's memory, attach a debugger, or change its image can read a value during a fill.                                                                               |
| The state volume                         | No              | Parked fills hold the export decryption key, encrypted with a per-tenant key derived from `SBM_STATE_KEY`. The key is not on the volume.                                                      |
| The tenant's authorization server        | No              | Never. It issues access tokens; the broker validates them and passes them nowhere.                                                                                                            |
| The target site                          | Yes             | By design, as in v1.                                                                                                                                                                          |

**Tenants and tokens.** Each tenant has its own endpoint, its own Turnkey organization and API key, and its own trusted authorization servers ([HOSTED.md](HOSTED.md#tenants)). The broker accepts only JWT access tokens whose issuer the tenant trusts, whose signature verifies against that issuer's published keys, whose audience is exactly the tenant's endpoint URL, and that have not expired. A token for one tenant is refused at another's endpoint even when both trust the same issuer. Every failure, including an unreachable JWKS, refuses the request. Tokens are never forwarded to Turnkey or Browserbase and never logged. Each tool needs a scope (`sbm:browse`, `sbm:fill`, or `sbm:refs`), checked on every call, so a token can be limited to driving the browser without filling secrets.

What this changes from step 1:

- A caller reaches only its tenant's secrets: the broker uses the tenant's API key, and Turnkey policy on that key bounds what it can export. Without per-tenant keys scoped by Turnkey policy, tenant separation rests on the broker's routing alone.
- A session is bound to the tenant and the token subject (`iss`, `sub`) that opened it. Its session id is useless to anyone else.
- A parked fill belongs to one tenant and one subject. It is stored in the tenant's directory under the tenant's derived key. Another tenant cannot list, see, or redeem it, before or after a restart, and another subject of the same tenant cannot claim it after its session ends.
- The shared bearer token survives only as a development mode (`SBM_DEV_SHARED_TOKEN`), off unless set, which logs a warning.

What does not change:

- The broker process holds plaintext during every fill, for every tenant. Tenants share one process: a compromise of the broker, or of anyone who can read its memory, exposes every tenant's fills in progress. Run separate deployments for tenants that must not share a process.
- With Browserbase, Browserbase holds plaintext in the browser for the life of the session.
- The authorization server is trusted for what it issues. A tenant whose authorization server is compromised, or that issues tokens with the broker's audience to the wrong subjects, exposes that tenant's secrets up to what its Turnkey policy and approvals allow. Approvals stay in Turnkey policy; the broker's scopes do not replace them.
- `SBM_STATE_KEY` derives every tenant's state key. Anyone with the state volume and that key can decrypt every tenant's parked fills.
- A token is a bearer token: anyone who steals an unexpired one can use it until it expires. The broker does not support sender-constrained tokens (DPoP) yet.

**Parked fills hold key material.** A parked fill contains the ephemeral private key for an export that approvers may still approve. Anyone with both the state volume and `SBM_STATE_KEY` can decrypt that export after approval. The broker encrypts each parked fill with AES-256-GCM under its tenant's key and binds it to its file name, and drops parked fills after 24 hours.

**Sessions.** Each MCP session gets its own browser. With local Chrome, the broker drives it over a pipe, so "nothing else attached" holds per session. With Browserbase, the broker cannot verify that nothing else is attached: Browserbase can attach, and anyone holding the session's connect URL can too. The broker never logs or returns that URL, and it never requests live-view or debug URLs. A session sees only its own pending fills. A fill whose session is gone (after a restart or reconnect) can be claimed by a session of the same tenant and subject that presents its `fill_id`. The broker gave that random id only to the original session.

**The agent controls navigation.** On Browserbase, the browser reaches the internet from Browserbase's network, not ours. With local Chrome, the browser can reach every address the broker host can reach: restrict egress to the public internet, so an agent (or a page that injects instructions into it) cannot use the browser to read internal services or cloud metadata.

**Chrome's sandbox stays on.** With local Chrome, the broker holds plaintext during a fill, so a renderer that escapes into the broker's process can read it. Do not run the browser with `--no-sandbox`.

**Planned.** Design 2 (EMG-89) moves decryption into the browser extension from demo-runner-tk, which already runs on Browserbase. Then the hosted service never holds plaintext, and Browserbase is the only operator that can see it. Design 3 runs the broker and browser in an attested enclave.

## Assumptions that must hold

- The broker owns the browser exclusively: fresh profile, no extensions, no open remote-debugging TCP port, nothing else attached. If another debugger can connect, redaction is theater.
- Redaction registration happens before injection (see `src/browser/inject.ts` ordering contract).
- Turnkey static properties are immutable after import.
