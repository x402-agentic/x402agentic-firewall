# x402Agentic Payment Pre-Flight Check 🛡️

**The pre-pay risk gate for the agent economy.** An agent calls this *before* it
pays any x402 endpoint and gets back an `allow` / `warn` / `block` verdict with a
0–100 risk score and itemized reasons — so it never settles a payment to a
denied or flagged payee, overpays a gouging endpoint, pays in the wrong asset,
or breaks the user's spend policy.

Built by [x402Agentic.ai](https://x402agentic.ai) for publishing on
[Bankr](https://bankr.bot).

## Why this exists

The x402 marketplaces are saturated with *data* services (LLM gateways, crypto
feeds, scrapers, market data). Almost nobody sells the **safety layer every agent
needs**: x402 settles the payment but tells the agent nothing about whether
paying was safe. This precheck is the missing pre-trade check — small, cheap
(~$0.001/call), and called by every agent on every payment, which is exactly why
the addressable demand is large.

## How it works

```
Agent about to pay an x402 endpoint
        │  forwards the 402 challenge (or payTo + amount)
        ▼
  Payment Pre-Flight Check  ──►  { verdict: "block", riskScore: 60, flags: ["price_outlier"], ... }
        │
        ▼
 block → abort & tell user   warn → pay only if within tolerance   allow → pay
```

Ten checks run on every request: envelope integrity, address validity,
denylist/deny screen, community flagged reports, price-vs-category band,
absolute ceiling, asset sanity, network sanity, facilitator reputation, and the
caller's own spend policy. See `skill/references/checks.md` for scoring.

## Repo layout

```
x402agentic-precheck/
├── bankr.x402.json              # Bankr x402 Cloud config (price + schema)
├── engine/
│   └── core.ts                  # the precheck engine (single source of truth)
├── x402/precheck/
│   └── index.ts                 # Bankr handler — SELF-CONTAINED single file
│                                #   (engine inlined; Bankr bundles one file, no imports)
├── cloudflare/
│   ├── src/worker.ts            # self-host Worker (imports engine/core.ts)
│   ├── wrangler.toml
│   └── package.json
├── skill/
│   ├── SKILL.md                 # Bankr/skills-compatible discovery file
│   └── references/checks.md
└── test/local-test.ts           # engine scenario tests
```

> **Why the Bankr handler is one self-contained file:** `bankr x402 deploy`
> ships your handler source for server-side bundling. To keep that bulletproof,
> `x402/precheck/index.ts` has the engine inlined and imports nothing local.
> `engine/core.ts` stays the canonical copy for the Cloudflare worker and tests —
> if you change engine logic, re-inline it into the handler (the README's
> "Sync the engine" note covers the one-liner).

## Path A — Publish on Bankr x402 Cloud (recommended)

Bankr hosts the endpoint, wraps the x402 payment layer, and lists it for agent
discovery. No blockchain code on your side.

```bash
npm install -g @bankr/cli
bankr login                       # creates/links your wallet + API key
bankr x402 init                   # if starting fresh (this repo already has the layout)
# copy x402/precheck/ and bankr.x402.json into your bankr workspace, then:
bankr x402 deploy
```

You'll get a live URL like `https://x402.bankr.bot/<your-wallet>/precheck`.
Earnings (in USDC on Base) go straight to your wallet. First 1,000 requests/month
are free; a 5% platform fee applies after that.

You can also do the whole thing through the Bankr agent in chat:
> "deploy an x402 endpoint called precheck from this handler, charge $0.001 per request"

### Make agents discover & use it

Publish `skill/SKILL.md` (point its endpoint at your deployed URL) so any
skills-compatible agent can install it:
> install the x402-prepay-check skill from https://github.com/<you>/x402agentic-precheck/tree/main/skill

To list in the public Bankr catalog, open a PR to
[`BankrBot/skills`](https://github.com/BankrBot/skills) (see their contributing
guide). Once it settles its first payment, it's also indexed in the Coinbase
x402 Bazaar automatically.

## Path B — Self-host on Cloudflare

Use this when you want the endpoint on your own domain. The Worker implements the
x402 paywall itself (402 challenge → facilitator verify → run precheck → settle).

```bash
cd cloudflare
npm install
# edit wrangler.toml: set PAY_TO to your wallet, PRICE_USDC, FACILITATOR_URL
# (optional) wrangler kv namespace create RISK_KV  -> paste id into wrangler.toml
npx wrangler deploy
```

Endpoint: `https://x402agentic-precheck.<your-subdomain>.workers.dev/precheck`
(`/health` is a free discovery route.)

> **Facilitator note:** the `/verify` and `/settle` calls follow the x402
> facilitator REST convention. Confirm the exact shapes for your facilitator
> (Coinbase CDP for mainnet USDC on Base, or `x402.org` for no-signup testnet).
> For production, you can swap the hand-rolled flow for the official `x402-hono`
> middleware — the precheck engine (`core.ts`) stays unchanged.

## Calling it (agent side)

```bash
# Forward the raw 402 body you just received
curl -X POST "$RISK_URL" -H "Content-Type: application/json" \
  -d '{ "challenge": <402-response-body>, "category": "llm" }'

# Or pass fields directly, with an optional spend policy
curl -X POST "$RISK_URL" -H "Content-Type: application/json" \
  -d '{ "payTo":"0x..","amount":0.01,"asset":"USDC","network":"base",
        "category":"market-data","policy":{"maxPerCallUsd":0.05} }'
```

The precheck endpoint is itself x402-paid; the caller's wallet pays the ~$0.001
fee automatically through the normal 402 flow.

## Operator overrides (runtime)

Without redeploying, you can update lists and bands via the KV store:

| Key | Type | Meaning |
| --- | --- | --- |
| `precheck:denied` | string[] | extra deny addresses (load denylist source here) |
| `precheck:reported` | string[] | community abuse addresses (warn→block) |
| `precheck:trusted` | string[] | trusted payees (risk reduced) |
| `precheck:priceBands` | object | override category price bands |
| `precheck:ceilingUsd` | number | absolute per-call ceiling |

On Bankr these map to `ctx.appKV`; on Cloudflare to the `RISK_KV` namespace.

## Test

```bash
npx tsx test/local-test.ts      # 10 scenarios, no network/payment needed
```

### Sync the engine

The Bankr handler (`x402/precheck/index.ts`) has the engine inlined. After
editing `engine/core.ts`, regenerate the single-file handler:

```bash
node -e 'const fs=require("fs");
  const core=fs.readFileSync("engine/core.ts","utf8");
  let a=fs.readFileSync("x402/precheck/_adapter.ts","utf8");        // adapter-only source (optional)
  fs.writeFileSync("x402/precheck/index.ts",
    "// AUTO-GENERATED: engine inlined for single-file Bankr deploy\n\n"+core+"\n\n"+a);'
```

(If you keep the adapter inside `index.ts` instead of a separate `_adapter.ts`,
just paste the new engine above the handler — the handler only needs `evaluate`,
`PrecheckInput`, and `Overrides` in scope.)

## Roadmap

- `report` endpoint for community flagged submissions (with anti-abuse staking).
- Live price-median ingestion from Bazaar / x402scan listings.
- On-chain payee history (first-seen, settlement count) via RPC.
- Per-agent budget memory across calls.

## Security & accuracy notes

The bundled denied/flagged lists are **seed placeholders** — load authoritative
sources before relying on the verdict for compliance. Price bands are heuristic
seeds; refine from live market data. The precheck is a risk *aid*, not a
guarantee.
