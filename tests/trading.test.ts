import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, closed } from '../src/client/features/trading/market';
import { CandleCache, live } from '../src/client/features/trading/bars';
import { Account, LOT, pipValue, type Quote } from '../src/client/features/trading/account';
import { PAIRS } from '../src/client/features/trading/pairs';

const EUR = 0;
const GBP = 1;
const JPY = 2;

function hourlyReturns(m: Market, pair: number): number[] {
  const out: number[] = [];
  for (let i = 60; i < m.n; i += 60) out.push((m.c[pair][i] - m.c[pair][i - 60]) / PAIRS[pair].pip);
  return out;
}
const sd = (xs: number[]) => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
};
const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let ab = 0;
  for (let i = 0; i < a.length; i++) ab += (a[i] - ma) * (b[i] - mb);
  return ab / a.length / (sd(a) * sd(b));
};

test('the same seed makes the same market', () => {
  const a = new Market(42);
  const b = new Market(42);
  a.extend(2);
  b.extend(2);
  assert.equal(a.n, b.n);
  assert.deepEqual([...a.c[EUR].subarray(0, a.n)], [...b.c[EUR].subarray(0, b.n)]);
  assert.notDeepEqual([...new Market(43).c[EUR]], [...a.c[EUR].subarray(0, 10)]);
});

test('the fake market moves about as far as the real one, and the pairs move together', () => {
  const m = new Market(7);
  m.extend(40);
  const eur = hourlyReturns(m, EUR);
  const gbp = hourlyReturns(m, GBP);
  // Real EUR/USD moves about 7.6 pips an hour; a month of fake hours should land near that.
  assert.ok(sd(eur) > 4.5 && sd(eur) < 12, `EUR/USD hourly ${sd(eur).toFixed(1)} pips`);
  assert.ok(corr(eur, gbp) > 0.6, `EUR/GBP correlation ${corr(eur, gbp).toFixed(2)}`);
  for (let i = 0; i < m.n; i++) {
    assert.ok(m.h[EUR][i] >= Math.max(m.o[EUR][i], m.c[EUR][i]) - 1e-9 && m.l[EUR][i] <= Math.min(m.o[EUR][i], m.c[EUR][i]) + 1e-9);
  }
  // Prices are on a tenth of a pip.
  const step = PAIRS[JPY].pip / 10;
  assert.ok(Math.abs(m.c[JPY][100] / step - Math.round(m.c[JPY][100] / step)) < 1e-3);
});

test('the market is shut at the weekend', () => {
  const m = new Market(3);
  m.extend(8);
  for (let i = 0; i < m.n; i++) assert.equal(closed(m.time[i]), false);
  // Eight trading days run over a weekend: somewhere there's a gap of two days between minutes.
  let gap = 0;
  for (let i = 1; i < m.n; i++) gap = Math.max(gap, m.time[i] - m.time[i - 1]);
  assert.equal(gap, 2 * 86400 + 60);
});

test('daily candles open at the 22:00 UTC rollover, and the live one never shows the future', () => {
  const m = new Market(5);
  m.extend(6);
  const cs = new CandleCache(m).get(EUR, 'D');
  for (let k = 0; k < cs.n; k++) assert.equal(new Date(cs.t[k] * 1000).getUTCHours(), 22);
  const minute = cs.first[3] + 300;
  const c = live(m, cs, EUR, minute, 0.5);
  let hi = -Infinity;
  for (let i = cs.first[3]; i < minute; i++) hi = Math.max(hi, m.h[EUR][i]);
  assert.ok(c.h >= hi - 1e-9 && c.h <= Math.max(hi, m.h[EUR][minute]) + 1e-9);
  assert.equal(c.o, cs.o[3]);
});

