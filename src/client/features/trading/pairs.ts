// The currency pairs the trading desk deals in: the seven majors, each with the numbers the fake
// market (market.ts) is made from. They were measured off real quotes (Yahoo Finance, Nov 2026: a week
// of 1-minute bars, 60 days of hourly ones and a year of daily ones), so a fake EUR/USD moves about as
// far in an hour, a day and a news spike as the real one does, and the pairs move together the way the
// real ones do.

export type Ccy = 'EUR' | 'USD' | 'GBP' | 'JPY' | 'CHF' | 'AUD' | 'CAD' | 'NZD';

export interface Pair {
  /** EURUSD: what positions and saved state call it. */
  id: string;
  base: Ccy;
  quote: Ccy;
  /** What one pip is in price (0.0001, or 0.01 for the yen), and how many decimals a quote shows (a pip and a tenth). */
  pip: number;
  digits: number;
  /** Roughly where it trades: each new market starts somewhere near here. */
  price: number;
  /** How far it moves in an hour, typically (the standard deviation of hourly moves, in pips). */
  hourly: number;
  /** The usual spread between bid and ask, in pips, on a retail account. */
  spread: number;
  /** How much busier it is than the others in the Asian session (the yen, the Aussie and the kiwi). */
  asia: number;
}

export const PAIRS: readonly Pair[] = [
  { id: 'EURUSD', base: 'EUR', quote: 'USD', pip: 0.0001, digits: 5, price: 1.1208, hourly: 7.6, spread: 1.0, asia: 1 },
  { id: 'GBPUSD', base: 'GBP', quote: 'USD', pip: 0.0001, digits: 5, price: 1.3426, hourly: 8.6, spread: 1.4, asia: 1 },
  { id: 'USDJPY', base: 'USD', quote: 'JPY', pip: 0.01, digits: 3, price: 158.0, hourly: 14.7, spread: 1.2, asia: 1.4 },
  { id: 'USDCHF', base: 'USD', quote: 'CHF', pip: 0.0001, digits: 5, price: 0.8205, hourly: 7.3, spread: 1.6, asia: 1 },
  { id: 'AUDUSD', base: 'AUD', quote: 'USD', pip: 0.0001, digits: 5, price: 0.6916, hourly: 5.8, spread: 1.2, asia: 1.35 },
  { id: 'USDCAD', base: 'USD', quote: 'CAD', pip: 0.0001, digits: 5, price: 1.4128, hourly: 8.0, spread: 1.8, asia: 0.9 },
  { id: 'NZDUSD', base: 'NZD', quote: 'USD', pip: 0.0001, digits: 5, price: 0.5626, hourly: 5.7, spread: 1.8, asia: 1.35 },
];

/** EUR/USD, as the screens write it. */
export const pairName = (p: Pair) => `${p.base}/${p.quote}`;

/**
 * How the pairs' hourly moves go together (in the order of PAIRS), measured off 60 days of real ones:
 * EUR/USD and GBP/USD mostly move as one, and the pairs with the dollar the other way round move against them.
 */
export const CORRELATION: readonly (readonly number[])[] = [
  [1, 0.83, -0.44, -0.69, 0.59, -0.59, 0.63],
  [0.83, 1, -0.48, -0.64, 0.62, -0.61, 0.65],
  [-0.44, -0.48, 1, 0.53, -0.3, 0.33, -0.38],
  [-0.69, -0.64, 0.53, 1, -0.4, 0.56, -0.54],
  [0.59, 0.62, -0.3, -0.4, 1, -0.54, 0.7],
  [-0.59, -0.61, 0.33, 0.56, -0.54, 1, -0.57],
  [0.63, 0.65, -0.38, -0.54, 0.7, -0.57, 1],
];

/** The lower-triangular L with L·Lᵀ = m, which turns independent shocks into ones correlated like m. */
export function cholesky(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      l[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / l[j][j];
    }
  }
  return l;
}

/**
 * How busy the market is through the day, hour by hour (UTC), as a share of the day's average: quiet
 * through Asia, a jump at the London open (07:00), the busiest stretch when New York opens on top of
 * London (13:00–15:00), and a lull into the daily rollover at 22:00. The shape follows the real
 * minute-by-minute moves, smoothed over a quiet week's quirks.
 */
