# Bankr catalog submission — x402-precheck

## One-line catalog description (for the README table row)

**x402agentic · precheck** — Pre-pay risk firewall for x402 agents. Before paying
any x402 endpoint, get an allow/warn/block verdict: validates the payee, screens
denylist/flagged addresses, flags price gouging, checks asset/network, and
enforces your spend policy. ~$0.001 USDC/call on Base.

## Install string (works from any public repo, once pushed)

```
install the x402-precheck skill from https://github.com/<your-org>/x402agentic-firewall/tree/main/skill
```

After the catalog PR is merged, it also resolves from the official catalog:

```
install the precheck skill from https://github.com/BankrBot/skills/tree/main/x402agentic/precheck
```

## PR description (paste into the BankrBot/skills pull request)

Adds a new provider `x402agentic` with one skill, `precheck`.

**What it does:** a pre-pay risk gate for autonomous agents. An agent calls it
right before settling any x402 payment and receives an allow/warn/block verdict
with a 0–100 risk score and itemized reasons. Checks: envelope integrity, payee
address validity, denylist screen, community-flagged reports, price-vs-category
gouging, absolute ceiling, asset/network sanity, facilitator reputation, and the
caller's own spend policy.

**Hosting:** self-hosted on Cloudflare Workers, x402-paid (~$0.001 USDC), settled
via the Coinbase CDP facilitator on Base mainnet. Endpoint is
`discoverable: true` and indexed by the x402 Bazaar.

**Live endpoint:** https://api.x402agentic.ai/precheck
**Homepage:** https://x402agentic.ai

No Bankr API key or wallet write access required to use — the consuming agent
pays per call from its own wallet through the standard x402 flow.
