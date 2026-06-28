/**
 * Local logic test — runs the precheck engine through representative scenarios.
 * No payment / network required.   Run:  npx tsx test/local-test.ts
 */
import { evaluate } from "../engine/core";

let pass = 0;
let fail = 0;

function expect(name: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> verdict=${got}${ok ? "" : ` (expected ${want})`}`);
  ok ? pass++ : fail++;
}

// 1. Normal, fair-priced LLM call -> allow
expect(
  "fair LLM call",
  evaluate({ payTo: "0x" + "a".repeat(40), amount: 0.002, asset: "USDC", network: "base", category: "llm" }).verdict,
  "allow",
);

// 2. Price gouging (market-data asking $5) -> block
expect(
  "price gouge market-data",
  evaluate({ payTo: "0x" + "b".repeat(40), amount: 5, asset: "USDC", network: "base", category: "market-data" }).verdict,
  "block",
);

// 3. Slightly pricey (above p90, under max) -> warn
expect(
  "above p90 scrape",
  evaluate({ payTo: "0x" + "c".repeat(40), amount: 0.05, asset: "USDC", network: "base", category: "scrape" }).verdict,
  "warn",
);

// 4. Denied/null payee -> block
expect(
  "null payee",
  evaluate({ payTo: "0x0000000000000000000000000000000000000000", amount: 0.001, asset: "USDC", network: "base" }).verdict,
  "block",
);

// 5. Malformed challenge (no amount) -> block
expect("missing amount", evaluate({ payTo: "0x" + "d".repeat(40), network: "base" }).verdict, "block");

// 6. Bad address -> block
expect("bad address", evaluate({ payTo: "0xnothex", amount: 0.001, network: "base" }).verdict, "block");

// 7. Non-stablecoin asset -> warn (asset_check)
expect(
  "unknown asset",
  evaluate({ payTo: "0x" + "e".repeat(40), amount: 0.001, asset: "0x" + "f".repeat(40), network: "base", category: "llm" })
    .verdict,
  "warn",
);

// 8. Policy maxPerCall exceeded -> block
expect(
  "policy max per call",
  evaluate({
    payTo: "0x" + "1".repeat(40),
    amount: 0.02,
    asset: "USDC",
    network: "base",
    category: "llm",
    policy: { maxPerCallUsd: 0.005 },
  }).verdict,
  "block",
);

// 9. Policy allowlist miss -> block
expect(
  "policy allowlist miss",
  evaluate({
    payTo: "0x" + "2".repeat(40),
    amount: 0.001,
    asset: "USDC",
    network: "base",
    policy: { allowlist: ["0x" + "9".repeat(40)] },
  }).verdict,
  "block",
);

// 10. Raw 402 envelope parsing (atomic USDC) -> allow
expect(
  "parse raw 402 envelope",
  evaluate({
    challenge: {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000", // 0.001 USDC (6 decimals)
          payTo: "0x" + "3".repeat(40),
          asset: "USDC",
        },
      ],
    },
    category: "rpc",
  }).verdict,
  "allow",
);

// Detail sample
const sample = evaluate({
  payTo: "0x" + "b".repeat(40),
  amount: 5,
  asset: "USDC",
  network: "base",
  category: "market-data",
});
console.log("\nSample blocked verdict:");
console.log(JSON.stringify({ verdict: sample.verdict, riskScore: sample.riskScore, flags: sample.flags, summary: sample.summary }, null, 2));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
