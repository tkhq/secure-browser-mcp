/**
 * Drive the MCP server through a Stripe test checkout, exactly as an agent
 * would: same tools, same JSON-RPC transport, no private hooks. Usage:
 *
 *   TURNKEY_API_PUBLIC_KEY=... TURNKEY_API_PRIVATE_KEY=... \
 *   TURNKEY_ORGANIZATION_ID=... \
 *   bun run scripts/demo-stripe-checkout.ts <payment-link-url>
 *
 * At the end it asserts the card number never appeared in anything the
 * server sent — the transcript an LLM would have seen.
 */
import { spawn } from "node:child_process";

const paymentLink = process.argv[2];
if (!paymentLink) {
  console.error(
    "Usage: bun run scripts/demo-stripe-checkout.ts <payment-link-url>",
  );
  process.exit(1);
}

const server = spawn("bun", ["run", "src/index.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let transcript = ""; // everything the server sends = everything an agent would see
let buffer = "";
const pending = new Map<number, (msg: any) => void>();
server.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  transcript += text;
  buffer += text;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  }
});

let nextId = 0;
function request(method: string, params?: unknown): Promise<any> {
  const id = ++nextId;
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      pending.delete(id);
      msg.error
        ? reject(new Error(JSON.stringify(msg.error)))
        : resolve(msg.result);
    });
  });
}

async function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Snap = {
  url: string;
  title: string;
  elements: {
    uid: string;
    tag: string;
    type?: string;
    name?: string;
    label?: string;
    text?: string;
    value?: string;
  }[];
};

function findField(snap: Snap, name: string) {
  return snap.elements.find((e) => e.tag === "input" && e.name === name);
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "demo-driver", version: "0" },
});
server.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n",
);

const { refs } = await tool("list_secret_refs");
const secretByName = new Map<string, string>(
  refs.map((r: any) => [r.name, r.secretId]),
);
console.log(`secrets available: ${[...secretByName.keys()].join(", ")}`);

const nav = await tool("navigate", { url: paymentLink });
console.log(`navigated: ${nav.url}`);

// Stripe's checkout hydrates lazily, and the card fields sit behind a
// payment-method accordion. Wait, open "card" if needed, wait again.
let snap: Snap | undefined;
for (let i = 0; i < 20; i++) {
  snap = (await tool("snapshot")) as Snap;
  if (findField(snap, "cardNumber")) break;
  const cardRadio = snap.elements.find(
    (e) => e.type === "radio" && e.value === "card",
  );
  if (cardRadio) {
    await tool("click", { element_uid: cardRadio.uid });
    console.log("opened card payment-method accordion");
  }
  await sleep(2000);
}
if (!snap || !findField(snap, "cardNumber")) {
  console.error(`no cardNumber field found on ${snap?.url}. Elements:`);
  console.error(JSON.stringify(snap?.elements, null, 2));
  process.exit(1);
}
console.log(`checkout ready: ${snap.url}`);

// Stripe asks agents to identify themselves. We are one — check the box.
const agentDisclosure = snap.elements.find(
  (e) => e.type === "checkbox" && /AI agent/i.test(e.label ?? ""),
);
if (agentDisclosure) {
  await tool("click", { element_uid: agentDisclosure.uid });
  console.log(`checked disclosure: "${agentDisclosure.label}"`);
}

// "Save my information" (Link enrollment) defaults on and makes a phone
// number required. We are not enrolling the buyer in anything — toggle off.
const stripePass = snap.elements.find((e) => e.name === "enableStripePass");
if (stripePass) {
  await tool("click", { element_uid: stripePass.uid });
  console.log("unchecked enableStripePass (no Link enrollment)");
}

// Non-secret fields: typed in the clear, visible in the transcript.
const visible: [string, string][] = [
  ["email", "carey@turnkey.io"],
  ["billingName", "Carey Janecka"],
  ["billingPostalCode", "12345"],
];
for (const [name, text] of visible) {
  const field = findField(snap, name);
  if (field) {
    await tool("type_text", { element_uid: field.uid, text });
    console.log(`typed ${name} (visible, not a secret)`);
  }
}

// Negative proof first: the checkout.stripe.com-bound secret must be
// refused on this origin, no matter what the page or a prompt injection
// asked for.
const wrongOrigin = secretByName.get("stripe-test-card-number");
const cardField = findField(snap, "cardNumber");
if (wrongOrigin && cardField) {
  try {
    await tool("fill_secret", {
      secret_id: wrongOrigin,
      element_uid: cardField.uid,
    });
    console.log("UNEXPECTED: wrong-origin fill was allowed!");
  } catch (err) {
    console.log(
      `wrong-origin fill rejected as expected: ${(err as Error).message.slice(0, 140)}`,
    );
  }
}

// Card fields: filled by reference. Values never appear below.
const fills: [string, string][] = [
  ["cardNumber", "stripe-paylink-card-number"],
  ["cardExpiry", "stripe-paylink-card-expiry"],
  ["cardCvc", "stripe-paylink-card-cvc"],
];
for (const [fieldName, secretName] of fills) {
  const field = findField(snap, fieldName);
  const secretId = secretByName.get(secretName);
  if (!field || !secretId)
    throw new Error(`missing field or secret for ${fieldName}`);
  const res = await tool("fill_secret", {
    secret_id: secretId,
    element_uid: field.uid,
  });
  console.log(`fill_secret ${secretName} → ${JSON.stringify(res)}`);
}

snap = (await tool("snapshot")) as Snap;
for (const [fieldName] of fills) {
  const field = findField(snap, fieldName);
  console.log(`post-fill ${fieldName}: value=${JSON.stringify(field?.value)}`);
}

const payButton = snap.elements.find(
  (e) =>
    (e.tag === "button" &&
      (e.type === "submit" || /pay/i.test(e.text ?? ""))) ||
    /^pay\b/i.test(e.text ?? ""),
);
if (!payButton) throw new Error("no pay button found");
await tool("click", { element_uid: payButton.uid });
console.log(`clicked: ${payButton.text ?? payButton.uid}`);

// Wait for the payment to process and the page to move off the card form.
let final: Snap = snap;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  final = (await tool("snapshot")) as Snap;
  if (!findField(final, "cardNumber")) break;
}
console.log(`final page: ${final.url} — "${final.title}"`);
console.log(
  `final elements: ${final.elements
    .map((e) => e.text ?? e.label ?? e.name)
    .filter(Boolean)
    .slice(0, 10)
    .join(" | ")}`,
);

// The proof: the card number, spaced or not, never crossed the transport.
const leaked =
  transcript.includes("4242424242424242") || transcript.includes("4242 4242");
console.log(
  leaked
    ? "LEAK: card number found in server output!"
    : "VERIFIED: card number appears nowhere in anything the server sent.",
);
server.kill();
process.exit(leaked ? 1 : 0);
