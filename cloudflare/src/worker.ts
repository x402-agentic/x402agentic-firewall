/**
 * x402 Agentic — multi-endpoint payment-trust suite (Cloudflare Worker, x402 v2).
 *
 * Paid endpoints (each its own price, all settle USDC on Base via CDP):
 *   /precheck     full pre-pay risk verdict (engine/core.ts)
 *   /screen       focused OFAC sanctions screen on one address
 *   /spend-guard  per-agent budget enforcement (stateful, KV)
 *   /token-check  is this the canonical USDC/asset, or a lookalike?
 *
 * Free routes: /, /favicon.ico, /.well-known/x402, /.well-known/agent.json,
 *   /openapi.json, /llms.txt  — all generated from the ENDPOINTS registry.
 */

import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { evaluate, type PrecheckInput, type Overrides } from "../../engine/core";

type Bindings = {
  PAY_TO: string;
  PRICE_USDC?: string;            // legacy: applies to /precheck if PRICE_PRECHECK unset
  PRICE_PRECHECK?: string;
  PRICE_SCREEN?: string;
  PRICE_SPEND_GUARD?: string;
  PRICE_TOKEN_CHECK?: string;
  PRICE_VERIFY_PAYMENT?: string;
  PRICE_REPUTATION?: string;
  BASE_RPC_URL?: string;          // default https://mainnet.base.org
  NETWORK_CAIP2?: string;         // default Base mainnet eip155:8453
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  RISK_KV?: KVNamespace;          // denylist, overrides, and spend-guard state
};

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Canonical token registry for /token-check (Base mainnet).
// NOTE: verify/extend against an authoritative source before relying in production.
const TOKEN_REGISTRY: Record<string, { symbol: string; name: string; decimals: number }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", name: "USD Coin (native, Base)", decimals: 6 },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", name: "USD Base Coin (bridged)", decimals: 6 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", name: "Dai Stablecoin (Base)", decimals: 18 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", name: "Wrapped Ether (Base)", decimals: 18 },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", name: "Coinbase Wrapped BTC (Base)", decimals: 8 },
};

const isEvm = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

// ERC-20 Transfer(address,address,uint256) event topic.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Public Base RPC endpoints, tried in order (override/prepend via BASE_RPC_URL,
// comma-separated). Public nodes rate-limit, so we fall through on failure.
const DEFAULT_BASE_RPCS = [
  "https://base.publicnode.com",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];

// Try each RPC endpoint until one returns a result; throw an aggregated error.
async function rpcCall(urls: string[], method: string, params: any[]): Promise<any> {
  let lastErr = "no_rpc_endpoints";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) { lastErr = `http_${res.status}`; continue; }
      const j: any = await res.json();
      if (j.error) { lastErr = `rpc:${j.error.message ?? "error"}`; continue; }
      return j.result; // success (may be null for a not-yet-mined tx)
    } catch (e: any) {
      lastErr = e?.message ? String(e.message) : "fetch_failed";
      continue;
    }
  }
  throw new Error(lastErr);
}

// ---- Provider / brand -----------------------------------------------------
const PROVIDER = {
  name: "x402 Agentic",
  tagline: "The Payment Layer for the Autonomous Web",
  description:
    "x402 Agentic is a payment-trust suite for autonomous AI agents on Base USDC. Keyless, pay-per-call endpoints for pre-pay risk verdicts, OFAC sanctions screening, per-agent budget enforcement, canonical-asset verification, on-chain settlement proof, and payee reputation. No API key, no account — pay per request with x402.",
  email: "hello@x402agentic.ai",
  website: "https://x402agentic.ai",
  logo: "https://x402agentic.ai/logo.png",
  twitter: "@x402agentic",
  x: "https://x.com/x402agentic",
  medium: "https://x402agentic.medium.com",
  virtuals: "https://app.virtuals.io/virtuals/39918",
  token: { address: "0xCAb815D8A171091A8647F126E0FB7C009946b162", network: "eip155:8453", chain: "base" },
};

