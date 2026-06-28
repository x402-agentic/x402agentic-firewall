/**
 * x402Agentic Payment Pre-Flight Check — core evaluation engine.
 *
 * Runtime-agnostic. No Node / Cloudflare / Bun specifics, no external deps.
 * Imported by:
 *   - x402/precheck/index.ts        (Bankr x402 Cloud handler)
 *   - cloudflare/src/worker.ts      (self-hosted Cloudflare Worker)
 *
 * Purpose: an agent calls this BEFORE it pays any x402 endpoint. It passes the
 * 402 challenge (or just payTo + amount), and gets back an allow / warn / block
 * verdict with a risk score and itemised reasons — a "pre-pay precheck" for the
 * agent economy.
 *
 * This file is deterministic and side-effect free. Dynamic data (operator
 * blocklists, live price medians) is injected via the optional `overrides`
 * argument so the host can back it with a KV store.
 */

// ---------------------------------------------------------------------------
// Reference data (seed). Operators should augment these at runtime.
// ---------------------------------------------------------------------------

/**
 * Denied / denied addresses (lowercased).
 *
 * SEED ONLY. The entries below are structural placeholders + well-known
 * burn/null addresses. In production, load the real denylist source crypto address
 * list and your own confirmed abuse set into `overrides.denied`.
 * Do not treat the seed list as an authoritative denylist source.
 */
export const DENYLIST_SEED: string[] = [
  "0x0000000000000000000000000000000000000000", // null address
  "0x000000000000000000000000000000000000dead", // common burn address
];

/** Known x402 facilitator hosts. Unknown facilitator => informational caution. */
export const KNOWN_FACILITATORS_SEED: string[] = [
  "x402.org",
  "facilitator.x402.org",
  "api.cdp.coinbase.com",
  "x402.coinbase.com",
  "facilitator.coinbase.com",
];

