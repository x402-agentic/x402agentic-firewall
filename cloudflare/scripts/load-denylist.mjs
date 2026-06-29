/**
 * load-denylist.mjs — build the OFAC sanctioned-address denylist and upload to KV.
 *
 * Source: 0xB10C/ofac-sanctioned-digital-currency-addresses (community mirror of
 * the U.S. Treasury OFAC SDN digital-currency address list). EVM address files
 * are unioned, lowercased, and de-duplicated into a single JSON array.
 *
 * Usage:
 *   node scripts/load-denylist.mjs            # builds scripts/denied.json
 *   then upload to your worker's KV:
 *   npx wrangler kv key put denied --path scripts/denied.json --binding RISK_KV --remote
 *
 * Re-run periodically (e.g. weekly) to stay current; OFAC updates over time.
 */

const BASE = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
// EVM-relevant lists (same 0x address format across all EVM chains incl. Base).
const FILES = ["ETH", "USDC", "USDT", "DAI"].map((c) => `sanctioned_addresses_${c}.txt`);

const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

async function fetchList(file) {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) {
    console.warn(`! skip ${file}: HTTP ${res.status}`);
    return [];
  }
  const text = await res.text();
  return text.split("\n").map((l) => l.trim()).filter(isEvm);
}

const all = new Set();
for (const f of FILES) {
  const addrs = await fetchList(f);
  addrs.forEach((a) => all.add(a.toLowerCase()));
  console.log(`  ${f}: ${addrs.length}`);
}

const list = [...all].sort();
const fs = await import("node:fs");
const url = await import("node:url");
const path = await import("node:path");
const here = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.join(here, "denied.json");
fs.writeFileSync(out, JSON.stringify(list));

console.log(`\n✓ ${list.length} unique sanctioned EVM addresses written to ${out}`);
console.log("\nUpload to KV with:");
console.log("  npx wrangler kv key put denied --path scripts/denied.json --binding RISK_KV --remote");