// ===========================================================================
// Endpoint registry — add an entry here and routes/metadata/pricing follow.
// ===========================================================================
type Ctx = { env: Bindings; overrides: Overrides; method: "GET" | "POST" };
interface Endpoint {
  slug: string;
  priceDefault: string;
  desc: string;
  needsOverrides?: boolean;
  tags: string[];
  inputExample: Record<string, any>;
  inputSchema: { type: "object"; properties: Record<string, any>; required: string[] };
  outputExample: Record<string, any>;
  run: (params: any, ctx: Ctx) => any;
}

const CATEGORY_ENUM = [
  "llm-compact", "llm", "market-data", "crypto-data", "rpc", "scrape", "web-search",
  "social-data", "data-enrichment", "image-gen", "video-gen", "prediction", "identity", "generic",
];

const ENDPOINTS: Endpoint[] = [
  {
    slug: "precheck",
    priceDefault: "0.001",
    tags: ["x402","payments","risk","compliance","agents"],
    desc: "Pre-pay risk verdict (allow / warn / block) before an agent settles any x402 payment — checks payee validity, OFAC sanctions, price gouging, asset/network, and spend policy. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    needsOverrides: true,
    inputExample: { payTo: USDC_BASE, amount: 0.01, network: "base", category: "llm" },
    inputSchema: {
      type: "object",
      properties: {
        payTo: { type: "string", description: "Destination address from the 402 envelope" },
        amount: { type: "number", description: "Price in USD the endpoint is asking for" },
        network: { type: "string", description: "Settlement network" },
        category: { type: "string", enum: CATEGORY_ENUM, description: "Service category for price-band comparison" },
      },
      required: ["payTo", "amount", "network"],
    },
    outputExample: { verdict: "allow", recommendation: "proceed", riskScore: 0, flags: [] },
    run: (params, { overrides }) => evaluate(params as PrecheckInput, overrides),
  },
  {
    slug: "screen",
    priceDefault: "0.002",
    tags: ["x402","sanctions","ofac","compliance","screening"],
    desc: "OFAC sanctions screen on a payee address — allow/block against the live sanctioned-address list, auto-refreshed weekly. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    needsOverrides: true,
    inputExample: { address: USDC_BASE },
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "EVM address to screen" } },
      required: ["address"],
    },
    outputExample: { address: USDC_BASE.toLowerCase(), valid: true, sanctioned: false, list: "OFAC", verdict: "allow" },
    run: (params, { overrides }) => {
      const address = String(params.address ?? params.payTo ?? "").toLowerCase();
      const valid = isEvm(address);
      const denied = overrides.denied ?? [];
      const sanctioned = valid && denied.includes(address);
      const reasons: string[] = [];
      let verdict: "allow" | "block" = "allow";
      if (!valid) { verdict = "block"; reasons.push("invalid_address"); }
      else if (sanctioned) { verdict = "block"; reasons.push("ofac_sanctioned"); }
      return {
        address, valid, sanctioned, verdict, reasons,
        list: "OFAC sanctioned digital-currency addresses", listSize: denied.length,
      };
    },
  },
  {
    slug: "spend-guard",
    priceDefault: "0.001",
    tags: ["x402","budget","spend-control","policy","agents"],
    desc: "Per-agent budget enforcement — track an agent's cumulative spend against a cap and block overspend. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    inputExample: { agentId: "agent-123", amountUsd: 0.25, budgetUsd: 10 },
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Stable identifier for the spending agent" },
        amountUsd: { type: "number", description: "Amount about to be spent (USD)" },
        budgetUsd: { type: "number", description: "Optional: set/raise this agent's budget (USD)" },
      },
      required: ["agentId"],
    },
    outputExample: { agentId: "agent-123", amountUsd: 0.25, budgetUsd: 10, spentUsd: 0.25, remainingUsd: 9.75, allowed: true, recorded: true, verdict: "allow" },
    run: async (params, { env, method }) => {
      const agentId = String(params.agentId ?? params.agent ?? "").trim();
      if (!agentId) return { error: "missing_agentId" };
      if (!env.RISK_KV) return { error: "kv_unavailable" };
      const key = `spend:${agentId}`;
      const state = ((await env.RISK_KV.get(key, "json")) as any) ?? { spent: 0, budget: null, since: new Date().toISOString() };
      const amount = Number(params.amountUsd ?? params.amount ?? 0) || 0;
      const setBudget = params.budgetUsd ?? params.budget;
      if (setBudget != null && !Number.isNaN(Number(setBudget))) state.budget = Number(setBudget);
      const budget: number | null = state.budget;
      const remainingBefore = budget != null ? Math.max(0, budget - state.spent) : null;
      const allowed = budget == null || amount <= remainingBefore!;
      let recorded = false;
      if (method === "POST" && amount > 0 && allowed) {
        state.spent = Number((state.spent + amount).toFixed(6));
        await env.RISK_KV.put(key, JSON.stringify(state));
        recorded = true;
      }
      const remainingUsd = budget != null ? Math.max(0, budget - state.spent) : null;
      return { agentId, amountUsd: amount, budgetUsd: budget, spentUsd: state.spent, remainingUsd, allowed, recorded, verdict: allowed ? "allow" : "block" };
    },
  },
  {
    slug: "token-check",
    priceDefault: "0.002",
    tags: ["x402","tokens","usdc","verification","safety"],
    desc: "Verify a token contract is the canonical asset (real USDC, WETH, DAI…) and not a lookalike or spoof. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    inputExample: { address: USDC_BASE },
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Token contract address to verify" } },
      required: ["address"],
    },
    outputExample: { address: USDC_BASE.toLowerCase(), valid: true, canonical: true, symbol: "USDC", decimals: 6, verdict: "allow" },
    run: (params) => {
      const address = String(params.address ?? params.token ?? params.asset ?? "").toLowerCase();
      if (!isEvm(address)) return { address, valid: false, canonical: false, verdict: "block", warning: "invalid_address" };
      const hit = TOKEN_REGISTRY[address];
      if (hit) return { address, valid: true, canonical: true, symbol: hit.symbol, name: hit.name, decimals: hit.decimals, network: "eip155:8453", verdict: "allow" };
      return { address, valid: true, canonical: false, verdict: "warn", warning: "not a known canonical asset — possible lookalike/spoof; verify before accepting payment in this token" };
    },
  },
  {
    slug: "verify-payment",
    priceDefault: "0.005",
    tags: ["x402","settlement","receipts","onchain","payments"],
    desc: "Confirm an x402 payment actually settled on-chain — correct recipient, asset, and amount — from the transaction hash. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    inputExample: { txHash: "0x" + "ab".repeat(32), payTo: "0xc23C4aFA42cbaBbc03D04Bc87ecB769Fc82F1f43", amountUsd: 0.1 },
    inputSchema: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "Transaction hash to verify (0x + 64 hex)" },
        payTo: { type: "string", description: "Expected recipient address" },
        amountUsd: { type: "number", description: "Expected amount in USD (optional)" },
        asset: { type: "string", description: "Token contract (defaults to USDC on Base)" },
      },
      required: ["txHash"],
    },
    outputExample: { txHash: "0x…", settled: true, verified: true, to: "0xc23c…", amountUsd: 0.1, verdict: "allow" },
    run: async (params, { env }) => {
      const txHash = String(params.txHash ?? params.tx ?? params.hash ?? "").trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { txHash, verified: false, verdict: "block", reason: "invalid_tx_hash" };
      const expectedTo = String(params.payTo ?? params.to ?? "").toLowerCase();
      const expectedAmount = params.amountUsd != null ? Number(params.amountUsd) : (params.amount != null ? Number(params.amount) : null);
      const assetAddr = String(params.asset ?? USDC_BASE).toLowerCase();
      const rpcs = (env.BASE_RPC_URL ? env.BASE_RPC_URL.split(",").map((s) => s.trim()).filter(Boolean) : []).concat(DEFAULT_BASE_RPCS);
      let receipt: any;
      try { receipt = await rpcCall(rpcs, "eth_getTransactionReceipt", [txHash]); }
      catch (e: any) { return { txHash, verified: false, verdict: "warn", reason: "rpc_error", detail: String(e?.message ?? e).slice(0, 200) }; }
      if (!receipt) return { txHash, verified: false, verdict: "warn", reason: "not_found_or_pending" };
      if (receipt.status !== "0x1") return { txHash, settled: false, verified: false, verdict: "block", reason: "tx_failed" };
      const transfers = (receipt.logs ?? []).filter(
        (l: any) => l.address?.toLowerCase() === assetAddr && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC,
      );
      let chosen: { to: string; data: string } | null = null;
      for (const l of transfers) {
        const to = "0x" + String(l.topics[2] ?? "").slice(-40).toLowerCase();
        if (!expectedTo || to === expectedTo) { chosen = { to, data: l.data }; break; }
      }
      if (!chosen) {
        if (transfers.length === 0) return { txHash, settled: true, verified: false, verdict: "warn", reason: "no_matching_token_transfer", asset: assetAddr };
        return { txHash, settled: true, verified: false, verdict: "block", reason: "recipient_mismatch", asset: assetAddr };
      }
      const decimals = assetAddr === USDC_BASE.toLowerCase() ? 6 : 18; // USDC=6; others best-effort
      const atomic = BigInt(chosen.data);
      const amountUsd = Number(atomic) / 10 ** decimals;
      const matchesPayTo = !expectedTo || chosen.to === expectedTo;
      const matchesAmount = expectedAmount == null || Math.abs(amountUsd - expectedAmount) < 1e-6;
      return {
        txHash, settled: true, verified: matchesPayTo && matchesAmount,
        verdict: matchesPayTo && matchesAmount ? "allow" : "warn",
        to: chosen.to, asset: assetAddr, amountUsd, amountAtomic: atomic.toString(),
        blockNumber: parseInt(receipt.blockNumber, 16),
        expected: { payTo: expectedTo || null, amountUsd: expectedAmount },
        matches: { payTo: matchesPayTo, amount: matchesAmount },
      };
    },
  },
  {
    slug: "reputation",
    priceDefault: "0.002",
    tags: ["x402","reputation","trust","screening","agents"],
    desc: "Reputation score (0–100) for a payee from sanctions data plus community reports and vouches. Part of x402 Agentic, the payment-trust suite for AI agents on Base USDC.",
    needsOverrides: true,
    inputExample: { address: USDC_BASE },
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address to look up (GET) or contribute a signal for (POST)" },
        action: { type: "string", enum: ["report", "vouch"], description: "POST only: report or vouch for the address" },
        reason: { type: "string", description: "POST only: short note (<=140 chars)" },
      },
      required: ["address"],
    },
    outputExample: { address: USDC_BASE.toLowerCase(), score: 50, label: "unknown", reports: 0, vouches: 0, verdict: "neutral" },
    run: async (params, { env, method, overrides }) => {
      const address = String(params.address ?? params.payTo ?? "").toLowerCase();
      if (!isEvm(address)) return { address, verdict: "block", reason: "invalid_address" };
      const denied = overrides.denied ?? [];
      const trusted = overrides.trustedPayees ?? [];
      const key = `rep:${address}`;
      const rec: any = (env.RISK_KV ? ((await env.RISK_KV.get(key, "json")) as any) : null) ?? { reports: 0, vouches: 0, firstSeen: null, lastSeen: null, reasons: [] };
      if (method === "POST" && env.RISK_KV) {
        const action = String(params.action ?? "report");
        const reason = String(params.reason ?? "").slice(0, 140);
        const now = new Date().toISOString();
        if (!rec.firstSeen) rec.firstSeen = now;
        rec.lastSeen = now;
        if (action === "vouch") rec.vouches = (rec.vouches || 0) + 1;
        else {
          rec.reports = (rec.reports || 0) + 1;
          if (reason) rec.reasons = [...(rec.reasons || []).slice(-9), reason];
          const reported = ((await env.RISK_KV.get("reported", "json")) as string[]) ?? [];
          if (!reported.includes(address)) { reported.push(address); await env.RISK_KV.put("reported", JSON.stringify(reported)); }
        }
        await env.RISK_KV.put(key, JSON.stringify(rec));
      }
      const sanctioned = denied.includes(address);
      const isTrusted = trusted.includes(address);
      const reports = rec.reports || 0;
      const vouches = rec.vouches || 0;
      let score: number, label: string, verdict: string;
      if (sanctioned) { score = 0; label = "sanctioned"; verdict = "block"; }
      else if (reports > 0) { score = Math.max(5, 40 - reports * 5); label = "reported"; verdict = "warn"; }
      else if (isTrusted) { score = 95; label = "trusted"; verdict = "allow"; }
      else if (vouches > 0) { score = Math.min(85, 55 + vouches * 5); label = "vouched"; verdict = "allow"; }
      else { score = 50; label = "unknown"; verdict = "neutral"; }
      return { address, score, label, verdict, sanctioned, trusted: isTrusted, reports, vouches, reasons: rec.reasons ?? [], firstSeen: rec.firstSeen, lastSeen: rec.lastSeen };
    },
  },
];

