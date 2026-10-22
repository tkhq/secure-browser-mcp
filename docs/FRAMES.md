# Iframes and shadow roots

The broker fills fields inside iframes and open shadow roots. This note gives the binding rules, how the broker reads frames over CDP, where it checks the destination again, and what `@turnkey/browser-secrets` still needs. Tracked as EMG-66 (GitHub #15).

## What fills where

| Field location                                     | Binding needed                                               |
| -------------------------------------------------- | ------------------------------------------------------------ |
| Top-level document                                 | `sbm:origin`                                                 |
| Open shadow root in the top-level document         | `sbm:origin`                                                 |
| Same-origin iframe                                 | `sbm:origin` and `sbm:frame-origin` (the same origin)        |
| Cross-origin iframe (Stripe Elements, Adyen)       | `sbm:origin` and `sbm:frame-origin` (the frame origin)       |
| Closed shadow root                                 | Never fills (`unsupported_shadow_root`)                      |
| Sandboxed iframe, `srcdoc`, `about:blank`, `data:` | Never fills (`opaque_origin`, `unsupported_document_scheme`) |

The rules come from `authorize` in `@turnkey/browser-secrets`. The broker does not add or relax any of them.

- `sbm:origin` is always the top-level page origin. A frame fill needs both origins, and `authorize` checks both together. A binding with only a frame origin would let the same provider iframe fill on an attacker's site.
- A secret without `sbm:frame-origin` fills the top-level document only. Secrets imported before frame support keep that behavior.
- A secret with `sbm:frame-origin` fills iframes of that origin only, never the top-level document (`frame_bound_top_level_target`).
- `sbm:url-pattern` constrains the top-level URL, never the frame URL. Provider frame URLs change between releases and often carry keys in the fragment.
- `sbm:selector` and `sbm:fields` are matched in the target's own document.

To import a frame-bound secret, pass `--frame-origin` to `scripts/import-secret.ts`:

```sh
bun run scripts/import-secret.ts --name shop-card \
  --origin https://shop.example --frame-origin https://js.stripe.com \
  --fields '{"number":"input[name=cardnumber]","expiry":"input[name=exp-date]","cvc":"input[name=cvc]"}' \
  --value-env CARD_JSON
```

## Nested frames

A target's frame ancestry runs from the top-level document to the target's document. Each frame between them must have the top-level origin or the frame origin. Anything else is `unbound_intermediate_frame`. So `shop.example → js.stripe.com → js.stripe.com` fills, and `shop.example → ads.example → js.stripe.com` does not.

## Opaque origins

The broker reads each frame's origin in two ways: `securityOrigin` from `Page.getFrameTree`, and `window.origin` in an isolated world in that document. It keeps the origin only when the two agree. Otherwise it reports `"null"`. A sandboxed iframe is the case this catches: the frame tree can report the origin of the frame's URL while the document's origin is opaque.

`authorize` refuses a frame anywhere in the ancestry when its URL is not HTTP(S) (`unsupported_document_scheme`: `srcdoc`, `about:blank`, `data:` and `blob:` documents), or when its origin is not the origin of its URL (`opaque_origin`).

## How the broker reads frames over CDP

Chrome runs a cross-site iframe in its own process as a separate CDP target (an out-of-process iframe, OOPIF). The tab's own target does not list it in `Page.getFrameTree`, and backendNodeIds mean something only in their own target. A same-site iframe, cross-origin or not, stays in the tab's target.

1. **Attach.** When the browser starts, the broker's own session to the tab calls `Target.setAutoAttach` with `flatten: true` and an `iframe` filter. Chrome attaches a flattened session to every OOPIF, now and as they appear, and the broker calls the same on each child session for nested OOPIFs. A flattened session shares the one browser connection, so this works the same over a local pipe and over a Browserbase CDP WebSocket. If a host refuses auto-attach, OOPIF fields are left out of snapshots.
2. **Place each frame.** The broker uses puppeteer's frame tree for structure only. For a child frame it finds the owner `<iframe>` node in the parent's target and reads the child's frame ID from `DOM.describeNode` there. An OOPIF's target ID is its frame ID, so that names its session. Otherwise the frame must be listed, with the right parent, in the frame tree of the parent's session. A frame the broker cannot place is left out of snapshots.
3. **Snapshot.** Every placed frame is queried through open shadow roots. Uids are `e<backendNodeId>` for nodes in the tab's target and `f<n>e<backendNodeId>` for nodes in OOPIF `n`, so they are unique across targets and stable across snapshots. A field in an iframe carries `frame_origin`. Redaction tags use the field's own frame and document IDs, the same identity `authorize` returns for it.
4. **Observe.** For each target, the broker reads every document in its ancestry: frame ID, loader ID (document identity), URL, and origin, each from the session of the target that hosts the frame. The element must still be in the document it was snapshotted in. Selector and shadow-root evidence is read in an isolated world in that document.
5. **Write.** `DOM.focus` and `Input.insertText` go to the session of the target that holds the element.

Iframes inside shadow roots are not placed today: puppeteer finds an owner `<iframe>` with `querySelectorAll` in the parent's light DOM. Such fields stay out of snapshots.

## Revalidation points

The broker observes and authorizes the full ancestry again at each point below. It also requires the same destination as the first check (`isSameDestination`: same browser session, tab, and target frame and document).

1. `fill_secret`, before the export.
2. `await_fill`, before the wait.
3. `await_fill`, after approval, before the plaintext goes anywhere.
4. Each target, immediately before its write.

A frame that navigates or is removed drops its uids, and those of the frames inside it. A navigation of the top-level page drops all uids. Its loader ID also changes, so a check made before the change does not match one made after it, even if an event is missed. In each case the fill is refused, the plaintext is dropped, and a parked fill stays parked for a fresh target.

The negative fixtures in `test/frames.test.ts` cover: an allowed provider frame embedded in an unapproved top-level site, a wrong frame origin on an approved site, a missing frame binding, a frame-bound secret aimed at the top-level document, sandboxed and `srcdoc` frames, an unbound intermediate frame, a removed iframe, and frame navigation during export and during an approval wait. Each one refuses without exposing the payload.

## Changes needed in @turnkey/browser-secrets

`0.0.1-alpha.0` already has `sbm:frame-origin`, the ancestry rules and the opaque-origin rule above. The broker needed no API change to fill iframes. These changes would close the gaps that remain:

1. **A frame origin for each payload part.** `sbm:frame-origin` applies to every target of a secret. A card form with the cardholder name in the merchant page and the number in a provider frame cannot be one JSON secret today. Add an optional `sbm:field-frame-origins` key: a JSON map from payload key to a frame origin, or to `""` for the top-level document. A key that is not in the map uses `sbm:frame-origin`. `parseBinding` validates it, `SecretBinding` gains `fieldFrameOrigins`, and `checkTarget` uses the key's frame origin. Without either key, a part fills the top-level document only, as now.
2. **Ancestry in the destination.** `AuthorizedTarget` records the target frame and document only. Add the ancestry (`frames: { frameId, documentId }[]`) and compare it in `isSameDestination`. An ancestor that gets a new document today destroys the target frame too, so this is defense in depth, not a known bypass.
3. **Document the origin cross-check.** `ObservedDocument.origin` says to read the origin where page script cannot change it. Add that a host should compare the browser's frame-tree origin with the isolated-world `window.origin`, and report `"null"` when they differ. Add a conformance case for a sandboxed frame whose URL origin looks valid.
4. **Conformance cases the broker now runs live.** Add cases for one JSON secret filled across several provider frames, and for a provider frame on an unapproved top-level site with a frame-bound secret (`top_level_origin_mismatch` when the ancestry has more than one frame). `test/observe.test.ts` runs the fixture's iframe cases against `test/fixtures/frames.ts`, which serves the URLs the fixture names.

## Not covered yet

- A live Stripe Elements or Adyen checkout. The fixtures model their frame layout, but no test runs against a real provider page.
- OOPIF attach on Browserbase. It uses the same CDP calls as local Chrome, but no test runs on a remote browser.
- The browser extension path (an `all_frames` content script with the same frame binding). It must apply the same rules.
- `list_network_requests` is not implemented, so it does not yet need to withhold frame request bodies.
