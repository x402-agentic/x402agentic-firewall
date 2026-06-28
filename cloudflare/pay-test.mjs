import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const pk = process.env.AGENT_PK;
if (!pk) { console.error("Set AGENT_PK to a TEST wallet private key (0x...)"); process.exit(1); }

const account = privateKeyToAccount(pk);
console.log("Paying from:", account.address);

const fetchWithPay = wrapFetchWithPayment(fetch, account);

const res = await fetchWithPay(
  "https://x402agentic-firewall.x402lite.workers.dev/precheck?payTo=0xabc&amount=0.01&network=base&category=llm"
);
console.log("HTTP", res.status);
console.log(JSON.stringify(await res.json(), null, 2));