// ---- Helpers --------------------------------------------------------------
const app = new Hono<{ Bindings: Bindings }>();
const net = (c: any) => c.env.NETWORK_CAIP2 ?? "eip155:8453";
const host = (c: any) => new URL(c.req.url).host;
const priceFor = (c: any, ep: Endpoint) => {
  const k = "PRICE_" + ep.slug.toUpperCase().replace(/-/g, "_");
  return (c.env as any)[k] ?? (ep.slug === "precheck" ? c.env.PRICE_USDC : undefined) ?? ep.priceDefault;
};

// ---- KV overrides (denylist etc.), cached ~5 min per isolate ---------------
let cachedOverrides: { data: Overrides; exp: number } | null = null;
async function loadOverrides(env: Bindings): Promise<Overrides> {
  const now = Date.now();
  if (cachedOverrides && cachedOverrides.exp > now) return cachedOverrides.data;
  const o: Overrides = {};
  const kv = env.RISK_KV;
  if (kv) {
    try {
      const [denied, reported, trusted, bands, ceiling] = await Promise.all([
        kv.get("denied", "json"), kv.get("reported", "json"), kv.get("trusted", "json"),
        kv.get("priceBands", "json"), kv.get("ceilingUsd", "json"),
      ]);
      if (Array.isArray(denied)) o.denied = denied as string[];
      if (Array.isArray(reported)) o.reportedFlags = reported as string[];
      if (Array.isArray(trusted)) o.trustedPayees = trusted as string[];
      if (bands && typeof bands === "object") o.priceBands = bands as any;
      if (typeof ceiling === "number") o.absoluteCeilingUsd = ceiling;
    } catch { /* best-effort */ }
  }
  cachedOverrides = { data: o, exp: now + 300_000 };
  return o;
}

