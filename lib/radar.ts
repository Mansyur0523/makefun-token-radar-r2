// Launch Radar — comps curve fitted from the snapshot's own traded tokens.
//
// The board ranks pre-token protocols by an implied value that comes from one
// fitted curve, never from a hand-kept list of names:
//
//   log(mcap) = a + b * log(TVL) + offset[category]
//
// fitted by ordinary least squares on the snapshot's own traded tokens
// (protocols with a positive market cap and a positive TVL). The fit is
// tested blind before it is used: a seeded 80/20 holdout and a repeated
// 5-fold cross-validation, both reported in the dashboard's Methodology
// panel. Implied value = exp(prediction) x launch probability, where the
// launch probability is a stated function of TVL, 7-day growth and age
// without a token. Farm economics are netted to dollars per row.

export interface SnapProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token at all in the snapshot. */
export function recordsNoToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol the board may rank: pre-token, not an exchange, not a versioned pool. */
export function rankable(p: SnapProtocol): boolean {
  return recordsNoToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

// ------------------------------------------------------------------ OLS fit

/** A tiny deterministic PRNG (LCG) so every split is reproducible run to run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A seeded Fisher-Yates shuffle of 0..n-1. */
export function shuffled(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const r = rng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/** Solve A x = b by Gauss-Jordan with partial pivoting (A is small and dense). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]!;
    if (d === 0) throw new Error('singular design matrix');
    for (let j = c; j <= n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

/** Least squares for y ~ X; returns coefficients. */
export function ols(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) A[r]![c]! += X[i]![r]! * X[i]![c]!;
      b[r]! += X[i]![r]! * y[i]!;
    }
  }
  return solve(A, b);
}

export function rSquared(y: number[], pred: number[]): number {
  const mean = y.reduce((a, v) => a + v, 0) / y.length;
  let ss = 0;
  let st = 0;
  for (let i = 0; i < y.length; i++) {
    ss += (y[i]! - pred[i]!) ** 2;
    st += (y[i]! - mean) ** 2;
  }
  return st === 0 ? 0 : 1 - ss / st;
}

export function logRmse(y: number[], pred: number[]): number {
  return Math.sqrt(y.reduce((a, v, i) => a + (v - pred[i]!) ** 2, 0) / y.length);
}

/** Categories with at least this many anchors get their own offset; the rest share "Other". */
export const OFFSET_MIN_COUNT = 4;

/** The comps curve: log(mcap) ~ log(TVL) + category offset. */
export interface CompsFit {
  n: number;
  intercept: number;
  slope: number;
  baseline: string;
  offsets: Record<string, number>;
  sigma: number;
  r2: number;
}

export function categoryOf(p: SnapProtocol, kept: Set<string>): string {
  const c = p.category ?? 'Other';
  return kept.has(c) ? c : 'Other';
}

