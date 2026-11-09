// Your trading account at the desk: a balance in dollars, the positions you hold, the orders waiting
// to fill, and every trade you've closed. As the clock plays, `advance` walks each minute's price path
// (Market.path) and fills whatever it crosses in the order it crosses it: a stop loss before a take
// profit if the price got there first, a pending order the moment the price touches it. A price that
// jumps past a stop (a weekend gap) fills it where it lands, worse than asked, the way a real broker does.
//
// Positions close at the bid if you're long and at the ask if you're short, so the spread is a cost
// on every trade. Profit in a pair quoted in another currency (yen for USD/JPY) is turned into
// dollars at the price it closes at.

import { PAIRS } from './pairs';
import type { Market } from './market';

export type Side = 1 | -1;
/** A lot is 100,000 of the base currency. */
export const LOT = 100_000;
/** How much you can trade for each dollar you put up (50:1, a US retail account's most). */
export const LEVERAGE = 50;
/** Below this margin level (equity over margin used), everything's closed. */
export const STOP_OUT = 0.5;
export const START_BALANCE = 10_000;

export interface Position {
  id: number;
  pair: number;
  side: Side;
  units: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  /** When it opened (seconds). */
  at: number;
}

export interface Order {
  id: number;
  pair: number;
  side: Side;
  units: number;
  /** A limit fills at a better price than now, a stop at a worse one (a breakout). */
  kind: 'limit' | 'stop';
  price: number;
  sl: number | null;
  tp: number | null;
  at: number;
}

export type CloseWhy = 'tp' | 'sl' | 'manual' | 'stopout';

export interface Trade {
  id: number;
  pair: number;
  side: Side;
  units: number;
  entry: number;
  exit: number;
  opened: number;
  closed: number;
  pnl: number;
  why: CloseWhy;
}

/** What happened as the clock played, for the screens to say. */
export type Fill = { kind: 'open'; position: Position; from?: Order } | { kind: 'close'; trade: Trade };

export interface Quote {
  bid: number;
  ask: number;
}

/** A profit of `amount` in the pair's quote currency, in dollars, at price `price`. */
export function toUsd(pair: number, amount: number, price: number): number {
  return PAIRS[pair].quote === 'USD' ? amount : amount / price;
}

/** What one pip is worth in dollars on `units`, at `price`. */
export function pipValue(pair: number, units: number, price: number): number {
  return toUsd(pair, PAIRS[pair].pip * units, price);
}

/** The margin `units` of a pair ties up, at `price`. */
export function marginFor(pair: number, units: number, price: number): number {
  return (PAIRS[pair].base === 'USD' ? units : units * price) / LEVERAGE;
}

/** What closing a position at `quote` would make or lose, in dollars. */
export function openPnl(p: Position, q: Quote): number {
  const exit = p.side === 1 ? q.bid : q.ask;
  return toUsd(p.pair, (exit - p.entry) * p.side * p.units, exit);
}

/** A trade's move in pips, from where it went in to where it came out. */
export function pipsOf(pair: number, side: Side, entry: number, exit: number): number {
  return ((exit - entry) * side) / PAIRS[pair].pip;
}

/** Something the price can set off, as a level on the bid and which way the bid has to cross it. */
interface Trigger {
  level: number;
  below: boolean;
  /** At the bid, or at the ask (bid + spread). */
  ask: boolean;
  fire(price: number, at: number): void;
}

export interface Saved {
  balance: number;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  nextId: number;
}

export class Account {
  balance = START_BALANCE;
  positions: Position[] = [];
  orders: Order[] = [];
  trades: Trade[] = [];
  private nextId = 1;
  /** Told each fill as it happens. */
  onFill: (f: Fill) => void = () => {};

  save(): Saved {
    return { balance: this.balance, positions: this.positions, orders: this.orders, trades: this.trades.slice(-500), nextId: this.nextId };
  }

  load(s: Partial<Saved>) {
    if (typeof s.balance === 'number' && Number.isFinite(s.balance)) this.balance = s.balance;
    this.positions = Array.isArray(s.positions) ? s.positions : [];
    this.orders = Array.isArray(s.orders) ? s.orders : [];
    this.trades = Array.isArray(s.trades) ? s.trades : [];
    this.nextId = Math.max(s.nextId ?? 1, 1 + Math.max(0, ...[...this.positions, ...this.orders, ...this.trades].map((x) => x.id)));
  }