const SESSION = [0.9, 0.92, 0.85, 0.8, 0.76, 0.74, 0.82, 1.15, 1.22, 1.08, 1.0, 0.96, 1.05, 1.45, 1.38, 1.25, 1.08, 0.95, 0.86, 0.82, 0.72, 0.66, 0.68, 0.8];

/** The hours a pair's Asian boost (Pair.asia) applies to: Sydney and Tokyo, 22:00–07:00 UTC. */
const inAsia = (hour: number) => hour >= 22 || hour < 7;

/** Each pair's activity for each minute of the UTC day, scaled so its average square is 1. */
export const ACTIVITY: readonly Float32Array[] = PAIRS.map((p) => {
  const hourly = SESSION.map((v, hr) => v * (inAsia(hr) ? p.asia : 1) * (p.quote === 'CAD' && hr >= 12 && hr < 17 ? 1.15 : 1));
  const out = new Float32Array(1440);
  for (let m = 0; m < 1440; m++) {
    // Smoothly from one hour's level to the next, so the London open is a ramp, not a step.
    const at = m / 60 - 0.5;
    const i = Math.floor(at);
    const f = at - i;
    const a = hourly[(i + 24) % 24];
    const b = hourly[(i + 25) % 24];
    out[m] = a + (b - a) * (f * f * (3 - 2 * f));
  }
  let sq = 0;
  for (const v of out) sq += v * v;
  const norm = Math.sqrt(sq / out.length);
  for (let m = 0; m < 1440; m++) out[m] /= norm;
  return out;
});

/** The news that moves the market: what it's called, whose currency, when (UTC, as hh*60+mm), how much it matters (1–3) and the days it comes out on (0 is Sunday). */
export interface NewsKind {
  name: string;
  ccy: Ccy;
  at: number;
  impact: 1 | 2 | 3;
  days?: readonly number[];
}

const hm = (h: number, m = 0) => h * 60 + m;

export const NEWS: readonly NewsKind[] = [
  { name: 'Nonfarm Payrolls', ccy: 'USD', at: hm(13, 30), impact: 3, days: [5] },
  { name: 'CPI m/m', ccy: 'USD', at: hm(13, 30), impact: 3 },
  { name: 'Retail Sales m/m', ccy: 'USD', at: hm(13, 30), impact: 2 },
  { name: 'Unemployment Claims', ccy: 'USD', at: hm(13, 30), impact: 1, days: [4] },
  { name: 'ISM Manufacturing PMI', ccy: 'USD', at: hm(15), impact: 2 },
  { name: 'FOMC Statement', ccy: 'USD', at: hm(19), impact: 3, days: [3] },
  { name: 'Fed Chair Speaks', ccy: 'USD', at: hm(17, 30), impact: 2 },
  { name: 'German Flash PMI', ccy: 'EUR', at: hm(8, 30), impact: 2 },
  { name: 'ECB Rate Decision', ccy: 'EUR', at: hm(13, 15), impact: 3, days: [4] },
  { name: 'German ZEW Sentiment', ccy: 'EUR', at: hm(10), impact: 1 },
  { name: 'UK CPI y/y', ccy: 'GBP', at: hm(7), impact: 3 },
  { name: 'UK GDP m/m', ccy: 'GBP', at: hm(7), impact: 2 },
  { name: 'BoE Rate Decision', ccy: 'GBP', at: hm(12), impact: 3, days: [4] },
  { name: 'BoJ Policy Rate', ccy: 'JPY', at: hm(3), impact: 3 },
  { name: 'Tokyo Core CPI', ccy: 'JPY', at: hm(23, 30), impact: 1 },
  { name: 'SNB Rate Decision', ccy: 'CHF', at: hm(8, 30), impact: 2, days: [4] },
  { name: 'RBA Rate Decision', ccy: 'AUD', at: hm(3, 30), impact: 3, days: [2] },
  { name: 'AU Employment Change', ccy: 'AUD', at: hm(0, 30), impact: 2, days: [4] },
  { name: 'CA Employment Change', ccy: 'CAD', at: hm(13, 30), impact: 2, days: [5] },
  { name: 'BoC Rate Decision', ccy: 'CAD', at: hm(14, 45), impact: 3, days: [3] },
  { name: 'RBNZ Rate Decision', ccy: 'NZD', at: hm(1), impact: 3, days: [3] },
  { name: 'NZ GDP q/q', ccy: 'NZD', at: hm(21, 45), impact: 2 },
];
