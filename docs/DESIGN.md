# Design

## The pattern: handles, not values

The server is a credential broker that owns a browser. The agent holds opaque `SecretRef`s and asks the broker to act on them. Plaintext exists in exactly two places: broker memory during a fill, and the target page after it. The LLM context is never one of them.

Turnkey's export flow fits this exactly. `exportSecret` re-encrypts the secret to an ephemeral P-256 key the SDK generates in the broker process. Nobody else can decrypt the payload, including the Turnkey approvers. The broker is the single decryption point.

## The fill flow

`fill_secret(secret_id, element_uid)`:

1. Resolve the ref and the target element.
2. `BindingPolicy.assertAllowed(ref, target)` — see below.
3. Optional human confirmation (see "MCP spec hooks").
4. `SecretsClient.exportSecret(ref)` — plaintext lands in broker memory.
5. Register the value and the field with the `RedactionRegistry` **before** injection.
6. Inject over CDP `Input.insertText`. Never through `Runtime.evaluate`.
7. Drop the value. Return outcome only: `{ filled: true }`.

## Destination binding

Static properties are bound immutably to a secret at import and are policy-visible. We reserve three keys (`src/broker/types.ts`):

- `sbm:origin` — exact origin, required for a secret to be fillable
- `sbm:url-pattern` — optional URLPattern narrowing within the origin
- `sbm:selector` — optional CSS selector the target field must match

This is the prompt-injection defense. A malicious page can talk the agent into _requesting_ a fill. The fill still fails unless the live page matches the binding chosen by the human at import time.

Enforcement today is broker-side. The end state moves it into Turnkey's policy engine: a policy that evaluates the static properties makes the export itself unobtainable for the wrong destination, even with a stolen API key.

## Redaction

One choke point: `server.ts` pipes every tool result and every error through `scrub()`. Handlers cannot write to the transport.

Two mechanisms:

- **Structural** (primary): fields that received a secret are tagged by element uid. Snapshot serializers elide their values. The network tool withholds request bodies for origins with live secrets. Screenshots mask tagged fields.
- **Value-scan** (backstop): every exported plaintext goes into a scrub-set. Any string in any output that contains a live value is replaced with `[REDACTED:<secretId>]`.

Registration happens before the value touches the page, so no read can race ahead of redaction.

## Excluded tools

No `evaluate_script`. Agent-authored JS can hook `input` events and exfiltrate a fill, or read a filled field back. Excluding script evaluation is load-bearing; do not add it without revisiting the threat model.

## MCP spec hooks (2026-07-28 RC)

- **Tasks extension.** A Turnkey export that needs consensus maps onto a task handle. `fill_secret` returns the handle; the agent polls `tasks/get` while approvers sign the export activity (`createExportSecretsProposal` / `submitExportSecrets` / `awaitExportedSecrets` in `@turnkey/sdk-server`). The RC's stateless redesign lets the approval outlive any one connection.
- **MCP Apps.** A sandboxed-iframe confirmation UI — "Fill `github-pat` into `github.com/login`?" — rendered to the human, out of band from the agent. The agent cannot forge the approval.
- **JSON Schema 2020-12.** Type `secret_ref` parameters distinctly so gateways can route and rate-limit `fill_secret` calls on the `Mcp-Method` / `Mcp-Name` headers.

## Consensus exports

When policy requires more approvers, the broker runs the proposal flow itself rather than the SDK's one-shot `exportSecret` — the one-shot helper discards its ephemeral decryption key on the consensus path, which would leave the pending activity unredeemable. The broker submits the proposal, retains the key in memory keyed by activity id, and parks the fill:

- `fill_secret` returns `{status: "pending_approval", fill_id, activity_id}` instead of filling. Idempotent: re-requesting the same secret+element returns the same handle rather than proposing a duplicate.
- Approvers sign the export activity out-of-band (Turnkey dashboard). Co-signers are order-independent; the SDK serializes the proposal body once and every signer stamps the same bytes.
- `await_fill(fill_id)` waits for quorum, then **re-validates before injecting**: approval takes wall-clock time, so the binding is re-checked against the live page and the element is re-resolved. If the page moved on, the plaintext is dropped, never redirected.
- A broker restart discards the held decryption keys, making pending exports unredeemable by design. Timeouts return `pending_approval` again; rejection kills the fill.

Two honest gaps: the approver sees "release secret X to target key Y", not the destination page (closing that is the TVC attestation story plus a proposal-metadata feature request), and there is no proposal cancel — an abandoned fill leaves a pending activity whose key the broker has already dropped.

The `await_fill` tool is the transport-agnostic fallback; when MCP Tasks (2026-07-28 RC) client support lands, the same pending-fill state machine surfaces as a task handle instead.

## v2: TVC

Run the same broker inside [Turnkey Verifiable Cloud](https://docs.turnkey.com/features/verifiable-cloud/overview). What changes:

- The export key only ever exists inside an attested enclave. No machine the agent can shell into ever holds plaintext. This closes the local deployment's honest-agent gap (see [THREAT-MODEL.md](./THREAT-MODEL.md)).
- Boot proofs pin the broker code. Redaction and binding enforcement become verifiable properties of the QOS manifest.
- App proofs sign a fill audit trail: "this enclave filled secret X into origin Y at T."
- Target state: a Turnkey policy that only allows `exportSecret` when the target key is an attested TVC broker key. The secret becomes structurally unusable outside the verified broker.

Open feasibility questions for v2: headless Chrome in the default 2 vCPU / 1 GiB allocation, and browser-session affinity across the 3-replica default.

## Prior art

1Password agentic autofill and Browserbase contexts both do handle-passing. Neither has a policy engine on the export step, consensus approvals, or an attestation story. That is the differentiator.