// ---- Free routes: health, metadata, discovery -----------------------------
// Root: a human-friendly landing page for browsers, machine JSON for agents.
function landingPage(c: any): string {
  const cards = ENDPOINTS.map((ep) => {
    const short = ep.desc.split(" Part of x402 Agentic")[0];
    return `<a class="card" href="/openapi.json">
      <div class="row"><span class="path">/${ep.slug}</span><span class="price">$${priceFor(c, ep)}</span></div>
      <p>${short}</p></a>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${PROVIDER.name} — ${PROVIDER.tagline}</title>
<meta name="description" content="${PROVIDER.description}">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0b0d;color:#e7e9ea;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:48px 20px 80px}
header{display:flex;align-items:center;gap:16px;margin-bottom:8px}
header img{width:48px;height:48px;border-radius:10px}
h1{font-size:26px;margin:0}
.tag{color:#9aa0a6;margin:4px 0 28px}
.lead{color:#c7cbd1;margin:0 0 32px;max-width:640px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin-bottom:36px}
.card{display:block;background:#15171b;border:1px solid #23262c;border-radius:12px;padding:16px;text-decoration:none;color:inherit;transition:border-color .15s}
.card:hover{border-color:#3a7afe}
.row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;color:#fff}
.price{font-size:13px;color:#3a7afe;font-weight:600}
.card p{margin:0;font-size:14px;color:#9aa0a6}
.how{background:#15171b;border:1px solid #23262c;border-radius:12px;padding:18px;margin-bottom:32px}
.how h2{font-size:15px;margin:0 0 10px;color:#fff}
pre{background:#0a0b0d;border:1px solid #23262c;border-radius:8px;padding:12px;overflow:auto;font-size:13px;margin:0}
.links a{color:#3a7afe;text-decoration:none;margin-right:18px;font-size:14px}
footer{margin-top:40px;color:#6b7177;font-size:13px}
</style></head><body><div class="wrap">
<header><img src="${PROVIDER.logo}" alt="logo" onerror="this.style.display='none'"><div><h1>${PROVIDER.name}</h1></div></header>
<div class="tag">${PROVIDER.tagline}</div>
<p class="lead">${PROVIDER.description}</p>
<div class="grid">${cards}</div>
<div class="how"><h2>How agents pay</h2>
<pre>npx awal x402 pay "https://${host(c)}/precheck" \\
  --query '{"payTo":"0x…","amount":0.01,"network":"base","category":"llm"}'</pre>
<p style="font-size:13px;color:#9aa0a6;margin:10px 0 0">Keyless, pay-per-call in USDC on Base (x402 v2). No account, no API key.</p></div>
<div class="links">
<a href="${PROVIDER.website}">Website</a>
<a href="${PROVIDER.x}">X</a>
<a href="${PROVIDER.medium}">Medium</a>
<a href="/openapi.json">OpenAPI</a>
<a href="/.well-known/agent.json">Agent card</a></div>
<footer>x402 v2 · settles USDC on Base · ${ENDPOINTS.length} endpoints</footer>
</div></body></html>`;
}

app.get("/", (c) => {
  if ((c.req.header("accept") ?? "").includes("text/html")) return c.html(landingPage(c));
  return c.json({
  service: "x402-agentic", version: "2.0.0",
  paid_paths: ENDPOINTS.map((e) => `/${e.slug}`),
  network: net(c), provider: PROVIDER,
  discovery: ["/.well-known/x402", "/.well-known/agent.json", "/openapi.json", "/llms.txt"],
});
});

app.get("/favicon.ico", (c) => c.redirect(PROVIDER.logo, 302));

app.get("/.well-known/x402", (c) => c.json({
  x402Version: 2, provider: PROVIDER,
  resources: ENDPOINTS.map((ep) => ({
    resource: `https://${host(c)}/${ep.slug}`, methods: ["GET", "POST"],
    accepts: [{ scheme: "exact", price: `$${priceFor(c, ep)}`, network: net(c), asset: USDC_BASE, payTo: c.env.PAY_TO }],
    description: ep.desc, mimeType: "application/json",
  })),
}));

const agentCard = (c: any) => ({
  name: PROVIDER.name, description: PROVIDER.description, url: PROVIDER.website,
  logo: PROVIDER.logo, iconUrl: PROVIDER.logo,
  provider: { organization: PROVIDER.name, url: PROVIDER.website },
  links: { website: PROVIDER.website, x: PROVIDER.x, twitter: PROVIDER.twitter, medium: PROVIDER.medium, virtuals: PROVIDER.virtuals },
  token: PROVIDER.token,
  endpoints: ENDPOINTS.map((ep) => ({
    path: `/${ep.slug}`, methods: ["GET", "POST"], description: ep.desc,
    pricing: { amount: priceFor(c, ep), currency: "USDC", network: net(c), asset: USDC_BASE },
  })),
});
app.get("/.well-known/agent.json", (c) => c.json(agentCard(c)));
app.get("/.well-known/agent-card.json", (c) => c.json(agentCard(c)));

app.get("/openapi.json", (c) => {
  const paths: Record<string, any> = {};
  for (const ep of ENDPOINTS) {
    const pay = { price: `$${priceFor(c, ep)}`, network: net(c), asset: USDC_BASE, payTo: c.env.PAY_TO };
    const responses = {
      "200": { description: "Result", content: { "application/json": { schema: { type: "object" } } } },
      "402": { description: "Payment required (x402 challenge)" },
    };
    const params = Object.entries(ep.inputSchema.properties).map(([name, s]) => ({
      name, in: "query", required: ep.inputSchema.required.includes(name), schema: s,
    }));
    paths[`/${ep.slug}`] = {
      get: { summary: ep.desc, operationId: `${ep.slug}_get`, "x-payment-info": pay, parameters: params, responses },
      post: { summary: ep.desc, operationId: `${ep.slug}_post`, "x-payment-info": pay,
        requestBody: { required: true, content: { "application/json": { schema: ep.inputSchema } } }, responses },
    };
  }
  return c.json({
    openapi: "3.1.0",
    info: {
      title: PROVIDER.name, version: "2.0.0", summary: PROVIDER.tagline,
      description: PROVIDER.description,
      contact: { name: PROVIDER.name, url: PROVIDER.website, email: PROVIDER.email },
      "x-logo": { url: PROVIDER.logo }, "x-provider": PROVIDER,
    },
    externalDocs: { description: "Medium", url: PROVIDER.medium },
    servers: [{ url: `https://${host(c)}` }],
    paths,
  });
});

app.get("/llms.txt", (c) => c.text([
  `# ${PROVIDER.name}`, "", PROVIDER.description, "",
  `Website: ${PROVIDER.website}`, `X: ${PROVIDER.twitter}`, `Medium: ${PROVIDER.medium}`, "",
  "Paid endpoints (USDC on Base, x402 v2):",
  ...ENDPOINTS.map((e) => `  https://${host(c)}/${e.slug}  ($${priceFor(c, e)})  ${e.desc}`),
].join("\n")));

// ---- Paywall (one middleware covering every endpoint, cached per isolate) --
let cachedMw: any;
function buildMw(c: any) {
  const fc = new HTTPFacilitatorClient(createFacilitatorConfig(c.env.CDP_API_KEY_ID, c.env.CDP_API_KEY_SECRET));
  const server = new x402ResourceServer(fc);
  server.register("eip155:*", new ExactEvmScheme());
  server.registerExtension(bazaarResourceServerExtension);
  const routes: Record<string, any> = {};
  for (const ep of ENDPOINTS) {
    const accepts = [{ scheme: "exact", price: `$${priceFor(c, ep)}`, network: net(c), payTo: c.env.PAY_TO as `0x${string}` }];
    const disc = declareDiscoveryExtension({
      input: ep.inputExample, inputSchema: ep.inputSchema,
      output: { example: ep.outputExample, schema: { type: "object" } },
    });
    routes[`GET /${ep.slug}`] = { accepts, description: ep.desc, mimeType: "application/json", extensions: { ...disc } };
    routes[`POST /${ep.slug}`] = { accepts, description: ep.desc, mimeType: "application/json", extensions: { ...disc } };
  }
  return paymentMiddleware(routes as any, server as any);
}

const payGuard = async (c: any, next: any) => {
  if (!c.env.CDP_API_KEY_ID || !c.env.CDP_API_KEY_SECRET) return c.json({ error: "missing_cdp_keys" }, 500);
  if (!cachedMw) cachedMw = buildMw(c);
  return cachedMw(c, next);
};

// Register paywall on each paid path, then the handlers.
for (const ep of ENDPOINTS) app.use(`/${ep.slug}`, payGuard);

async function dispatch(ep: Endpoint, c: any, method: "GET" | "POST") {
  const params = method === "GET"
    ? Object.fromEntries(new URL(c.req.url).searchParams)
    : await c.req.json().catch(() => ({}));
  const overrides = ep.needsOverrides ? await loadOverrides(c.env) : {};
  return ep.run(params, { env: c.env, overrides, method });
}
for (const ep of ENDPOINTS) {
  app.get(`/${ep.slug}`, async (c) => c.json(await dispatch(ep, c, "GET")));
  app.post(`/${ep.slug}`, async (c) => c.json(await dispatch(ep, c, "POST")));
}

// ---- Scheduled denylist refresh (Cron Trigger) ----------------------------
const OFAC_BASE = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
const OFAC_FILES = ["ETH", "USDC", "USDT", "DAI"].map((s) => `sanctioned_addresses_${s}.txt`);
async function refreshDenylist(env: Bindings): Promise<number> {
  if (!env.RISK_KV) return 0;
  const all = new Set<string>();
  for (const f of OFAC_FILES) {
    try {
      const res = await fetch(`${OFAC_BASE}/${f}`);
      if (!res.ok) continue;
      for (const line of (await res.text()).split("\n")) {
        const a = line.trim();
        if (/^0x[0-9a-fA-F]{40}$/.test(a)) all.add(a.toLowerCase());
      }
    } catch { /* skip */ }
  }
  if (all.size === 0) return 0;
  await env.RISK_KV.put("denied", JSON.stringify([...all].sort()));
  cachedOverrides = null;
  console.log(`denylist refreshed: ${all.size} sanctioned addresses`);
  return all.size;
}

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_e: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(refreshDenylist(env));
  },
};