// The market's minutes rolled up into candles for each timeframe, and the moving averages over them.
// Each is worked out for every minute made so far (and again whenever more are made); what a screen
// shows stops at the desk's clock, and the candle the clock is in is put together as it stands
// (see `live`), so nothing past the clock ever shows.

import { DAY, ROLLOVER, type Market } from './market';

export const TIMEFRAMES = [
  { id: '1m', minutes: 1 },
  { id: '5m', minutes: 5 },
  { id: '15m', minutes: 15 },
  { id: '1h', minutes: 60 },
  { id: '4h', minutes: 240 },
  { id: 'D', minutes: 1440 },
] as const;
export type Tf = (typeof TIMEFRAMES)[number]['id'];

export const tfMinutes = (tf: Tf) => TIMEFRAMES.find((t) => t.id === tf)!.minutes;

/** Candles of 4 hours and a day start at the forex day's 22:00 UTC rollover; shorter ones on the clock. */
const offsetOf = (minutes: number) => (minutes >= 240 ? DAY - ROLLOVER : 0);

/** Which candle (of `minutes` each) time `t` falls in, and when that candle starts. */
export function bucketOf(t: number, minutes: number): number {
  return Math.floor((t + offsetOf(minutes)) / (minutes * 60));
}
export function bucketStart(k: number, minutes: number): number {
  return k * minutes * 60 - offsetOf(minutes);
}

/** One timeframe's candles for one pair, over every minute made. */
export interface Candles {
  n: number;
  /** When each starts, and its first minute. */
  t: Float64Array;
  first: Int32Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** Which candle each minute is in. */
  of: Int32Array;
  /** The exponential moving averages of the closes, by period. */
  ema: Map<number, Float64Array>;
}

/** The moving averages a screen can show. */
export const EMAS = [20, 50] as const;

function build(m: Market, pair: number, minutes: number): Candles {
  const n = m.n;
  const t = new Float64Array(n);
  const first = new Int32Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const of = new Int32Array(n);
  let k = -1;
  let key = NaN;
  for (let i = 0; i < n; i++) {
    const b = bucketOf(m.time[i], minutes);
    if (b !== key) {
      key = b;
      k++;
      t[k] = bucketStart(b, minutes);
      first[k] = i;
      o[k] = m.o[pair][i];
      h[k] = m.h[pair][i];
      l[k] = m.l[pair][i];
      v[k] = 0;
    } else {
      if (m.h[pair][i] > h[k]) h[k] = m.h[pair][i];
      if (m.l[pair][i] < l[k]) l[k] = m.l[pair][i];
    }
    c[k] = m.c[pair][i];
    v[k] += m.vol[pair][i];
    of[i] = k;
  }
  const count = k + 1;
  const ema = new Map<number, Float64Array>();
  for (const period of EMAS) {
    const e = new Float64Array(count);
    const a = 2 / (period + 1);
    for (let j = 0; j < count; j++) e[j] = j === 0 ? c[0] : e[j - 1] + a * (c[j] - e[j - 1]);
    ema.set(period, e);
  }
  return { n: count, t, first, o, h, l, c, v, of, ema };
}

/** The candles of each pair and timeframe, made when first asked for and again once the market has more minutes. */
export class CandleCache {
  private readonly made = new Map<string, { version: number; candles: Candles }>();
  constructor(private readonly market: Market) {}

  get(pair: number, tf: Tf): Candles {
    const key = `${pair}:${tf}`;
    const had = this.made.get(key);
    if (had && had.version === this.market.version) return had.candles;
    const candles = build(this.market, pair, tfMinutes(tf));
    this.made.set(key, { version: this.market.version, candles });
    return candles;
  }

  clear() {
    this.made.clear();
  }
}

/** A candle as a screen shows it. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * The candle the clock is in, as far as it's got: minute `m`, `frac` of the way through. Its high and
 * low are only what the price has reached so far, and its close is the price now.
 */
export function live(m: Market, cs: Candles, pair: number, minute: number, frac: number): Candle {
  const k = cs.of[minute];
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  for (let i = cs.first[k]; i < minute; i++) {
    if (m.h[pair][i] > h) h = m.h[pair][i];
    if (m.l[pair][i] < l) l = m.l[pair][i];
    v += m.vol[pair][i];
  }
  // This minute, up to now.
  const now = m.priceAt(pair, minute, frac);
  for (const [at, p] of m.path(pair, minute)) {
    if (at > frac) break;
    if (p > h) h = p;
    if (p < l) l = p;
  }
  h = Math.max(h, now);
  l = Math.min(l, now);
  v += m.vol[pair][minute] * frac;
  return { t: cs.t[k], o: cs.o[k], h, l, c: now, v };
}

/** The moving average at the candle the clock is in: the last finished one's, carried on to the price now. */
export function liveEma(cs: Candles, period: number, k: number, close: number): number {
  const e = cs.ema.get(period)!;
  if (k === 0) return close;
  const a = 2 / (period + 1);
  return e[k - 1] + a * (close - e[k - 1]);
}
