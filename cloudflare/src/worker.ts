import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { createFacilitatorConfig } from "@coinbase/x402";
import { evaluate, type PrecheckInput } from "../../engine/core";

type Bindings = {
  PAY_TO: string;
  PRICE_USDC?: string;
  NETWORK?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) =>
  c.json({
    service: "x402agentic-precheck",
    version: "1.0.0",
    paid_path: "/precheck",
    price_usdc: c.env.PRICE_USDC ?? "0.001",
    network: c.env.NETWORK ?? "base",
  }),
);

app.use("/precheck", async (c, next) => {
  const price = `$${c.env.PRICE_USDC ?? "0.001"}`;
  const network = (c.env.NETWORK ?? "base") as "base" | "base-sepolia";

  let facilitator: ReturnType<typeof createFacilitatorConfig> | undefined;
  if (network === "base") {
    if (!c.env.CDP_API_KEY_ID || !c.env.CDP_API_KEY_SECRET) {
      return c.json(
        { error: "missing_cdp_keys", detail: "Set CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets to settle on Base mainnet." },
        500,
      );
    }
    facilitator = createFacilitatorConfig(c.env.CDP_API_KEY_ID, c.env.CDP_API_KEY_SECRET);
  }

  const mw = paymentMiddleware(
    c.env.PAY_TO as `0x${string}`,
    {
      "/precheck": {
        price,
        network,
        config: {
          description: "x402Agentic pre-pay precheck — risk verdict before paying an x402 endpoint",
          mimeType: "application/json",
        },
      },
    },
    facilitator as any,
  );
  return mw(c, next);
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