  reset() {
    this.load({ balance: START_BALANCE, positions: [], orders: [], trades: [], nextId: 1 });
  }

  /** Buys or sells at the market: at the ask to buy, the bid to sell. */
  market(pair: number, side: Side, units: number, q: Quote, at: number, sl: number | null = null, tp: number | null = null): Position {
    const p: Position = { id: this.nextId++, pair, side, units, entry: side === 1 ? q.ask : q.bid, sl, tp, at };
    this.positions.push(p);
    this.onFill({ kind: 'open', position: p });
    return p;
  }

  /** Leaves an order to fill at `price`: a limit if that's better than the market now, a stop if worse. */
  place(pair: number, side: Side, units: number, price: number, q: Quote, at: number, sl: number | null = null, tp: number | null = null): Order {
    const now = side === 1 ? q.ask : q.bid;
    const kind = side === 1 ? (price < now ? 'limit' : 'stop') : price > now ? 'limit' : 'stop';
    const o: Order = { id: this.nextId++, pair, side, units, kind, price, sl, tp, at };
    this.orders.push(o);
    return o;
  }

  cancel(id: number) {
    this.orders = this.orders.filter((o) => o.id !== id);
  }

  close(id: number, q: Quote, at: number, why: CloseWhy = 'manual', price?: number) {
    const p = this.positions.find((x) => x.id === id);
    if (!p) return;
    const exit = price ?? (p.side === 1 ? q.bid : q.ask);
    const pnl = toUsd(p.pair, (exit - p.entry) * p.side * p.units, exit);
    this.balance += pnl;
    this.positions = this.positions.filter((x) => x !== p);
    const trade: Trade = { id: p.id, pair: p.pair, side: p.side, units: p.units, entry: p.entry, exit, opened: p.at, closed: at, pnl, why };
    this.trades.push(trade);
    this.onFill({ kind: 'close', trade });
  }

  /** Equity: the balance and what the open positions would make if closed now. */
  equity(quote: (pair: number) => Quote): number {
    return this.positions.reduce((s, p) => s + openPnl(p, quote(p.pair)), this.balance);
  }

  marginUsed(quote: (pair: number) => Quote): number {
    return this.positions.reduce((s, p) => s + marginFor(p.pair, p.units, quote(p.pair).bid), 0);
  }

  /** Whether there's anything for the clock to fill or close. */
  get busy(): boolean {
    return this.positions.length > 0 || this.orders.length > 0;
  }

  /**
   * Plays the market from `from` to `to` (minute indexes, with the fraction of the minute), filling
   * and closing whatever the price sets off on the way, in the order it does.
   */
  advance(m: Market, from: number, to: number) {
    if (to <= from) return;
    let minute = Math.floor(from);
    let frac = from - minute;
    while (minute < m.n && minute + frac < to) {
      const end = Math.min(1, to - minute);
      if (this.busy) this.walk(m, minute, frac, end);
      // A margin call at the end of each minute.
      if (this.positions.length) this.checkMargin(m, minute, end);
      minute++;
      frac = 0;
    }
  }

  /** One minute's path from `a` to `b` of the way through it. */
  private walk(m: Market, minute: number, a: number, b: number) {
    const at = m.time[minute];
    for (const pair of new Set([...this.positions, ...this.orders].map((x) => x.pair))) {
      const spread = m.spreadAt(pair, minute);
      const points: [number, number][] = [[a, m.priceAt(pair, minute, a)]];
      for (const [t, p] of m.path(pair, minute)) if (t > a && t < b) points.push([t, p]);
      points.push([b, m.priceAt(pair, minute, b)]);
      // Where the minute opens, if it opens away from the last close (a weekend gap): anything in between fills there.
      if (a === 0 && minute > 0 && m.o[pair][minute] !== m.c[pair][minute - 1]) this.segment(pair, m.c[pair][minute - 1], m.o[pair][minute], spread, at, true);
      for (let k = 1; k < points.length; k++) this.segment(pair, points[k - 1][1], points[k][1], spread, at + points[k][0] * 60, false);
    }
  }

