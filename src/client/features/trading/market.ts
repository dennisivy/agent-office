// The fake forex market the trading desk replays: every major pair, a minute at a time, made up from a
// seed but built to move like the real thing (see pairs.ts for where its numbers come from):
//
// - an "efficient" price that wanders by correlated, fat-tailed shocks, with a slow drift that comes
//   and goes, so there are trends some days and chop on others;
// - how big those shocks are follows the clock (quiet in Asia, busy at the London and New York opens),
//   clusters (busy hours follow busy hours) and changes from day to day;
// - news at its usual times: a jump in the pairs with that currency, then a burst of wild minutes and
//   wide spreads that dies down;
// - each minute is walked as a handful of ticks, and the quotes bounce round the efficient price a
//   little, which is what gives real 1-minute candles their wicks (and why minute moves are bigger
//   than the hour's would suggest);
// - the market shuts from Friday 22:00 to Sunday 22:00 UTC and opens again with a gap.
//
// Prices are bids. Only minutes up to the desk's clock are ever shown; the rest are made ahead, a day
// at a time, as the clock gets near them.

import { ACTIVITY, CORRELATION, NEWS, PAIRS, cholesky, type Ccy } from './pairs';

export const DAY = 86400;
/** The forex day starts (and the daily candle opens) at 22:00 UTC, New York's 5pm close. */
export const ROLLOVER = 22 * 3600;

/** A seeded random number generator (mulberry32): the same seed makes the same market. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A scheduled release and when it comes out. */
export interface NewsEvent {
  time: number;
  ccy: Ccy;
  name: string;
  impact: 1 | 2 | 3;
}

/** How many ticks each minute is walked in. */
const TICKS = 10;
/** How far the quotes bounce round the efficient price each tick, as a share of a minute's move. */
const NOISE = 0.75;
/** Busy and quiet stretches: the whole market's (half-life 6 hours) and each pair's own (3 hours). */
const MARKET_VOL = { half: 360, sd: 0.3 };
const PAIR_VOL = { half: 180, sd: 0.14 };
/** How different one day is from the next, for everyone and for each pair. */
const DAY_VOL = 0.22;
const DAY_PAIR_VOL = 0.06;
/** The drift: how strong a trend gets (as a share of an hour's move, per hour) and how long it lasts (half-life, minutes). */
const TREND = { share: 0.1, half: 1440 };
/** Momentum inside the hour: a push one way that lasts half an hour or so (as a share of a minute's move), which is what makes runs on a 1-minute chart. */
const MICRO = { share: 0.08, half: 20 };
/** How much of each tick's bounce carries into the next one: quotes lean one way for a few ticks rather than flicker. */
const STICKY = 0.6;
/** Measured over months, the walk comes out a little quieter than Pair.hourly: this makes up for it. */
const SCALE = 1.2;
/** The pairs move together a little less than CORRELATION says once each has its own busy spells and news: this makes up for it. */
const TOGETHER = 1.12;
/** A big shock makes the next minutes busier too. */
const FEEDBACK = 0.025;
/** How a release of each impact jumps the price (in hours' moves) and how much busier the minutes after it are. */
const JUMP = [0, 0.35, 0.8, 1.7];
/** A release's jump plays out over its first three minutes, most of it in the first. */
const JUMP_SHAPE = [0.6, 0.27, 0.13];
const AFTERSHOCK = [0, 1.5, 3.5, 7];
/** The aftershock's half-life, in minutes. */
const AFTER_HALF = 8;
/** How likely each release is on a day it can come out (the ones on set weekdays, and the rest). */
const ODDS = { fixed: [0, 0.6, 0.45, 0.5], any: [0, 0.18, 0.14, 0.08] };

const decay = (half: number) => Math.exp(-Math.LN2 / half);

/** A fat-tailed shock (Student's t, 4 degrees of freedom, by Bailey's polar method), scaled to a standard deviation of 1. */
function fat(r: () => number): number {
  for (;;) {
    const u = r() * 2 - 1;
    const v = r() * 2 - 1;
    const w = u * u + v * v;
    if (w >= 1 || w === 0) continue;
    return u * Math.sqrt((4 * (Math.pow(w, -0.5) - 1)) / w) / Math.SQRT2;
  }
}

