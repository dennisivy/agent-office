// A session at the trading desk: one made-up market, one clock that plays every pair at once, and
// your account. The clock only runs while you're at the desk, as fast as you set it: real time, or a
// minute, five minutes, an hour or four hours of market a second. "Run to result" plays flat out until
// nothing's left open, and anything filling or closing pauses it so you see what happened.
//
// It's kept in this browser between visits (the market's seed and where its clock is, the account,
// what each screen shows), so a market and its trades are still there next time.

import { Account, type Fill, type Quote, type Saved } from './account';
import { CandleCache, tfMinutes, type Tf } from './bars';
import { Market } from './market';
import { PAIRS } from './pairs';

const KEY = 'agent-office:trading';
/** Days of market behind the clock when it starts, and how far ahead of it the market's always made. */
const HISTORY = 30;
const AHEAD = 2;

export const SPEEDS = [
  { label: '1×', perSec: 1 / 60 },
  { label: '10×', perSec: 10 / 60 },
  { label: '1m/s', perSec: 1 },
  { label: '5m/s', perSec: 5 },
  { label: '1h/s', perSec: 60 },
  { label: '4h/s', perSec: 240 },
] as const;
/** The speed "run to result" plays at. */
const RUN_SPEED = 5;

export interface ScreenSetup {
  pair: number;
  tf: Tf;
  emas: boolean;
  volume: boolean;
}

/** What each monitor shows when you first sit down, left to right. */
const SCREENS: ScreenSetup[] = [
  { pair: 0, tf: '15m', emas: true, volume: true },
  { pair: 1, tf: '5m', emas: true, volume: true },
  { pair: 2, tf: '1h', emas: true, volume: true },
  { pair: 4, tf: '4h', emas: true, volume: true },
];

interface Stored {
  seed: number;
  cur: number;
  speed: number;
  pauseOnFill: boolean;
  account: Saved;
  screens: ScreenSetup[];
}

export class Session {
  market!: Market;
  cache!: CandleCache;
  readonly account = new Account();
  /** Where the clock is: a minute of the market, and how far through it. */
  cur = 0;
  playing = false;
  speed = 2;
  /** Playing flat out until nothing's open. */
  running = false;
  pauseOnFill = true;
  screens: ScreenSetup[] = SCREENS.map((s) => ({ ...s }));
  /** Told about each fill, to show it. */
  onFill: (f: Fill) => void = () => {};
  /** Bumped by anything the screens show changing. */
  version = 0;
  private dirty = false;

  constructor() {
    this.account.onFill = (f) => {
      this.onFill(f);
      if (this.pauseOnFill && !this.running) this.playing = false;
      this.dirty = true;
    };
    const saved = this.read();
    if (saved && this.restore(saved)) return;
    this.fresh();
  }

  private read(): Partial<Stored> | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  }

  private restore(s: Partial<Stored>): boolean {
    if (typeof s.seed !== 'number' || typeof s.cur !== 'number' || !Number.isFinite(s.cur)) return false;
    this.start(s.seed);
    while (this.market.n < s.cur + AHEAD * 1440) this.market.extend(AHEAD);
    this.cur = s.cur;
    if (typeof s.speed === 'number' && SPEEDS[s.speed]) this.speed = s.speed;
    if (typeof s.pauseOnFill === 'boolean') this.pauseOnFill = s.pauseOnFill;
    if (s.account) this.account.load(s.account);
    if (Array.isArray(s.screens) && s.screens.length === SCREENS.length) {
      this.screens = s.screens.map((x, i) => (PAIRS[x?.pair] && x.tf ? { ...SCREENS[i], ...x } : { ...SCREENS[i] }));
    }
    return true;
  }

  private start(seed: number) {
    this.market = new Market(seed);
    this.market.extend(HISTORY + AHEAD);
    this.cache = new CandleCache(this.market);
  }

  /** A new market, somewhere new in its week, with the account carried over. */
  fresh() {
    this.start((Math.random() * 2 ** 31) | 0);
    // Somewhere in the day after the history, on the minute.
    this.cur = HISTORY * 1440 + Math.floor(Math.random() * 1200);
    this.playing = false;
    this.running = false;
    this.changed();
  }

  /** Closes everything at the market and starts on a new one. */
  newMarket() {
    for (const p of [...this.account.positions]) this.account.close(p.id, this.quote(p.pair), this.now());
    this.account.orders = [];
    this.fresh();
    this.save();
  }

  resetAccount() {
    this.account.reset();
    this.changed();
    this.save();
  }

  get minute(): number {
    return Math.floor(this.cur);
  }

  get frac(): number {
    return this.cur - Math.floor(this.cur);
  }

  /** The time on the clock, in seconds. */
  now(): number {
    return this.market.time[this.minute] + this.frac * 60;
  }

  quote(pair: number): Quote {
    const bid = this.market.priceAt(pair, this.minute, this.frac);
    return { bid, ask: bid + this.market.spreadAt(pair, this.minute) };
  }

  changed() {
    this.dirty = true;
    this.version++;
  }

  /** Plays the clock on by `dt` seconds of your time, if it's playing. */
  tick(dt: number) {
    if (!this.playing) return;
    const perSec = this.running ? SPEEDS[RUN_SPEED].perSec : SPEEDS[this.speed].perSec;
    this.advanceTo(this.cur + perSec * Math.min(dt, 0.1));
    if (this.running && !this.account.busy) {
      this.running = false;
      this.playing = false;
    }
  }

  private advanceTo(to: number) {
    // Keep the market made ahead of the clock.
    while (this.market.n - 2 < to + 1440) this.market.extend(AHEAD);
    const from = this.cur;
    this.cur = to;
    this.account.advance(this.market, from, to);
    this.changed();
  }

  /** Plays on to the end of the candle the clock is in, on a screen showing `tf`. */
  step(tf: Tf) {
    const sec = tfMinutes(tf) * 60;
    const offset = tfMinutes(tf) >= 240 ? 7200 : 0;
    const end = (Math.floor((this.now() + offset) / sec) + 1) * sec - offset;
    while (this.market.n - 2 < this.cur + tfMinutes(tf) + 1440) this.market.extend(AHEAD);
    // The first minute at or after the candle's end (over a weekend, the one the market opens with).
    const m = this.market.minuteAt(end - 1) + 1;
    this.playing = false;
    this.advanceTo(Math.max(this.cur, m));
  }

  play(on = !this.playing) {
    this.playing = on;
    if (!on) this.running = false;
    this.changed();
  }

  setSpeed(i: number) {
    this.speed = i;
    this.running = false;
    this.changed();
  }

  /** Plays flat out until every position's closed and every order's filled or cancelled. */
  runToResult() {
    if (!this.account.busy) return;
    this.running = true;
    this.playing = true;
    this.changed();
  }

  /** Saves, if anything's changed since last time. */
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const s: Stored = { seed: this.market.seed, cur: this.cur, speed: this.speed, pauseOnFill: this.pauseOnFill, account: this.account.save(), screens: this.screens };
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // Out of room or blocked: it lasts as long as the page does.
    }
  }
}