/** A market whose EUR/USD minutes from `at` on are exactly `bars` (open, high, low, close, high first?), with a 1-pip spread. */
function scripted(bars: [number, number, number, number, boolean][]) {
  const m = new Market(1);
  m.extend(1);
  bars.forEach(([o, h, l, c, hf], i) => {
    m.o[EUR][i] = o;
    m.h[EUR][i] = h;
    m.l[EUR][i] = l;
    m.c[EUR][i] = c;
    m.highFirst[EUR][i] = hf ? 1 : 0;
    m.spread[EUR][i] = 10;
  });
  return m;
}
const q = (bid: number): Quote => ({ bid, ask: bid + 0.0001 });

test('a take profit closes at its price, and pays what the pips are worth', () => {
  const m = scripted([[1.1, 1.1025, 1.0995, 1.102, true]]);
  const a = new Account();
  a.market(EUR, 1, LOT, q(1.1), 0, 1.09, 1.102);
  a.advance(m, 0, 1);
  assert.equal(a.positions.length, 0);
  const t = a.trades[0];
  assert.equal(t.why, 'tp');
  assert.ok(Math.abs(t.exit - 1.102) < 1e-9);
  // Bought at the ask (1.1001), out at 1.1020: 19 pips of a lot at $10 a pip.
  assert.ok(Math.abs(t.pnl - 190) < 0.01, `pnl ${t.pnl}`);
  assert.ok(Math.abs(pipValue(EUR, LOT, 1.1) - 10) < 1e-9);
});

test('when a minute reaches both, the stop goes first if the low came first', () => {
  const m = scripted([[1.1, 1.103, 1.097, 1.1, false]]);
  const a = new Account();
  a.market(EUR, 1, LOT, q(1.1), 0, 1.098, 1.102);
  a.advance(m, 0, 1);
  assert.equal(a.trades[0].why, 'sl');
  assert.equal(a.trades.length, 1);
  assert.ok(a.balance < 10_000);
});

test('a short closes at the ask, so it pays the spread', () => {
  const m = scripted([[1.1, 1.1, 1.1, 1.1, true]]);
  const a = new Account();
  const p = a.market(EUR, -1, LOT, q(1.1), 0);
  assert.equal(p.entry, 1.1);
  a.close(p.id, q(1.1), 60);
  assert.ok(Math.abs(a.trades[0].pnl + 10) < 0.01, `pnl ${a.trades[0].pnl}`);
  void m;
});

test('a buy limit fills when the ask comes down to it, then rides on to its target', () => {
  const m = scripted([
    [1.1, 1.1005, 1.098, 1.0985, true],
    [1.0985, 1.1015, 1.0984, 1.101, false],
  ]);
  const a = new Account();
  a.place(EUR, 1, LOT, 1.099, q(1.1), 0, null, 1.101);
  assert.equal(a.orders[0].kind, 'limit');
  a.advance(m, 0, 2);
  assert.equal(a.orders.length, 0);
  assert.equal(a.trades[0].why, 'tp');
  assert.ok(Math.abs(a.trades[0].entry - 1.099) < 1e-9);
});

test('a price that jumps past a stop fills it where it lands', () => {
  const m = scripted([
    [1.1, 1.1, 1.1, 1.1, true],
    [1.095, 1.096, 1.094, 1.095, true],
  ]);
  const a = new Account();
  a.market(EUR, 1, LOT, q(1.1), 0, 1.098, null);
  a.advance(m, 0, 2);
  assert.equal(a.trades[0].why, 'sl');
  assert.ok(Math.abs(a.trades[0].exit - 1.095) < 1e-9, `exit ${a.trades[0].exit}`);
});

test('the account is stopped out when equity falls under half the margin', () => {
  const m = scripted([[1.1, 1.1, 1.05, 1.05, false]]);
  const a = new Account();
  // 40 lots of EUR/USD at 50:1 ties up $88,000 of margin on a $10,000 account: well past what's allowed,
  // and a 500-pip drop is far more than it can stand.
  a.market(EUR, 1, 4 * LOT, q(1.1), 0);
  a.advance(m, 0, 1);
  assert.equal(a.positions.length, 0);
  assert.equal(a.trades[0].why, 'stopout');
});
