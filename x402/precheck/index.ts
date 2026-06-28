// x402 pre-pay precheck — compact handler. Same input/output contract as the full engine.
const DENY = new Set<string>([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
const BANDS: Record<string, [number, number, number]> = {
  "llm-compact": [0.0002, 0.01, 0.1], llm: [0.002, 0.05, 0.2],
  "market-data": [0.001, 0.02, 0.1], "crypto-data": [0.001, 0.02, 0.1],
  rpc: [0.0005, 0.01, 0.05], scrape: [0.005, 0.03, 0.15], "web-search": [0.005, 0.03, 0.15],
  "social-data": [0.005, 0.03, 0.15], "data-enrichment": [0.01, 0.05, 0.25],
  "image-gen": [0.02, 0.1, 0.5], "video-gen": [0.1, 0.5, 3], prediction: [0.01, 0.1, 1],
  identity: [0.5, 2, 5], generic: [0.005, 0.05, 0.5],
};
const CEIL = 25;
const lc = (s: any) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const isEvm = (a: string) => /^0x[0-9a-f]{40}$/.test(lc(a));

function evaluate(i: any) {
  const checks: any[] = []; const flags: string[] = []; let score = 0; let critical = false;
  const add = (id: string, status: string, detail: string, w = 0, crit = false) => {
    checks.push({ id, status, detail });
    if (status !== "pass") { score += w; flags.push(id); }
    if (crit && status === "fail") critical = true;
  };
  let pr: any = null; const ch = i.challenge;
  if (ch && typeof ch === "object") { if (Array.isArray(ch.accepts) && ch.accepts.length) pr = ch.accepts[0]; else if (ch.payTo || ch.maxAmountRequired) pr = ch; }
  const payTo = lc(i.payTo ?? pr?.payTo ?? "");
  const network = lc(i.network ?? pr?.network ?? "");
  const asset = lc(i.asset ?? pr?.asset ?? "");
  const cat = lc(i.category) || "generic";
  let amt: number | null = null;
  if (i.amount != null && `${i.amount}` !== "") amt = Number(i.amount);
  else { const a = i.maxAmountRequired ?? pr?.maxAmountRequired; if (a != null) amt = Number(a) / 1e6; }
  if (!Number.isFinite(amt as number)) amt = null;

  const missing: string[] = [];
  if (!payTo) missing.push("payTo"); if (amt === null) missing.push("amount"); if (!network) missing.push("network");
  if (missing.length) add("envelope", "fail", `incomplete challenge: missing ${missing.join(", ")}`, 100, true);
  else add("envelope", "pass", "challenge complete");

  if (payTo) {
    if (network === "solana") { const ok = payTo.length >= 32 && payTo.length <= 44; add("address", ok ? "pass" : "fail", ok ? "ok" : "bad solana address", 100, true); }
    else if (!isEvm(payTo)) add("address", "fail", "invalid EVM address", 100, true);
    else add("address", "pass", "valid address");
  }
  if (payTo) { if (DENY.has(payTo)) add("denylist", "fail", "payee on denylist", 100, true); else add("denylist", "pass", "payee clear"); }

  const band = BANDS[cat] ?? BANDS.generic;
  if (amt !== null) {
    if (amt > band[2]) add("price", "fail", `$${amt} far above ${cat} band (max $${band[2]})`, 60);
    else if (amt > band[1]) add("price", "warn", `$${amt} above p90 ($${band[1]})`, 20);
    else add("price", "pass", "price within range");
  }
  if (amt !== null && amt > CEIL) add("ceiling", "warn", `$${amt} over $${CEIL} ceiling`, 35);

  const p = i.policy;
  if (p) {
    if (payTo && (p.blocklist ?? []).map(lc).includes(payTo)) add("policy_block", "fail", "payee on caller blocklist", 100, true);
    if (p.allowlist && p.allowlist.length) { const ok = p.allowlist.map(lc).includes(payTo); add("policy_allow", ok ? "pass" : "fail", ok ? "on allowlist" : "not on caller allowlist", 100, true); }
    if (p.maxPerCallUsd != null && amt !== null) { const ok = amt <= p.maxPerCallUsd; add("policy_max", ok ? "pass" : "fail", ok ? "within limit" : `over $${p.maxPerCallUsd} limit`, 100, true); }
  }
  score = Math.min(100, score);
  if (p?.maxRiskScore != null && score > p.maxRiskScore) critical = true;
  const verdict = (critical || score >= 60) ? "block" : (score >= 20 ? "warn" : "allow");
  const rec = verdict === "block" ? "do_not_pay" : verdict === "warn" ? "proceed_with_caution" : "proceed";
  return { verdict, recommendation: rec, riskScore: score, payTo: payTo || null, amountUsd: amt, asset: asset || null, network: network || null, category: cat, priceBand: amt !== null ? { p50: band[0], p90: band[1], max: band[2] } : null, checks, flags: [...new Set(flags)], ts: new Date().toISOString() };
}

export default async function handler(req: Request) {
  let input: any = {};
  try {
    if (req.method === "POST") { const t = await req.text(); input = t ? JSON.parse(t) : {}; }
    else {
      const q = new URL(req.url).searchParams; const g = (k: string) => q.get(k) ?? undefined;
      input = { payTo: g("payTo"), amount: g("amount"), maxAmountRequired: g("maxAmountRequired"), asset: g("asset"), network: g("network"), category: g("category") };
    }
  } catch { return { verdict: "block", recommendation: "do_not_pay", error: "invalid_body" }; }
  return evaluate(input);
}

export { evaluate };