  /** The bid moving from `x` to `y`: fires what it crosses, nearest first. A gap fills everything it jumps at `y`. */
  private segment(pair: number, x: number, y: number, spread: number, at: number, gap: boolean) {
    const fired: { t: number; tr: Trigger }[] = [];
    for (const tr of this.triggers(pair, spread)) {
      const crossed = tr.below ? Math.min(x, y) <= tr.level : Math.max(x, y) >= tr.level;
      if (!crossed) continue;
      const already = tr.below ? x <= tr.level : x >= tr.level;
      const t = already ? 0 : (x - tr.level) / (x - y || 1);
      fired.push({ t, tr });
    }
    fired.sort((p, q) => p.t - q.t);
    for (const { t, tr } of fired) {
      // Only if it's still there: a stop that closed the position takes its take profit with it.
      if (!this.stillThere(tr)) continue;
      const fillBid = gap || t === 0 ? (gap ? y : x) : tr.level;
      tr.fire(fillBid + (tr.ask ? spread : 0), at);
    }
  }

  private readonly live = new WeakSet<Trigger>();

  private stillThere(tr: Trigger): boolean {
    return this.live.has(tr);
  }

  /** What could fire in `pair` now: each position's stop and target, each order's entry. */
  private triggers(pair: number, spread: number): Trigger[] {
    const out: Trigger[] = [];
    const add = (tr: Trigger) => {
      this.live.add(tr);
      out.push(tr);
    };
    for (const p of this.positions) {
      if (p.pair !== pair) continue;
      const long = p.side === 1;
      // A long closes at the bid; a short at the ask, so its levels on the bid are a spread lower.
      const shift = long ? 0 : spread;
      // Its stop and its target: whichever fires first takes the other with it.
      const mine: Trigger[] = [];
      const done = (why: CloseWhy, level: number) => (price: number, at: number) => {
        for (const tr of mine) this.live.delete(tr);
        // A stop fills where the price got to (no better than asked); a target exactly at its price, or better on a gap.
        this.close(p.id, { bid: price, ask: price }, at, why, why === 'tp' ? (long ? Math.max(level, price) : Math.min(level, price)) : price);
      };
      if (p.sl !== null) mine.push({ level: p.sl - shift, below: long, ask: !long, fire: done('sl', p.sl) });
      if (p.tp !== null) mine.push({ level: p.tp - shift, below: !long, ask: !long, fire: done('tp', p.tp) });
      mine.forEach(add);
    }
    for (const o of this.orders) {
      if (o.pair !== pair) continue;
      const buy = o.side === 1;
      const shift = buy ? spread : 0;
      // A buy limit fills when the ask comes down to it, a buy stop when it goes up to it; the other way round to sell.
      const below = (buy && o.kind === 'limit') || (!buy && o.kind === 'stop');
      const tr: Trigger = {
        level: o.price - shift,
        below,
        ask: buy,
        fire: (price, at) => {
          this.live.delete(tr);
          this.orders = this.orders.filter((x) => x !== o);
          const entry = o.kind === 'limit' ? (buy ? Math.min(o.price, price) : Math.max(o.price, price)) : price;
          const p: Position = { id: o.id, pair: o.pair, side: o.side, units: o.units, entry, sl: o.sl, tp: o.tp, at };
          this.positions.push(p);
          this.onFill({ kind: 'open', position: p, from: o });
        },
      };
      add(tr);
    }
    return out;
  }

  /** Closes everything when equity falls under STOP_OUT of the margin in use. */
  private checkMargin(m: Market, minute: number, frac: number) {
    const quote = (pair: number): Quote => {
      const bid = m.priceAt(pair, minute, frac);
      return { bid, ask: bid + m.spreadAt(pair, minute) };
    };
    const used = this.marginUsed(quote);
    if (!used || this.equity(quote) / used >= STOP_OUT) return;
    const at = m.time[minute] + frac * 60;
    for (const p of [...this.positions]) this.close(p.id, quote(p.pair), at, 'stopout');
  }
}