/** The kept offset categories of an anchor set, alphabetically sorted. */
export function keptCategories(anchors: SnapProtocol[]): { kept: Set<string>; cats: string[] } {
  const counts = new Map<string, number>();
  for (const p of anchors) {
    const c = p.category ?? 'Other';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const kept = new Set([...counts.entries()].filter(([, n]) => n >= OFFSET_MIN_COUNT).map(([c]) => c));
  const cats = [...new Set(anchors.map((p) => categoryOf(p, kept)))].sort();
  return { kept, cats };
}

export function designRow(p: SnapProtocol, kept: Set<string>, cats: string[]): number[] {
  const row = [1, Math.log(p.tvl_usd)];
  for (const c of cats.slice(1)) row.push(categoryOf(p, kept) === c ? 1 : 0);
  return row;
}

export function predictLog(p: SnapProtocol, fit: CompsFit, kept: Set<string>, cats: string[]): number {
  const row = designRow(p, kept, cats);
  let v = fit.intercept + fit.slope * row[1]!;
  for (let i = 0; i < cats.length - 1; i++) v += (fit.offsets[cats[i + 1]!] ?? 0) * row[2 + i]!;
  return v;
}

export function fitComps(anchors: SnapProtocol[]): { fit: CompsFit; kept: Set<string>; cats: string[] } {
  const { kept, cats } = keptCategories(anchors);
  const X = anchors.map((p) => designRow(p, kept, cats));
  const y = anchors.map((p) => Math.log(p.mcap_usd!));
  const beta = ols(X, y);
  const pred = anchors.map((p, i) => X[i]!.reduce((a, v, j) => a + v * beta[j]!, 0));
  const offsets: Record<string, number> = {};
  for (let i = 0; i < cats.length - 1; i++) offsets[cats[i + 1]!] = round4(beta[2 + i]!);
  const fit: CompsFit = {
    n: anchors.length,
    intercept: round4(beta[0]!),
    slope: round4(beta[1]!),
    baseline: cats[0]!,
    offsets,
    sigma: round4(logRmse(y, pred)),
    r2: round4(rSquared(y, pred)),
  };
  return { fit, kept, cats };
}

/** Blind validation of the curve: one seeded 80/20 holdout + repeated 5-fold CV. */
export interface Validation {
  holdout_seed: number;
  holdout_n: number;
  holdout_r2: number;
  holdout_log_rmse: number;
  cv_folds: number;
  cv_seeds: number;
  cv_r2_mean: number;
  cv_r2_min: number;
  cv_r2_max: number;
  band_90x: number;
}

export function validateComps(anchors: SnapProtocol[], fit: CompsFit): Validation {
  const { kept, cats } = keptCategories(anchors);
  const yAll = anchors.map((p) => Math.log(p.mcap_usd!));

  // One 80/20 holdout, seeded: fit on 80%, score the 20% never seen in the fit.
  const order = shuffled(anchors.length, 20261114);
  const nTest = Math.floor(anchors.length * 0.2);
  const testSet = new Set(order.slice(0, nTest));
  const train = anchors.filter((_, i) => !testSet.has(i));
  const hold = anchors.filter((_, i) => testSet.has(i));
  const betaH = ols(train.map((p) => designRow(p, kept, cats)), train.map((p) => Math.log(p.mcap_usd!)));
  const predH = hold.map((p) => designRow(p, kept, cats).reduce((a, v, j) => a + v * betaH[j]!, 0));
  const yH = hold.map((p) => Math.log(p.mcap_usd!));

  // Repeated 5-fold cross-validation, 10 seeds: the honest average, not one lucky split.
  const cvMeans: number[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const perm = shuffled(anchors.length, seed);
    const foldR2: number[] = [];
    for (let f = 0; f < 5; f++) {
      const foldSet = new Set(perm.filter((_, k) => k % 5 === f));
      const tr = anchors.filter((_, i) => !foldSet.has(i));
      const ho = anchors.filter((_, i) => foldSet.has(i));
      const b = ols(tr.map((p) => designRow(p, kept, cats)), tr.map((p) => Math.log(p.mcap_usd!)));
      const pr = ho.map((p) => designRow(p, kept, cats).reduce((a, v, j) => a + v * b[j]!, 0));
      foldR2.push(rSquared(ho.map((p) => Math.log(p.mcap_usd!)), pr));
    }
    cvMeans.push(foldR2.reduce((a, v) => a + v, 0) / foldR2.length);
  }
  void yAll;
  return {
    holdout_seed: 20261114,
    holdout_n: hold.length,
    holdout_r2: round4(rSquared(yH, predH)),
    holdout_log_rmse: round4(logRmse(yH, predH)),
    cv_folds: 5,
    cv_seeds: 10,
    cv_r2_mean: round4(cvMeans.reduce((a, v) => a + v, 0) / cvMeans.length),
    cv_r2_min: round4(Math.min(...cvMeans)),
    cv_r2_max: round4(Math.max(...cvMeans)),
    band_90x: round4(Math.exp(1.6449 * fit.sigma)),
  };
}

// ------------------------------------------------------------- launch odds

/** Launch probability from the snapshot's own figures: size, growth, age. */
export function launchProb(p: SnapProtocol, asOf: string): number {
  const size = clamp((Math.log10(Math.max(p.tvl_usd, 1)) - 6.7) / 3.4, 0, 1);
  const growth = 1 + clamp(p.change_7d ?? 0, -50, 100) / 200;
  const age = ageDays(asOf, p.listed_at);
  const maturity = age === null ? 0.875 : 0.75 + 0.25 * (Math.min(age, 1095) / 1095);
  return round4(clamp((0.1 + 0.55 * size) * growth * maturity, 0.05, 0.8));
}

// ---------------------------------------------------------------- farm plan

const GAS_L1 = 9; // dollars per transaction on Ethereum
const GAS_L2 = 2; // dollars per transaction elsewhere

export function gasPerTx(p: SnapProtocol): number {
  return p.chains.length > 0 && p.chains[0] === 'Ethereum' ? GAS_L1 : GAS_L2;
}

export function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function chainOf(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's core on-chain action, in words a farmer can follow. */
function coreAction(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave the supply position open so it earns interest.`;
  if (c.includes('dex') || c.includes('leveraged farm') || c.includes('yield'))
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then put the bridged funds to work in one app on that chain.`;
  if (c.includes('stak') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, then close it the same week.`;
  if (c.includes('prediction'))
    return `Fund ${name} with $${capital} and take one real position in an open market, then let it settle.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it in your farm wallet.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export interface FarmPlan {
  steps: string[];
  gas_usd: number;
  capital_usd: number;
  hold_days: number;
  total_cost_usd: number;
}

/**
 * Six concrete steps per protocol, each carrying its dollar cost and its time.
 * Total cost = gas for 7 transactions + 5% a year on the locked capital.
 */
export function farmPlan(p: SnapProtocol, age: number | null): FarmPlan {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(p);
  const gasTotal = 7 * gas;
  const opportunity = Math.round((capital * 0.05 * hold) / 365);
  const total = gasTotal + opportunity;
  const steps = [
    `Open a fresh wallet for this farm only, fund it with $${capital + gasTotal} of USDC on ${chain}, and store its seed phrase offline. Cost: $${gas} of gas. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of capital plus $${gas} of gas. Time: 15 minutes.`,
    `Do one qualifying action each week for four weeks: a deposit, a swap, a borrow or a vote inside ${p.name}, so the wallet shows repeat activity. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity spans more than one snapshot window, and do not withdraw early. Cost: $${opportunity} of forgone yield on the $${capital}. Time: ${hold} days.`,
    `Check ${p.name}'s own points or rewards page once a week and record any points balance; never connect the wallet to a link from a DM or a reply. Cost: $0 to check. Time: 5 minutes a week.`,
    `When a claim opens, claim only from the link the protocol itself publishes, then move the tokens to a cold wallet and log every transaction. Cost: $${gas} of gas to claim. Time: 15 minutes.`,
  ];
  return { steps, gas_usd: gasTotal, capital_usd: capital, hold_days: hold, total_cost_usd: total };
}

/** One active farmer is assumed to capture 0.01% (1 bp) of the implied value. */
export const FARMER_SHARE = 0.0001;

export function verdictFor(expectedUsd: number): 'farm' | 'thin' | 'skip' {
  if (expectedUsd >= 250) return 'farm';
  if (expectedUsd >= 0) return 'thin';
  return 'skip';
}

// ------------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  is_watchlist: boolean;
  implied_value_usd: number;
  base_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  launch_prob: number;
  expected_value_usd: number;
  farm_cost_usd: number;
  farm_capital_usd: number;
  verdict: 'farm' | 'thin' | 'skip';
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl: number;
}

export interface RadarModel {
  fit: CompsFit;
  validation: Validation;
  formula: string;
  farmer_share: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: RadarModel;
  watchlist_size: number;
  board_size: number;
  anchors_n: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Score every rankable pre-token protocol: watchlist first, then the early ones below the floor. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; model: RadarModel; live: LiveRow[] } {
  const anchors = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const { fit, kept, cats } = fitComps(anchors);
  const validation = validateComps(anchors, fit);
  const band = Math.exp(1.6449 * fit.sigma);

  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((x) => x.slug === slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && rankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const base = Math.exp(predictLog(p, fit, kept, cats));
    const prob = launchProb(p, snapshot.as_of);
    const implied = Math.max(1, Math.round(base * prob));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const plan = farmPlan(p, age);
    const expected = Math.round(implied * FARMER_SHARE - plan.total_cost_usd);
    return {
      p,
      implied,
      base: Math.max(1, Math.round(base)),
      bandLow: Math.max(1, Math.round((base / band) * prob)),
      bandHigh: Math.max(1, Math.round(base * band * prob)),
      prob,
      age,
      plan,
      expected,
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    is_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    base_value_usd: s.base,
    band_low_usd: s.bandLow,
    band_high_usd: s.bandHigh,
    launch_prob: s.prob,
    expected_value_usd: s.expected,
    farm_cost_usd: s.plan.total_cost_usd,
    farm_capital_usd: s.plan.capital_usd,
    verdict: verdictFor(s.expected),
    farm_steps: s.plan.steps,
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_tvl: round4(p.mcap_usd! / p.tvl_usd),
    }));

  const model: RadarModel = {
    fit,
    validation,
    formula:
      'log(mcap) = a + b x log(TVL) + offset[category], fitted by OLS on the snapshot’s own traded tokens; ' +
      'implied = exp(prediction) x P(launch); P(launch) = clamp((0.10 + 0.55 x size) x growth x maturity, 0.05, 0.80), ' +
      'size from log10(TVL), growth from 7-day TVL change, maturity from days listed with no token.',
    farmer_share: FARMER_SHARE,
  };
  return { board, model, live };
}

/** Everything the dashboard renders. */
export function buildRadar(snapshot: Snapshot): RadarData {
  const { board, model, live } = buildBoard(snapshot);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'comps-curve-v2',
    model,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    anchors_n: model.fit.n,
    rows: board,
    live,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
