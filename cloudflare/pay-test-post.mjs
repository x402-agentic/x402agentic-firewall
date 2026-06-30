// v2 buyer test with a JSON POST body — for endpoints like /spend-guard.
// Usage: AGENT_PK=0x<test_key> node pay-test-post.mjs <url> '<json-body>'
//   e.g. node pay-test-post.mjs https://api.x402agentic.ai/spend-guard '{"agentId":"test-1","amountUsd":0.1,"budgetUsd":5}'
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const pk = process.env.AGENT_PK;
if (!pk) { console.error("Set AGENT_PK to a TEST wallet private key (0x...)"); process.exit(1); }

const url = process.argv[2] ?? "https://api.x402agentic.ai/spend-guard";
const body = process.argv[3] ?? '{"agentId":"test-1","amountUsd":0.1,"budgetUsd":5}';

const account = privateKeyToAccount(pk);
console.log("Paying from:", account.address);
console.log("POST", url, body);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
console.log("HTTP", res.status);
console.log(JSON.stringify(await res.json(), null, 2));
