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
import { createFacilitatorConfig } from "@coinbase/x402";
import { evaluate, type PrecheckInput } from "../../engine/core";

type Bindings = {
  PAY_TO: string;
  PRICE_USDC?: string;
  NETWORK_CAIP2?: string; // default Base mainnet eip155:8453
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
};

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DESC = "x402Agentic pre-pay precheck — allow/warn/block risk verdict before paying any x402 endpoint";

// ---- Brand / provider metadata (edit here to update everywhere) ------------
const PROVIDER = {
  name: "x402Agentic",
  description: DESC,
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
  const op = (method: string) => ({
    summary: "Pre-pay risk verdict for an x402 payment",
    description: DESC,
    operationId: `precheck_${method}`,
    "x-payment-info": pay,
    responses: {
      "200": { description: "Risk verdict", content: { "application/json": { schema: { type: "object" } } } },
      "402": { description: "Payment required (x402 challenge)" },
    },
  });
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "x402Agentic Precheck",
      version: "2.0.0",
      description: DESC,
      contact: { name: PROVIDER.name, url: PROVIDER.website },
      "x-logo": { url: PROVIDER.logo },
      "x-provider": PROVIDER,
    },
    externalDocs: { description: "Medium", url: PROVIDER.medium },
    servers: [{ url: `https://${host(c)}` }],
    paths: { "/precheck": { get: op("get"), post: op("post") } },
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
    const accepts = [{ scheme: "exact", price: `$${priceUsd(c)}`, network: net(c), payTo: c.env.PAY_TO as `0x${string}` }];
    const routes = {
      "GET /precheck": { accepts, description: DESC, mimeType: "application/json" },
      "POST /precheck": { accepts, description: DESC, mimeType: "application/json" },
    };
    cachedMw = paymentMiddleware(routes as any, server as any);
  }
  return cachedMw(c, next);
});

const run = (input: PrecheckInput) => evaluate(input);

app.get("/precheck", (c) => {
  const q = new URL(c.req.url).searchParams;
  const g = (k: string) => q.get(k) ?? undefined;
  return c.json(
    run({
      payTo: g("payTo"),
      amount: g("amount"),
      maxAmountRequired: g("maxAmountRequired"),
      asset: g("asset"),
      network: g("network"),
      resource: g("resource") ?? g("endpoint"),
      facilitator: g("facilitator"),
      category: g("category"),
    }),
  );
});

app.post("/precheck", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PrecheckInput;
  return c.json(run(body));
});

export default app;