/** Canonical stablecoin contracts by network (lowercased). Used for asset sanity. */
export const STABLECOINS_SEED: Record<string, string[]> = {
  base: [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC (Base)
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (Base)
  ],
  "base-sepolia": ["0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
  ethereum: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"], // USDC
  polygon: ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"], // USDC
  solana: ["epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"], // USDC mint
};

export const SUPPORTED_NETWORKS_SEED = [
  "base",
  "base-sepolia",
  "ethereum",
  "polygon",
  "solana",
  "unichain",
  "world-chain",
];

/**
 * Heuristic USD price bands per service category (per request).
 * p50 = typical, p90 = high-but-plausible, max = anything above is an outlier.
 * Seeded from observed x402 marketplace listings; refine with live medians.
 */
export const PRICE_BANDS_SEED: Record<string, { p50: number; p90: number; max: number }> = {
  "llm-compact": { p50: 0.0002, p90: 0.01, max: 0.1 },
  llm: { p50: 0.002, p90: 0.05, max: 0.2 },
  "market-data": { p50: 0.001, p90: 0.02, max: 0.1 },
  "crypto-data": { p50: 0.001, p90: 0.02, max: 0.1 },
  rpc: { p50: 0.0005, p90: 0.01, max: 0.05 },
  scrape: { p50: 0.005, p90: 0.03, max: 0.15 },
  "web-search": { p50: 0.005, p90: 0.03, max: 0.15 },
  "social-data": { p50: 0.005, p90: 0.03, max: 0.15 },
  "data-enrichment": { p50: 0.01, p90: 0.05, max: 0.25 },
  "image-gen": { p50: 0.02, p90: 0.1, max: 0.5 },
  "video-gen": { p50: 0.1, p90: 0.5, max: 3.0 },
  prediction: { p50: 0.01, p90: 0.1, max: 1.0 },
  identity: { p50: 0.5, p90: 2.0, max: 5.0 },
  generic: { p50: 0.005, p90: 0.05, max: 0.5 },
};

/** Absolute USD ceiling for a single API call. Above this always warns. */
export const DEFAULT_ABSOLUTE_CEILING_USD = 25;

// Decimals for converting atomic amounts -> human units.
const ASSET_DECIMALS: Record<string, number> = { usdc: 6, usdbc: 6, usdt: 6, dai: 18 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";
export type Verdict = "allow" | "warn" | "block";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CallerPolicy {
  maxPerCallUsd?: number;
  allowlist?: string[]; // payTo must be in this set (if provided)
  blocklist?: string[]; // payTo must NOT be in this set
  allowedNetworks?: string[];
  allowedAssets?: string[]; // symbols or contract addresses
  maxRiskScore?: number; // block if computed score exceeds this
}

export interface PrecheckInput {
  // Either pass the raw 402 envelope...
  challenge?: any; // { x402Version, accepts: [PaymentRequirements], error? } or a single PaymentRequirements
  // ...or pass fields directly:
  payTo?: string;
  amount?: number | string; // human USD (e.g. 0.01)
  maxAmountRequired?: string; // atomic units (alternative to amount)
  asset?: string; // symbol ("USDC") or contract address
  network?: string;
  resource?: string; // the URL / endpoint being paid for
  endpoint?: string; // alias for resource
  facilitator?: string; // facilitator URL or host
  category?: string; // service category hint for price banding
  policy?: CallerPolicy;
}

export interface Overrides {
  denied?: string[]; // additional denied addresses
  reportedFlags?: string[]; // community-reported (warn-grade) addresses
  trustedPayees?: string[]; // operator allowlist (reduces risk)
  priceBands?: Record<string, { p50: number; p90: number; max: number }>;
  absoluteCeilingUsd?: number;
}

export interface PrecheckResult {
  verdict: Verdict;
  recommendation: "proceed" | "proceed_with_caution" | "do_not_pay";
  riskScore: number; // 0-100, higher = riskier
  summary: string;
  payTo: string | null;
  amountUsd: number | null;
  asset: string | null;
  network: string | null;
  category: string;
  priceBand: { p50: number; p90: number; max: number } | null;
  checks: Check[];
  flags: string[];
  help?: string;
  ts: string;
  engine: string;
}

const ENGINE = "x402agentic-precheck/1.0.0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lc = (s: any): string => (typeof s === "string" ? s.trim().toLowerCase() : "");
const isEvmAddress = (a: string): boolean => /^0x[0-9a-f]{40}$/.test(lc(a));

function hostOf(u?: string): string {
  if (!u) return "";
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return lc(u);
  }
}

function assetSymbolDecimals(asset?: string): number {
  const a = lc(asset);
  if (a in ASSET_DECIMALS) return ASSET_DECIMALS[a];
  return 6; // x402 default settlement asset (USDC) is 6 decimals
}

/** Pull a normalized PaymentRequirements out of whatever the caller forwarded. */
function normalizeChallenge(input: PrecheckInput): {
  payTo: string | null;
  amountUsd: number | null;
  asset: string | null;
  network: string | null;
  resource: string | null;
  facilitator: string | null;
} {
  let pr: any = null;
  const ch = input.challenge;
  if (ch && typeof ch === "object") {
    if (Array.isArray(ch.accepts) && ch.accepts.length) pr = ch.accepts[0];
    else if (ch.payTo || ch.maxAmountRequired || ch.asset) pr = ch; // already a PaymentRequirements
  }

  const payToRaw = input.payTo ?? pr?.payTo ?? pr?.payToAddress ?? null;
  const assetRaw = input.asset ?? pr?.asset ?? pr?.extra?.symbol ?? null;
  const networkRaw = input.network ?? pr?.network ?? null;
  const resourceRaw = input.resource ?? input.endpoint ?? pr?.resource ?? null;
  const facilitatorRaw = input.facilitator ?? pr?.facilitator ?? pr?.extra?.facilitator ?? null;

  // amount resolution: explicit human amount wins, else atomic maxAmountRequired.
  let amountUsd: number | null = null;
  if (input.amount !== undefined && input.amount !== null && `${input.amount}` !== "") {
    const n = Number(input.amount);
    amountUsd = Number.isFinite(n) ? n : null;
  } else {
    const atomic = input.maxAmountRequired ?? pr?.maxAmountRequired ?? null;
    if (atomic !== null && atomic !== undefined) {
      const dec = assetSymbolDecimals(assetRaw);
      const n = Number(atomic) / Math.pow(10, dec);
      amountUsd = Number.isFinite(n) ? n : null;
    }
  }

  return {
    payTo: payToRaw ? lc(payToRaw) : null,
    amountUsd,
    asset: assetRaw ? lc(assetRaw) : null,
    network: networkRaw ? lc(networkRaw) : null,
    resource: resourceRaw ?? null,
    facilitator: facilitatorRaw ?? null,
  };
}

function bandFor(
  category: string,
  bands: Record<string, { p50: number; p90: number; max: number }>,
) {
  return bands[category] ?? bands["generic"] ?? PRICE_BANDS_SEED["generic"];
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export function evaluate(input: PrecheckInput, overrides: Overrides = {}): PrecheckResult {
  const checks: Check[] = [];
  const flags: string[] = [];
  let score = 0;
  let critical = false; // any critical failure forces a block

  const add = (c: Check, weight = 0, crit = false) => {
    checks.push(c);
    if (c.status === "warn" || c.status === "fail") score += weight;
    if (crit && c.status === "fail") critical = true;
    if (c.status !== "pass") flags.push(c.id);
  };

  const norm = normalizeChallenge(input);
  const category = lc(input.category) || "generic";

  const denied = new Set(
    [...DENYLIST_SEED, ...(overrides.denied ?? [])].map(lc),
  );
  const reported = new Set((overrides.reportedFlags ?? []).map(lc));
  const trusted = new Set((overrides.trustedPayees ?? []).map(lc));
  const facilitators = KNOWN_FACILITATORS_SEED;
  const stablecoins = STABLECOINS_SEED;
  const bands = { ...PRICE_BANDS_SEED, ...(overrides.priceBands ?? {}) };
  const ceiling = overrides.absoluteCeilingUsd ?? DEFAULT_ABSOLUTE_CEILING_USD;

  // 1. Envelope integrity ----------------------------------------------------
  const missing: string[] = [];
  if (!norm.payTo) missing.push("payTo");
  if (norm.amountUsd === null) missing.push("amount/maxAmountRequired");
  if (!norm.network) missing.push("network");
  if (missing.length) {
    add(
      {
        id: "envelope_integrity",
        label: "402 envelope integrity",
        status: "fail",
        detail: `Malformed or incomplete payment challenge — missing: ${missing.join(", ")}. A challenge that does not declare who/how much/where is not safe to pay.`,
      },
      100,
      true,
    );
  } else {
    add({
      id: "envelope_integrity",
      label: "402 envelope integrity",
      status: "pass",
      detail: "Challenge declares payTo, amount, and network.",
    });
  }

  // 2. Address validity ------------------------------------------------------
  if (norm.payTo) {
    if (norm.network === "solana") {
      // Solana addresses are base58, not 0x — skip EVM check, basic length sanity.
      const ok = norm.payTo.length >= 32 && norm.payTo.length <= 44;
      add(
        {
          id: "address_validity",
          label: "Payee address validity",
          status: ok ? "pass" : "fail",
          detail: ok ? "Plausible Solana address." : "Payee is not a plausible Solana address.",
        },
        100,
        true,
      );
    } else if (!isEvmAddress(norm.payTo)) {
      add(
        {
          id: "address_validity",
          label: "Payee address validity",
          status: "fail",
          detail: "Payee is not a valid EVM address (expected 0x + 40 hex).",
        },
        100,
        true,
      );
    } else {
      add({
        id: "address_validity",
        label: "Payee address validity",
        status: "pass",
        detail: "Valid address format.",
      });
    }
  }

  // 3. Denylist screen ------------------------------------------------------
  if (norm.payTo) {
    if (denied.has(norm.payTo)) {
      add(
        {
          id: "denylist_screen",
          label: "Denylist screen",
          status: "fail",
          detail: "Payee is on the denylist. Do not pay.",
        },
        100,
        true,
      );
    } else {
      add({
        id: "denylist_screen",
        label: "Denylist screen",
        status: "pass",
        detail: "Payee not on the denied list.",
      });
    }
  }

  // 4. Reported-flagged screen --------------------------------------------------
  if (norm.payTo && reported.has(norm.payTo)) {
    add(
      {
        id: "reported_flag",
        label: "Community reports",
        status: "fail",
        detail: "Payee has community abuse reports against it.",
      },
      45,
      true,
    );
  } else if (norm.payTo) {
    add({
      id: "reported_flag",
      label: "Community reports",
      status: "pass",
      detail: "No flagged reports on file for this payee.",
    });
  }

  // 5. Price-outlier check ---------------------------------------------------
  const band = bandFor(category, bands);
  if (norm.amountUsd !== null) {
    if (norm.amountUsd > band.max) {
      add(
        {
          id: "price_outlier",
          label: "Price vs. category band",
          status: "fail",
          detail: `$${norm.amountUsd} is far above the '${category}' band (typical $${band.p50}, high $${band.p90}, outlier > $${band.max}). Likely overcharge.`,
        },
        60,
      );
    } else if (norm.amountUsd > band.p90) {
      add(
        {
          id: "price_outlier",
          label: "Price vs. category band",
          status: "warn",
          detail: `$${norm.amountUsd} is above the 90th percentile for '${category}' ($${band.p90}). Pricey but plausible.`,
        },
        20,
      );
    } else {
      add({
        id: "price_outlier",
        label: "Price vs. category band",
        status: "pass",
        detail: `$${norm.amountUsd} is within the normal '${category}' range.`,
      });
    }
  }

  // 6. Absolute ceiling ------------------------------------------------------
  if (norm.amountUsd !== null && norm.amountUsd > ceiling) {
    add(
      {
        id: "absolute_ceiling",
        label: "Absolute per-call ceiling",
        status: "warn",
        detail: `$${norm.amountUsd} exceeds the absolute single-call ceiling of $${ceiling}. Confirm this is intended before paying.`,
      },
      35,
    );
  }

  // 7. Asset sanity ----------------------------------------------------------
  if (norm.asset && norm.network) {
    const knownForNet = (stablecoins[norm.network] ?? []).map(lc);
    const isStableSymbol = ["usdc", "usdbc", "usdt", "dai"].includes(norm.asset);
    const isKnownContract = knownForNet.includes(norm.asset);
    if (isStableSymbol || isKnownContract) {
      add({
        id: "asset_check",
        label: "Settlement asset",
        status: "pass",
        detail: `Paying in a recognized stablecoin (${norm.asset}).`,
      });
    } else {
      add(
        {
          id: "asset_check",
          label: "Settlement asset",
          status: "warn",
          detail: `Settlement asset '${norm.asset}' is not a recognized stablecoin on ${norm.network}. Verify you are not being asked to pay in a volatile or worthless token.`,
        },
        20,
      );
    }
  }

  // 8. Network sanity --------------------------------------------------------
  if (norm.network) {
    if (SUPPORTED_NETWORKS_SEED.includes(norm.network)) {
      add({
        id: "network_check",
        label: "Settlement network",
        status: "pass",
        detail: `${norm.network} is a supported settlement network.`,
      });
    } else {
      add(
        {
          id: "network_check",
          label: "Settlement network",
          status: "warn",
          detail: `Unrecognized settlement network '${norm.network}'.`,
        },
        15,
      );
    }
  }

  // 9. Facilitator check (informational) -------------------------------------
  if (norm.facilitator) {
    const fh = hostOf(norm.facilitator);
    const known = facilitators.some((k) => fh === k || fh.endsWith("." + k));
    add(
      {
        id: "facilitator_check",
        label: "Facilitator reputation",
        status: known ? "pass" : "warn",
        detail: known
          ? `Facilitator ${fh} is recognized.`
          : `Facilitator ${fh} is not in the known set. Not disqualifying, but verify it.`,
      },
      known ? 0 : 5,
    );
  }

  // 10. Caller policy --------------------------------------------------------
  const pol = input.policy;
  if (pol) {
    // blocklist
    if (norm.payTo && (pol.blocklist ?? []).map(lc).includes(norm.payTo)) {
      add(
        {
          id: "policy_blocklist",
          label: "Caller policy — blocklist",
          status: "fail",
          detail: "Payee is on the caller-supplied blocklist.",
        },
        100,
        true,
      );
    }
    // allowlist (if provided, payTo must be present)
    if (pol.allowlist && pol.allowlist.length) {
      const ok = norm.payTo ? pol.allowlist.map(lc).includes(norm.payTo) : false;
      add(
        {
          id: "policy_allowlist",
          label: "Caller policy — allowlist",
          status: ok ? "pass" : "fail",
          detail: ok
            ? "Payee is on the caller allowlist."
            : "Caller restricts payments to an allowlist and this payee is not on it.",
        },
        100,
        true,
      );
    }
    // maxPerCall
    if (pol.maxPerCallUsd !== undefined && norm.amountUsd !== null) {
      const ok = norm.amountUsd <= pol.maxPerCallUsd;
      add(
        {
          id: "policy_max_per_call",
          label: "Caller policy — max per call",
          status: ok ? "pass" : "fail",
          detail: ok
            ? `$${norm.amountUsd} is within the caller limit of $${pol.maxPerCallUsd}.`
            : `$${norm.amountUsd} exceeds the caller per-call limit of $${pol.maxPerCallUsd}.`,
        },
        100,
        true,
      );
    }
    // allowed networks
    if (pol.allowedNetworks && pol.allowedNetworks.length && norm.network) {
      const ok = pol.allowedNetworks.map(lc).includes(norm.network);
      if (!ok)
        add(
          {
            id: "policy_network",
            label: "Caller policy — allowed networks",
            status: "fail",
            detail: `Network '${norm.network}' is not in the caller's allowed networks.`,
          },
          100,
          true,
        );
    }
    // allowed assets
    if (pol.allowedAssets && pol.allowedAssets.length && norm.asset) {
      const ok = pol.allowedAssets.map(lc).includes(norm.asset);
      if (!ok)
        add(
          {
            id: "policy_asset",
            label: "Caller policy — allowed assets",
            status: "fail",
            detail: `Asset '${norm.asset}' is not in the caller's allowed assets.`,
          },
          100,
          true,
        );
    }
  }

  // Trusted payee dampener ---------------------------------------------------
  if (norm.payTo && trusted.has(norm.payTo) && !critical) {
    score = Math.max(0, score - 25);
    checks.push({
      id: "trusted_payee",
      label: "Trusted payee",
      status: "pass",
      detail: "Payee is on the operator's trusted list — risk reduced.",
    });
  }

  // maxRiskScore policy (evaluated after scoring) ----------------------------
  score = Math.min(100, score);
  if (pol?.maxRiskScore !== undefined && score > pol.maxRiskScore) critical = true;

  // Verdict ------------------------------------------------------------------
  let verdict: Verdict;
  if (critical || score >= 60) verdict = "block";
  else if (score >= 20) verdict = "warn";
  else verdict = "allow";

  const recommendation =
    verdict === "block"
      ? "do_not_pay"
      : verdict === "warn"
        ? "proceed_with_caution"
        : "proceed";

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const summary =
    verdict === "allow"
      ? "Safe to pay. All precheck checks passed."
      : verdict === "warn"
        ? `Proceed with caution — ${warnCount} warning(s), ${failCount} failure(s). Review flags before paying.`
        : `Do not pay — ${failCount} blocking failure(s). This payment was stopped by the precheck.`;

  const result: PrecheckResult = {
    verdict,
    recommendation,
    riskScore: score,
    summary,
    payTo: norm.payTo,
    amountUsd: norm.amountUsd,
    asset: norm.asset,
    network: norm.network,
    category,
    priceBand: norm.amountUsd !== null ? band : null,
    checks,
    flags: Array.from(new Set(flags)),
    ts: new Date().toISOString(),
    engine: ENGINE,
  };

  if (missing.length) {
    result.help =
      "Send the 402 challenge as `challenge` (the JSON body of the 402 response), " +
      "or send `payTo`, `amount` (USD) and `network` directly. Optional: `asset`, " +
      "`category`, `facilitator`, `resource`, and a `policy` object.";
  }

  return result;
}
