/**
 * x402Agentic Payment Pre-Flight Check — Cloudflare Worker (x402 v2 + brand metadata).
 *
 * v2 paywall (settles via Coinbase CDP on Base mainnet). The risk engine
 * (engine/core.ts) runs only after payment verifies.
 *
 * Brand/provider metadata (logo, links, token) is exposed for directories at:
 *   GET /                       summary + provider
 *   GET /.well-known/x402       x402 discovery doc + provider
 *   GET /.well-known/agent.json agent card (alias: /.well-known/agent-card.json)
 *   GET /openapi.json           OpenAPI 3.1 with x-logo / x-provider / x-payment-info
 *   GET /llms.txt               plain-text summary for LLM crawlers
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
  PRICE_USDC?: string;
  NETWORK_CAIP2?: string; // default Base mainnet eip155:8453
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  RISK_KV?: KVNamespace; // denylist + operator overrides
};

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DESC = "x402Agentic pre-pay precheck — allow/warn/block risk verdict before paying any x402 endpoint";

// Bazaar discovery extension: example input + output + schema for nicer listings.
const CATEGORY_ENUM = [
  "llm-compact", "llm", "market-data", "crypto-data", "rpc", "scrape",
  "web-search", "social-data", "data-enrichment", "image-gen", "video-gen",
  "prediction", "identity", "generic",
];
const DISCOVERY = declareDiscoveryExtension({
  input: {
    payTo: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: 0.01,
    network: "base",
    category: "llm",
  },
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
  output: {
    example: {
      verdict: "allow",
      recommendation: "proceed",
      riskScore: 0,
      payTo: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amountUsd: 0.01,
      category: "llm",
      priceBand: { p50: 0.002, p90: 0.05, max: 0.2 },
      flags: [],
    },
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["allow", "warn", "block"] },
        recommendation: { type: "string", enum: ["proceed", "proceed_with_caution", "do_not_pay"] },
        riskScore: { type: "number" },
        payTo: { type: "string" },
        amountUsd: { type: "number" },
        category: { type: "string" },
        priceBand: { type: "object" },
        checks: { type: "array", items: { type: "object" } },
        flags: { type: "array", items: { type: "string" } },
      },
      required: ["verdict", "recommendation", "riskScore"],
    },
  },
});

// ---- Brand / provider metadata (edit here to update everywhere) ------------
const PROVIDER = {
  name: "x402 Agentic",
  tagline: "The Payment Layer for the Autonomous Web",
  description:
    "x402 Agentic is open infrastructure for autonomous AI agent payments. Built on x402 Protocol V2 + ERC-8004. Any agent, enterprise, or individual transacts instantly with stablecoins over HTTP.",
  email: "hello@x402agentic.ai",
  website: "https://x402agentic.ai",
  logo: "https://x402agentic.ai/logo.png",
  twitter: "@x402agentic",
  x: "https://x.com/x402agentic",
  medium: "https://x402agentic.medium.com",
  virtuals: "https://app.virtuals.io/virtuals/39918",
  token: {
    address: "0xCAb815D8A171091A8647F126E0FB7C009946b162",
    network: "eip155:8453",
    chain: "base",
  },
};

const app = new Hono<{ Bindings: Bindings }>();

const priceUsd = (c: any) => c.env.PRICE_USDC ?? "0.001";
const net = (c: any) => c.env.NETWORK_CAIP2 ?? "eip155:8453";
const host = (c: any) => new URL(c.req.url).host;

// ---- Free routes: health, discovery, metadata -----------------------------

app.get("/", (c) =>
  c.json({
    service: "x402agentic-precheck",
    version: "2.0.0",
    paid_paths: ["/precheck"],
    price_usdc: priceUsd(c),
    network: net(c),
    discovery: ["/.well-known/x402", "/.well-known/agent.json", "/openapi.json", "/llms.txt"],
    provider: PROVIDER,
  }),
);

// Favicon → redirect to the brand logo so directories can show an icon.
app.get("/favicon.ico", (c) => c.redirect(PROVIDER.logo, 302));

app.get("/.well-known/x402", (c) =>
  c.json({
    x402Version: 2,
    provider: PROVIDER,
    resources: [
      {
        resource: `https://${host(c)}/precheck`,
        methods: ["GET", "POST"],
        accepts: [{ scheme: "exact", price: `$${priceUsd(c)}`, network: net(c), asset: USDC_BASE, payTo: c.env.PAY_TO }],
        description: DESC,
        mimeType: "application/json",
      },
    ],
  }),
);

// Agent card (served at both common paths)
const agentCard = (c: any) => ({
  name: PROVIDER.name,
  description: DESC,
  url: PROVIDER.website,
  logo: PROVIDER.logo,
  iconUrl: PROVIDER.logo,
  provider: { organization: PROVIDER.name, url: PROVIDER.website },
  links: {
    website: PROVIDER.website,
    x: PROVIDER.x,
    twitter: PROVIDER.twitter,
    medium: PROVIDER.medium,
    virtuals: PROVIDER.virtuals,
  },
  token: PROVIDER.token,
  endpoints: [
    {
      path: "/precheck",
      methods: ["GET", "POST"],
      description: DESC,
      pricing: { amount: priceUsd(c), currency: "USDC", network: net(c), asset: USDC_BASE },
    },
  ],
});
app.get("/.well-known/agent.json", (c) => c.json(agentCard(c)));
app.get("/.well-known/agent-card.json", (c) => c.json(agentCard(c)));

app.get("/openapi.json", (c) => {
  const pay = { price: `$${priceUsd(c)}`, network: net(c), asset: USDC_BASE, payTo: c.env.PAY_TO };

  const categoryEnum = [
    "llm-compact", "llm", "market-data", "crypto-data", "rpc", "scrape",
    "web-search", "social-data", "data-enrichment", "image-gen", "video-gen",
    "prediction", "identity", "generic",
  ];

  // What an agent sends to /precheck (used for both GET params and POST body).
  const bodySchema = {
    type: "object",
    properties: {
      challenge: { type: "object", description: "Raw 402 response body (with an accepts[] array). If sent, payTo/amount/asset/network are parsed from it." },
      payTo: { type: "string", description: "Destination address from the 402 envelope", example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      amount: { type: "number", description: "Price in USD the endpoint is asking for", example: 0.01 },
      maxAmountRequired: { type: "string", description: "Price in atomic units (alternative to amount)" },
      asset: { type: "string", description: "Settlement asset symbol or contract", example: "USDC" },
      network: { type: "string", description: "Settlement network", example: "base" },
      category: { type: "string", enum: categoryEnum, description: "Service category for price-band comparison", example: "llm" },
      resource: { type: "string", description: "Endpoint URL being paid for" },
      facilitator: { type: "string", description: "Facilitator URL/host from the 402 envelope" },
      policy: {
        type: "object",
        description: "Optional caller spend policy",
        properties: {
          maxPerCallUsd: { type: "number" },
          allowlist: { type: "array", items: { type: "string" } },
          blocklist: { type: "array", items: { type: "string" } },
          allowedNetworks: { type: "array", items: { type: "string" } },
          allowedAssets: { type: "array", items: { type: "string" } },
          maxRiskScore: { type: "number" },
        },
      },
    },
  };

  const getParams = [
    { name: "payTo", in: "query", required: true, schema: { type: "string" }, example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", description: "Destination address" },
    { name: "amount", in: "query", required: true, schema: { type: "number" }, example: 0.01, description: "Price in USD" },
    { name: "network", in: "query", required: true, schema: { type: "string" }, example: "base", description: "Settlement network" },
    { name: "category", in: "query", required: false, schema: { type: "string", enum: categoryEnum }, example: "llm", description: "Service category" },
    { name: "asset", in: "query", required: false, schema: { type: "string" }, example: "USDC" },
    { name: "maxAmountRequired", in: "query", required: false, schema: { type: "string" } },
    { name: "resource", in: "query", required: false, schema: { type: "string" } },
    { name: "facilitator", in: "query", required: false, schema: { type: "string" } },
  ];

  const responses = {
    "200": { description: "Risk verdict", content: { "application/json": { schema: { type: "object" } } } },
    "402": { description: "Payment required (x402 challenge)" },
  };

  return c.json({
    openapi: "3.1.0",
    info: {
      title: PROVIDER.name,
      version: "2.0.0",
      summary: PROVIDER.tagline,
      description: `${PROVIDER.description}\n\nThis endpoint: ${DESC}.`,
      contact: { name: PROVIDER.name, url: PROVIDER.website, email: PROVIDER.email },
      "x-logo": { url: PROVIDER.logo },
      "x-provider": PROVIDER,
    },
    externalDocs: { description: "Medium", url: PROVIDER.medium },
    servers: [{ url: `https://${host(c)}` }],
    paths: {
      "/precheck": {
        get: {
          summary: "Pre-pay risk verdict (query params)",
          description: DESC,
          operationId: "precheck_get",
          "x-payment-info": pay,
          parameters: getParams,
          responses,
        },
        post: {
          summary: "Pre-pay risk verdict (JSON body)",
          description: DESC,
          operationId: "precheck_post",
          "x-payment-info": pay,
          requestBody: {
            required: true,
            content: { "application/json": { schema: bodySchema } },
          },
          responses,
        },
      },
    },
  });
});

app.get("/llms.txt", (c) =>
  c.text(
    [
      `# ${PROVIDER.name}`,
      "",
      DESC,
      "",
      `Website: ${PROVIDER.website}`,
      `X: ${PROVIDER.twitter} (${PROVIDER.x})`,
      `Medium: ${PROVIDER.medium}`,
      `Virtuals: ${PROVIDER.virtuals}`,
      `Token (Base): ${PROVIDER.token.address}`,
      "",
      `Paid endpoint: https://${host(c)}/precheck  (${`$${priceUsd(c)}`} USDC on Base, x402 v2)`,
      `Discovery: /.well-known/x402, /.well-known/agent.json, /openapi.json`,
    ].join("\n"),
  ),
);

// ---- Paid route -----------------------------------------------------------

let cachedMw: any; // built once per isolate (facilitator handshake is expensive)

app.use("/precheck", async (c, next) => {
  if (!c.env.CDP_API_KEY_ID || !c.env.CDP_API_KEY_SECRET) {
    return c.json({ error: "missing_cdp_keys", detail: "Set CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets." }, 500);
  }
  if (!cachedMw) {
    const facilitatorClient = new HTTPFacilitatorClient(
      createFacilitatorConfig(c.env.CDP_API_KEY_ID, c.env.CDP_API_KEY_SECRET),
    );
    const server = new x402ResourceServer(facilitatorClient);
    server.register("eip155:*", new ExactEvmScheme());
    server.registerExtension(bazaarResourceServerExtension);
    const accepts = [{ scheme: "exact", price: `$${priceUsd(c)}`, network: net(c), payTo: c.env.PAY_TO as `0x${string}` }];
    const routes = {
      "GET /precheck": { accepts, description: DESC, mimeType: "application/json", extensions: { ...DISCOVERY } },
      "POST /precheck": { accepts, description: DESC, mimeType: "application/json", extensions: { ...DISCOVERY } },
    };
    cachedMw = paymentMiddleware(routes as any, server as any);
  }
  return cachedMw(c, next);
});

const run = (input: PrecheckInput, overrides: Overrides) => evaluate(input, overrides);

// Load denylist + operator overrides from KV, cached ~5 min per isolate.
let cachedOverrides: { data: Overrides; exp: number } | null = null;
async function loadOverrides(env: Bindings): Promise<Overrides> {
  const now = Date.now();
  if (cachedOverrides && cachedOverrides.exp > now) return cachedOverrides.data;
  const o: Overrides = {};
  const kv = env.RISK_KV;
  if (kv) {
    try {
      const [denied, reported, trusted, bands, ceiling] = await Promise.all([
        kv.get("denied", "json"),
        kv.get("reported", "json"),
        kv.get("trusted", "json"),
        kv.get("priceBands", "json"),
        kv.get("ceilingUsd", "json"),
      ]);
      if (Array.isArray(denied)) o.denied = denied as string[];
      if (Array.isArray(reported)) o.reportedFlags = reported as string[];
      if (Array.isArray(trusted)) o.trustedPayees = trusted as string[];
      if (bands && typeof bands === "object") o.priceBands = bands as any;
      if (typeof ceiling === "number") o.absoluteCeilingUsd = ceiling;
    } catch {
      /* KV is best-effort; seed data still applies */
    }
  }
  cachedOverrides = { data: o, exp: now + 300_000 };
  return o;
}