/** A normal shock. */
function normal(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** Whether the market's shut at `t`: from Friday 22:00 to Sunday 22:00 UTC. */
export function closed(t: number): boolean {
  const day = new Date(t * 1000).getUTCDay();
  const sod = ((t % DAY) + DAY) % DAY;
  return day === 6 || (day === 5 && sod >= ROLLOVER) || (day === 0 && sod < ROLLOVER);
}

/** A quick hash of two numbers to [0, 1): where in its minute a candle's high and low come. */
function hash(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

export class Market {
  /** How many minutes there are so far. */
  n = 0;
  /** When each minute starts, in seconds (a made-up calendar: a Monday in 2001 onwards, never shown with its year). */
  time = new Float64Array(0);
  /** Each pair's minutes: open, high, low, close (bids), whether the high came before the low, tick volume and spread (tenths of a pip). */
  readonly o: Float64Array[] = [];
  readonly h: Float64Array[] = [];
  readonly l: Float64Array[] = [];
  readonly c: Float64Array[] = [];
  readonly highFirst: Uint8Array[] = [];
  readonly vol: Uint16Array[] = [];
  readonly spread: Uint8Array[] = [];
  /** Every release so far and through the day being made. */
  readonly news: NewsEvent[] = [];
  /** Grows by one each time minutes are added: what's cached from the minutes knows when it's stale. */
  version = 0;

  private readonly r: () => number;
  private readonly chol = cholesky(CORRELATION.map((row, i) => row.map((v, j) => (i === j ? 1 : v * TOGETHER))));
  private next: number;
  private reopened = false;
  private marketVol = 0;
  private dayVol = 1;
  private readonly pairVol = PAIRS.map(() => 0);
  private readonly pairDay = PAIRS.map(() => 1);
  private readonly drift = PAIRS.map(() => 0);
  private readonly micro = PAIRS.map(() => 0);
  private readonly lean = PAIRS.map(() => 0);
  private readonly after = PAIRS.map(() => 0);
  /** What's left of each pair's news jump, for the next two minutes. */
  private readonly carry = PAIRS.map(() => [0, 0]);
  private readonly eff: number[];
  private readonly last: number[];
  /** The releases still to come in the day being made. */
  private pending: NewsEvent[] = [];

  constructor(readonly seed: number) {
    this.r = rng(seed);
    // Somewhere in the first ten years from Sunday 31 December 2000, 22:00 UTC, when the week opens.
    const week = Math.floor(this.r() * 520);
    this.next = Date.UTC(2000, 11, 31, 22) / 1000 + week * 7 * DAY;
    // Each pair starts within a few percent of where it trades now, on a tick.
    this.eff = PAIRS.map((p) => p.price * (1 + (this.r() - 0.5) * 0.08));
    this.last = this.eff.map((v, i) => this.tick(i, v));
    // Start the drift and the busy-ness part way through their swings, not all at rest.
    PAIRS.forEach((p, i) => {
      this.drift[i] = normal(this.r) * TREND.share * p.hourly / 60;
      this.pairVol[i] = normal(this.r) * PAIR_VOL.sd;
    });
    this.marketVol = normal(this.r) * MARKET_VOL.sd;
    for (let i = 0; i < PAIRS.length; i++) {
      this.o.push(new Float64Array(0));
      this.h.push(new Float64Array(0));
      this.l.push(new Float64Array(0));
      this.c.push(new Float64Array(0));
      this.highFirst.push(new Uint8Array(0));
      this.vol.push(new Uint16Array(0));
      this.spread.push(new Uint8Array(0));
    }
  }

  /** Rounds to a tenth of a pip, which is as fine as quotes go. */
  private tick(i: number, price: number): number {
    const step = PAIRS[i].pip / 10;
    return Math.round(price / step) * step;
  }

  /** Room for `more` minutes. */
  private grow(more: number) {
    const need = this.n + more;
    if (need <= this.time.length) return;
    const cap = Math.max(need, Math.ceil(this.time.length * 1.5), 4096);
    const bigger = <T extends Float64Array | Uint8Array | Uint16Array>(a: T, make: (n: number) => T): T => {
      const b = make(cap);
      b.set(a);
      return b;
    };
    this.time = bigger(this.time, (k) => new Float64Array(k));
    for (let i = 0; i < PAIRS.length; i++) {
      this.o[i] = bigger(this.o[i], (k) => new Float64Array(k));
      this.h[i] = bigger(this.h[i], (k) => new Float64Array(k));
      this.l[i] = bigger(this.l[i], (k) => new Float64Array(k));
      this.c[i] = bigger(this.c[i], (k) => new Float64Array(k));
      this.highFirst[i] = bigger(this.highFirst[i], (k) => new Uint8Array(k));
      this.vol[i] = bigger(this.vol[i], (k) => new Uint16Array(k));
      this.spread[i] = bigger(this.spread[i], (k) => new Uint8Array(k));
    }
  }

  /** Makes `days` more trading days of minutes. */
  extend(days: number) {
    this.grow(days * 1440 + 8);
    let made = 0;
    while (made < days * 1440) {
      if (closed(this.next)) {
        this.weekend();
        continue;
      }
      if (((this.next % DAY) + DAY) % DAY === ROLLOVER || this.n === 0) this.newDay();
      this.minute();
      made++;
    }
    this.version++;
  }

  /** Over the weekend: shut until Sunday 22:00, when the price opens with a gap. */
  private weekend() {
    while (closed(this.next)) this.next += 3600;
    this.next -= ((this.next % DAY) + DAY) % DAY - ROLLOVER;
    PAIRS.forEach((p, i) => (this.eff[i] += normal(this.r) * p.hourly * 1.2 * p.pip));
    this.reopened = true;
  }

  /** A new forex day at 22:00: how lively it is, and which releases are due. */
  private newDay() {
    const s = DAY_VOL;
    this.dayVol = Math.exp(normal(this.r) * s - s * s);
    PAIRS.forEach((_, i) => (this.pairDay[i] = Math.exp(normal(this.r) * DAY_PAIR_VOL - DAY_PAIR_VOL * DAY_PAIR_VOL)));
    const start = this.next;
    const due: NewsEvent[] = [];
    for (const k of NEWS) {
      // An hh:mm at or after 22:00 falls at the start of this forex day, the rest on the calendar day after.
      const time = start + ((k.at - ROLLOVER / 60 + 1440) % 1440) * 60;
      const weekday = new Date(time * 1000).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const odds = k.days ? (k.days.includes(weekday) ? ODDS.fixed[k.impact] : 0) : ODDS.any[k.impact];
      if (this.r() >= odds) continue;
      // One release per currency at a time.
      if (due.some((d) => d.ccy === k.ccy && d.time === time)) continue;
      due.push({ time, ccy: k.ccy, name: k.name, impact: k.impact });
    }
    due.sort((a, b) => a.time - b.time);
    this.pending = due;
    this.news.push(...due);
  }

  /** One minute of every pair. */
  private minute() {
    const t = this.next;
    const m = this.n;
    const r = this.r;
    const of = Math.floor((((t % DAY) + DAY) % DAY) / 60);
    const pairs = PAIRS.length;
    this.time[m] = t;

    // Releases out this minute: how hard each pair jumps, and which way the currency went.
    const jump = this.carry.map((c) => c.shift()!);
    for (const c of this.carry) c.push(0);
    while (this.pending.length && this.pending[0].time <= t) {
      const ev = this.pending.shift()!;
      const way = r() < 0.5 ? -1 : 1;
      const size = JUMP[ev.impact] * (0.5 + Math.min(3, Math.abs(fat(r))));
      PAIRS.forEach((p, i) => {
        if (p.base !== ev.ccy && p.quote !== ev.ccy) return;
        const sign = p.base === ev.ccy ? way : -way;
        const total = sign * size * p.hourly * (0.8 + 0.4 * r());
        jump[i] += total * JUMP_SHAPE[0];
        this.carry[i][0] += total * JUMP_SHAPE[1];
        this.carry[i][1] += total * JUMP_SHAPE[2];
        this.after[i] = Math.max(this.after[i], AFTERSHOCK[ev.impact]);
      });
    }

    // Correlated shocks for the price and for the drift.
    const raw = PAIRS.map(() => fat(r));
    const rawDrift = PAIRS.map(() => normal(r));
    const shock = this.mix(raw);
    const driftShock = this.mix(rawDrift);

    const volNorm = MARKET_VOL.sd ** 2 + PAIR_VOL.sd ** 2;
    for (let i = 0; i < pairs; i++) {
      const p = PAIRS[i];
      const busy = ACTIVITY[i][of] * Math.exp(this.marketVol + this.pairVol[i] - volNorm) * this.dayVol * this.pairDay[i];
      const news = 1 + this.after[i];
      const sigma = ((SCALE * p.hourly) / Math.sqrt(60)) * busy * news;
      const move = this.drift[i] + this.micro[i] * sigma + sigma * shock[i] + jump[i];
      const from = this.eff[i];
      const to = from + move * p.pip;

      // The minute's ticks: a walk from where it was to where it ends up, the quotes bouncing round it.
      const step = (sigma / Math.sqrt(TICKS)) * p.pip;
      const bounce = NOISE * ((SCALE * p.hourly) / Math.sqrt(60)) * busy * Math.sqrt(news) * p.pip;
      const walk = new Array<number>(TICKS);
      let at = from;
      for (let k = 0; k < TICKS; k++) walk[k] = at += normal(r) * step;
      const miss = (to - at) / TICKS;
      const open = this.reopened ? this.tick(i, from + normal(r) * bounce) : this.last[i];
      let hi = open;
      let lo = open;
      let hiAt = -1;
      let loAt = -1;
      let close = open;
      for (let k = 0; k < TICKS; k++) {
        this.lean[i] = STICKY * this.lean[i] + Math.sqrt(1 - STICKY * STICKY) * normal(r);
        const q = this.tick(i, walk[k] + miss * (k + 1) + this.lean[i] * bounce);
        if (q > hi) (hi = q), (hiAt = k);
        if (q < lo) (lo = q), (loAt = k);
        close = q;
      }
      this.o[i][m] = open;
      this.h[i][m] = hi;
      this.l[i][m] = lo;
      this.c[i][m] = close;
      this.highFirst[i][m] = hiAt < loAt ? 1 : 0;
      this.vol[i][m] = Math.min(65535, Math.round(24 * Math.pow(busy * news, 1.5) * Math.exp(normal(r) * 0.3) + r() * 4));
      const rollover = of >= ROLLOVER / 60 - 3 && of <= ROLLOVER / 60 + 8;
      const spread = p.spread * (rollover ? 3.5 : 1) * (1 + 0.6 * this.after[i]) * (of < 7 * 60 && !rollover ? 1.15 : 1);
      this.spread[i][m] = Math.min(255, Math.max(1, Math.round(spread * 10)));
      this.eff[i] = to;
      this.last[i] = close;

      // Busy-ness and drift move on.
      const a = decay(PAIR_VOL.half);
      this.pairVol[i] = a * this.pairVol[i] + PAIR_VOL.sd * Math.sqrt(1 - a * a) * normal(r) + FEEDBACK * (Math.abs(raw[i]) - 0.8);
      const d = decay(TREND.half);
      this.drift[i] = d * this.drift[i] + (TREND.share * p.hourly / 60) * Math.sqrt(1 - d * d) * driftShock[i];
      const u = decay(MICRO.half);
      this.micro[i] = u * this.micro[i] + MICRO.share * Math.sqrt(1 - u * u) * normal(r);
      this.after[i] *= decay(AFTER_HALF);
    }
    const g = decay(MARKET_VOL.half);
    this.marketVol = g * this.marketVol + MARKET_VOL.sd * Math.sqrt(1 - g * g) * normal(r);
    this.reopened = false;
    this.n++;
    this.next += 60;
  }

  /** Independent shocks made to move together the way the pairs do. */
  private mix(raw: readonly number[]): number[] {
    return this.chol.map((row) => row.reduce((s, w, j) => s + w * raw[j], 0));
  }

  /** The minute `t` falls in (the last one at or before it), or -1 before the first. */
  minuteAt(t: number): number {
    let lo = 0;
    let hi = this.n - 1;
    if (hi < 0 || t < this.time[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.time[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The path a minute's price takes, as the clock plays through it: from the open to the high or the
   * low (whichever came first), to the other, to the close. Each turn is part way through the minute,
   * a different part each minute. It's what's drawn as a candle forms, and what orders fill against.
   */
  path(i: number, m: number): [at: number, price: number][] {
    const o = this.o[i][m];
    const h = this.h[i][m];
    const l = this.l[i][m];
    const c = this.c[i][m];
    const a = 0.12 + hash(m, i) * 0.38;
    const b = a + 0.1 + hash(i, m) * (0.86 - a - 0.1);
    const [x, y] = this.highFirst[i][m] ? [h, l] : [l, h];
    return [
      [0, o],
      [a, x],
      [b, y],
      [1, c],
    ];
  }

  /** The bid `frac` of the way through minute `m`. */
  priceAt(i: number, m: number, frac: number): number {
    if (frac <= 0) return this.o[i][m];
    if (frac >= 1) return this.c[i][m];
    const pts = this.path(i, m);
    for (let k = 1; k < pts.length; k++) {
      const [t1, p1] = pts[k];
      if (frac <= t1) {
        const [t0, p0] = pts[k - 1];
        return p0 + ((p1 - p0) * (frac - t0)) / Math.max(1e-9, t1 - t0);
      }
    }
    return this.c[i][m];
  }

  /** The spread in minute `m`, in price. */
  spreadAt(i: number, m: number): number {
    return (this.spread[i][m] / 10) * PAIRS[i].pip;
  }
}
