# Threat model

## What we defend against

**Secret leakage into the LLM context.** The primary goal. Values never appear in tool results, so they never reach the model, the transcript, provider logs, or anything downstream of the conversation. Enforced by the handle-passing tool surface plus the redaction choke point in `src/server.ts`.

**Prompt-injection exfiltration.** A malicious page instructs the agent to fill a credential into an attacker-controlled field or site. Defenses, in order:

1. Destination bindings (`sbm:origin`, `sbm:frame-origin`, `sbm:url-pattern`, `sbm:selector`) fixed at import time. An iframe fill needs both the page origin and the frame origin ([FRAMES.md](FRAMES.md)). The broker refuses non-matching fills.
2. No `evaluate_script` tool, so the agent cannot plant page JS that reads or intercepts a fill.
3. Read-back scrubbing: tool results (today, snapshots and error messages) cannot echo a filled value back into the context. This includes copies the page reformats (`4242 4242 4242 4242`), re-renders as a new node, mirrors into other fields and text, splits across several fields, or puts URL-encoded in the page URL. See [Limits of read-back scrubbing](#limits-of-read-back-scrubbing) for the exact matching rules.
4. (Planned) Human confirmation via MCP Apps / elicitation before sensitive fills.
5. (End state) The same binding enforced in Turnkey's policy engine, so the export itself fails for a wrong destination.

### Limits of read-back scrubbing

Two layers redact read-back. Structural redaction tags the fields that received a secret, and fields found holding a copy, and elides their values by element uid. The value scan then checks every string in every tool result for live plaintexts. The value scan uses these rules:

- **Exact match:** every live value, of any length.
- **Loose match:** values of 8 or more letters and digits. The scan compares letters and digits only, after Unicode NFKC normalization and case folding. It reads decimal digits in any script as 0-9 and decodes percent escapes (`%20`). Values made only of digits compare on digits only, so letters between groups also count as separators. Any character can be a separator, with at most 3 separator characters between two kept characters (`4242, 4242` matches; `4242 -- , 4242` does not).
- **Split fields:** a snapshot also scans the values of its visible, untagged fields joined in document order, and redacts every field that holds part of a match.

These cases are out of scope. They are encodings, or they need a page that works against the scanner, which is the target-site case below:

- **Short values** (under 8 letters and digits: a CVC, an expiry, a PIN) match exactly only. A reformatted copy (`1 2 3`) is not caught unless it lands in a tagged field.
- **Partial copies** (a last four, a BIN) are left alone on purpose.
- **Wide or padded gaps:** more than 3 separator characters between groups, or groups interleaved with other letters and digits.
- **Copies split across tool results:** half the value in one snapshot and half in the next. The scan does not join results.
- **Split text outside field values:** the split-field check joins field values only, not button text or labels.
- **Encodings:** reversal, base64, hex, multi-byte percent escapes, HTML entities in raw markup, and anything a page computes from the value.

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

**Tenants and tokens.** Each tenant has its own endpoint, Turnkey organization and API key, and trusted authorization servers ([HOSTED.md](HOSTED.md#tenants)). The broker accepts only JWT access tokens whose audience is exactly the tenant's, and no two tenants share an audience, so a token for one tenant fails at another even when both trust the same issuer. Every validation failure, including an unreachable JWKS, refuses the request. Tokens are never forwarded or logged. Each tool needs a scope, checked on every call, so a token can be limited to driving the browser. The shared bearer token remains only as a development mode (`SBM_DEV_SHARED_TOKEN`), off by default.

Tenant isolation covers:

- A caller reaches only its tenant's secrets, through the tenant's API key. Turnkey policy on that key bounds what it can export. Without per-tenant keys scoped by policy, tenant separation rests on the broker's routing alone.
- A session answers only to the tenant, subject (`iss`, `sub`), and OAuth client that opened it.
- A browser handle (`browser_id`) answers only to the tenant, subject, and OAuth client that opened it. For anyone else it does not exist.
- A parked fill belongs to one tenant and one subject, and is stored under the tenant's derived key. No other tenant can see or redeem it, and no other subject can claim it.
- With `allowedClients`, tokens issued to other clients are refused.

It does not cover:

- The broker process holds plaintext during every fill, for every tenant. A compromise of the process exposes every tenant's fills in progress. Run separate deployments for tenants that must not share a process.
- The authorization server is trusted for what it issues. If it is compromised, or issues tokens for the broker's audience to the wrong subjects, that tenant's secrets are exposed up to what its Turnkey policy and approvals allow.
- Without `allowedClients`, every client the authorization server issues tokens to is trusted, including dynamically registered clients. A parked fill belongs to the subject, not the client, so another trusted client of the same subject can claim it.
- `SBM_STATE_KEY` derives every tenant's key. The state volume and that key together decrypt every tenant's parked fills.
- Tokens are bearer tokens. A stolen one works until it expires, for 24 hours at most. Sender-constrained tokens (DPoP) are not supported.

**Parked fills hold key material.** A parked fill contains the ephemeral private key for an export that approvers may still approve. Anyone with both the state volume and `SBM_STATE_KEY` can decrypt that export after approval. The broker encrypts each parked fill with AES-256-GCM under its tenant's key and binds it to its file name, and drops parked fills after 24 hours.

**Sessions.** Each MCP session, and each browser handle, gets its own browser. With local Chrome, the broker drives it over a pipe, so "nothing else attached" holds per session. With Browserbase, the broker cannot verify that nothing else is attached: Browserbase can attach, and anyone holding the session's connect URL can too. The broker never logs or returns that URL, and it never requests live-view or debug URLs. A session sees only its own pending fills. A fill whose session is gone (after a restart or reconnect) can be claimed by a session of the same tenant and subject that presents its `fill_id`. The broker gave that random id only to the original session.

**Browser callers.** The broker refuses any request whose `Origin` header is not in `SBM_ALLOWED_ORIGINS` (empty by default), before it checks the bearer token. A web page that a user opens cannot use the user's browser to call a broker on a private network (DNS rebinding). Non-browser clients send no `Origin` and depend on the bearer token alone.

**The agent controls navigation.** On Browserbase, the browser reaches the internet from Browserbase's network, not ours. With local Chrome, the browser can reach every address the broker host can reach: restrict egress to the public internet, so an agent (or a page that injects instructions into it) cannot use the browser to read internal services or cloud metadata.

**Chrome's sandbox stays on.** With local Chrome, the broker holds plaintext during a fill, so a renderer that escapes into the broker's process can read it. Do not run the browser with `--no-sandbox`.

**Planned.** Design 2 (EMG-89) moves decryption into the browser extension from demo-runner-tk, which already runs on Browserbase. Then the hosted service never holds plaintext, and Browserbase is the only operator that can see it. Design 3 runs the broker and browser in an attested enclave.

## Assumptions that must hold

- The broker owns the browser exclusively: fresh profile, no extensions, no open remote-debugging TCP port, nothing else attached. If another debugger can connect, redaction is theater.
- Redaction registration happens before injection (see `src/browser/inject.ts` ordering contract).
- Turnkey static properties are immutable after import.