app.get("/precheck", async (c) => {
  const overrides = await loadOverrides(c.env);
  const q = new URL(c.req.url).searchParams;
  const g = (k: string) => q.get(k) ?? undefined;
  return c.json(
    run(
      {
        payTo: g("payTo"),
        amount: g("amount"),
        maxAmountRequired: g("maxAmountRequired"),
        asset: g("asset"),
        network: g("network"),
        resource: g("resource") ?? g("endpoint"),
        facilitator: g("facilitator"),
        category: g("category"),
      },
      overrides,
    ),
  );
});

app.post("/precheck", async (c) => {
  const overrides = await loadOverrides(c.env);
  const body = (await c.req.json().catch(() => ({}))) as PrecheckInput;
  return c.json(run(body, overrides));
});

// ---- Scheduled denylist refresh (Cron Trigger) ----------------------------
// Fetches the OFAC sanctioned-address lists and writes them to KV. Runs on the
// schedule in wrangler.toml [triggers]. Never overwrites a good list with empty.
const OFAC_BASE = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";
const OFAC_FILES = ["ETH", "USDC", "USDT", "DAI"].map((s) => `sanctioned_addresses_${s}.txt`);
const isEvmAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

async function refreshDenylist(env: Bindings): Promise<number> {
  if (!env.RISK_KV) return 0;
  const all = new Set<string>();
  for (const f of OFAC_FILES) {
    try {
      const res = await fetch(`${OFAC_BASE}/${f}`);
      if (!res.ok) continue;
      const text = await res.text();
      for (const line of text.split("\n")) {
        const a = line.trim();
        if (isEvmAddr(a)) all.add(a.toLowerCase());
      }
    } catch {
      /* skip this file on error, keep going */
    }
  }
  if (all.size === 0) return 0; // safety: don't replace a good list with an empty one
  const list = [...all].sort();
  await env.RISK_KV.put("denied", JSON.stringify(list));
  cachedOverrides = null; // bust this isolate's cache
  console.log(`denylist refreshed: ${list.length} sanctioned addresses`);
  return list.length;
}

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(refreshDenylist(env));
  },
};