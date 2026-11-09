// Draws a pair's candles the way a trading platform does (TradingView's dark theme): the price scale
// down the right, the time along the bottom, volume under the candles, the moving averages, your
// positions with their stops and targets, the price now with the time left in the candle, the news
// coming up, and a crosshair. The same drawing goes on a screen up close and on the monitors in the office.

import { EMAS, bucketStart, live, liveEma, tfMinutes, type CandleCache, type Candle, type Tf } from './bars';
import type { Market } from './market';
import { toUsd, openPnl, type Account } from './account';
import { PAIRS, pairName } from './pairs';
import * as fmt from './format';

export const THEME = {
  bg: '#131722',
  grid: 'rgba(42, 46, 57, 0.55)',
  border: '#2a2e39',
  text: '#d1d4dc',
  dim: '#787b86',
  up: '#089981',
  down: '#f23645',
  upVol: 'rgba(8, 153, 129, 0.45)',
  downVol: 'rgba(242, 54, 69, 0.45)',
  blue: '#2962ff',
  orange: '#ff9800',
  cross: '#9598a1',
  crossTag: '#4c525e',
  font: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
};
const EMA_COLOR: Record<number, string> = { 20: THEME.blue, 50: THEME.orange };
const IMPACT = ['', '#f7c948', THEME.orange, THEME.down];

/** How the candles are laid out: how wide each is, and how many candles' room there is right of the newest. */
export interface View {
  spacing: number;
  shift: number;
}
export const defaultView = (): View => ({ spacing: 8, shift: 6 });

export interface Scene {
  market: Market;
  cache: CandleCache;
  account: Account;
  pair: number;
  tf: Tf;
  minute: number;
  frac: number;
  emas: boolean;
  volume: boolean;
  /** The order ticket's lines: where a new order would go in, stop and take profit. */
  draft: { price: number; label: string; color: string }[];
  /** A line being dragged to a new price. */
  dragging: { key: string; price: number } | null;
}

/** A line on the chart you can take hold of: a position's stop or target, or a waiting order. */
export interface Grab {
  key: string;
  kind: 'sl' | 'tp' | 'order' | 'position';
  id: number;
  y: number;
  /** Its ✕, which closes the position or cancels the order. */
  close: { x: number; y: number; w: number; h: number } | null;
}

export interface Painted {
  plot: { w: number; h: number };
  yToPrice(y: number): number;
  grabs: Grab[];
}

export const AXIS_W = 68;
export const AXIS_H = 26;

/** A round step for grid lines about `raw` apart. */
function nice(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** How far apart to label the time axis, in minutes. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 7200, 14400, 43200];

function tag(g: CanvasRenderingContext2D, x: number, y: number, w: number, text: string, bg: string, fg = '#fff', size = 11) {
  const h = size + 7;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x, y - h / 2, w, h, 2);
  g.fill();
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(text, x + 6, y + 0.5);
}

/** Where labels already are, so the next one on a nearby line goes along from them rather than on top. */
type Placed = { x0: number; x1: number; y: number }[];

/** Where a run of labels `w` wide can start on the line at `y`, clear of those placed. */
function clearAt(placed: Placed, y: number, w: number, x = 10): number {
  for (let moved = true; moved; ) {
    moved = false;
    for (const p of placed) {
      if (Math.abs(p.y - y) < 19 && x < p.x1 + 6 && x + w > p.x0) {
        x = p.x1 + 8;
        moved = true;
      }
    }
  }
  return x;
}

/** A label box on a line, at x: returns where it ends. */
function box(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, border: string): number {
  const w = g.measureText(text).width + 12;
  g.fillStyle = bg;
  g.strokeStyle = border;
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(x, y - 9, w, 18, 2);
  g.fill();
  g.stroke();
  g.fillStyle = fg;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(text, x + 6, y + 0.5);
  return x + w;
}

function hline(g: CanvasRenderingContext2D, y: number, w: number, color: string, dash: number[]) {
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.setLineDash(dash);
  g.beginPath();
  g.moveTo(0, Math.round(y) + 0.5);
  g.lineTo(w, Math.round(y) + 0.5);
  g.stroke();
  g.setLineDash([]);
}

export function paintChart(g: CanvasRenderingContext2D, W: number, H: number, s: Scene, v: View, hover: { x: number; y: number } | null = null): Painted {
  const pair = PAIRS[s.pair];
  const font = (size: number, weight = 400) => `${weight} ${size}px ${THEME.font}`;
  const pw = W - AXIS_W;
  const ph = H - AXIS_H;
  g.fillStyle = THEME.bg;
  g.fillRect(0, 0, W, H);

  const cs = s.cache.get(s.pair, s.tf);
  const liveK = cs.of[s.minute];
  const now = live(s.market, cs, s.pair, s.minute, s.frac);
  const candle = (k: number): Candle => (k === liveK ? now : { t: cs.t[k], o: cs.o[k], h: cs.h[k], l: cs.l[k], c: cs.c[k], v: cs.v[k] });
  const xOf = (k: number) => pw - (liveK - k + v.shift + 0.5) * v.spacing;
  const kLo = Math.max(0, Math.floor(liveK + v.shift + 0.5 - pw / v.spacing) - 1);
  const kHi = Math.min(liveK, Math.ceil(liveK + v.shift + 0.5));

  // The price range of the candles in view.
  let lo = Infinity;
  let hi = -Infinity;
  let vmax = 0;
  for (let k = kLo; k <= kHi; k++) {
    const c = candle(k);
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
    vmax = Math.max(vmax, c.v);
  }
  if (!Number.isFinite(lo)) (lo = now.c - pair.pip * 10), (hi = now.c + pair.pip * 10);
  // Your own lines in this pair stay in view, unless one's so far off it would squash the candles flat.
  const span = Math.max(hi - lo, pair.pip * 8);
  // (Not the ticket's draft, or a line being dragged: the scale would jump about under the mouse.)
  const mine: number[] = [];
  for (const p of s.account.positions) if (p.pair === s.pair) mine.push(p.entry, ...[p.sl, p.tp].filter((x): x is number => x !== null));
  for (const o of s.account.orders) if (o.pair === s.pair) mine.push(o.price);
  for (const p of mine) if (p > lo - span * 2 && p < hi + span * 2) (lo = Math.min(lo, p)), (hi = Math.max(hi, p));
  if (hi - lo < pair.pip * 4) (lo -= pair.pip * 2), (hi += pair.pip * 2);
  const top = ph * 0.08;
  const bottom = ph * (s.volume ? 0.8 : 0.92);
  const priceToY = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);
  const yToPrice = (y: number) => lo + ((bottom - y) / (bottom - top)) * (hi - lo);

  // The grid and the price scale.
  g.font = font(11);
  const step = nice(((hi - lo) / (bottom - top)) * 44);
  const ticks: number[] = [];
  for (let p = Math.ceil(yToPrice(ph) / step) * step; p <= yToPrice(0); p += step) ticks.push(p);
  g.strokeStyle = THEME.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (const p of ticks) {
    const y = Math.round(priceToY(p)) + 0.5;
    g.moveTo(0, y);
    g.lineTo(pw, y);
  }
  g.stroke();

  // The time axis: labels a round number of minutes apart, at least ~90 px.
  const tfMin = tfMinutes(s.tf);
  const offset = tfMin >= 240 ? 7200 : 0;
  const every = TIME_STEPS.find((m) => m >= tfMin && (m / tfMin) * v.spacing >= 90) ?? 43200;
  const labels: { x: number; text: string; bold: boolean }[] = [];
  for (let k = kLo; k <= kHi; k++) {
    const t = cs.t[k];
    const x = xOf(k);
    if (x < 0 || x > pw) continue;
    const at = Math.round((t + offset) / 60);
    if (every >= 1440 ? Math.round(at / 1440) % (every / 1440) !== 0 || at % 1440 !== 0 : at % every !== 0) continue;
    const newDay = (t + offset) % 86400 === 0;
    const text = every >= 1440 ? (fmt.dayOfMonth(t + offset) <= every / 1440 ? fmt.monthName(t + offset) : String(fmt.dayOfMonth(t + offset))) : newDay ? fmt.day(t).slice(0, 6) : fmt.clock(t);
    labels.push({ x, text, bold: newDay && every < 1440 });
  }
  g.beginPath();
  for (const l of labels) {
    g.moveTo(Math.round(l.x) + 0.5, 0);
    g.lineTo(Math.round(l.x) + 0.5, ph);
  }
  g.stroke();

  // Volume along the bottom.
  if (s.volume && vmax > 0) {
    const vh = ph * 0.16;
    const bw = Math.max(1, Math.round(v.spacing * 0.7));
    for (let k = kLo; k <= kHi; k++) {
      const c = candle(k);
      const hgt = (c.v / vmax) * vh;
      g.fillStyle = c.c >= c.o ? THEME.upVol : THEME.downVol;
      g.fillRect(Math.round(xOf(k) - bw / 2), ph - hgt, bw, hgt);
    }
  }

  // The candles.
  const bw = Math.max(1, Math.round(v.spacing * 0.72) | 1);
  for (let k = kLo; k <= kHi; k++) {
    const c = candle(k);
    const x = Math.round(xOf(k));
    const color = c.c >= c.o ? THEME.up : THEME.down;
    g.fillStyle = color;
    const yh = priceToY(c.h);
    const yl = priceToY(c.l);
    g.fillRect(x - (v.spacing >= 4 ? 0.5 : 0.5), yh, 1, Math.max(1, yl - yh));
    const yo = priceToY(c.o);
    const yc = priceToY(c.c);
    g.fillRect(x - (bw - 1) / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }

  // The moving averages.
  if (s.emas) {
    for (const period of EMAS) {
      const e = cs.ema.get(period)!;
      g.strokeStyle = EMA_COLOR[period];
      g.lineWidth = 1.5;
      g.beginPath();
      for (let k = kLo; k <= kHi; k++) {
        const val = k === liveK ? liveEma(cs, period, k, now.c) : e[k];
        const y = priceToY(val);
        if (k === kLo) g.moveTo(xOf(k), y);
        else g.lineTo(xOf(k), y);
      }
      g.stroke();
    }
  }

  // News: what's been and what's coming, along the bottom of the candles.
  const nowT = s.market.time[s.minute] + s.frac * 60;
  const liveStart = cs.t[liveK];
  // Along the very bottom, over the volume, as platforms show their economic calendar.
  const newsY = ph - 8;
  const shownNews: { x: number; ev: (typeof s.market.news)[number] }[] = [];
  for (const ev of s.market.news) {
    if (ev.ccy !== pair.base && ev.ccy !== pair.quote) continue;
    let x: number;
    if (ev.time <= nowT) {
      const m = s.market.minuteAt(ev.time);
      if (m < 0) continue;
      x = xOf(cs.of[m]);
    } else x = xOf(liveK) + ((ev.time - liveStart) / (tfMin * 60)) * v.spacing;
    if (x < 4 || x > pw - 4) continue;
    shownNews.push({ x, ev });
    g.beginPath();
    g.arc(x, newsY, 4, 0, Math.PI * 2);
    if (ev.time <= nowT) {
      g.fillStyle = IMPACT[ev.impact];
      g.fill();
    } else {
      g.strokeStyle = IMPACT[ev.impact];
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  // Your positions and orders in this pair, and the ticket's draft lines.
  const grabs: Grab[] = [];
  const q = { bid: now.c, ask: now.c + s.market.spreadAt(s.pair, s.minute) };
  const axisTags: { y: number; text: string; color: string }[] = [];
  g.font = font(11, 600);
  // The legend and the buy and sell buttons have the top left corner.
  const placed: Placed = [16, 35, 54, 80, 100].map((y) => ({ x0: 0, x1: y < 60 ? 420 : 250, y }));
  /** Where a line's labels start: its texts' widths, the ✕ and the gaps, placed clear of the others. */
  const start = (y: number, texts: string[]) => {
    const w = texts.reduce((n, t) => n + g.measureText(t).width + 12, 0);
    const x = clearAt(placed, y, w);
    placed.push({ x0: x, x1: x + w, y });
    return x;
  };
  const lineAt = (key: string, price: number) => (s.dragging?.key === key ? s.dragging.price : price);
  for (const p of s.account.positions) {
    if (p.pair !== s.pair) continue;
    const pnl = openPnl(p, q);
    const y = priceToY(p.entry);
    hline(g, y, pw, THEME.blue, []);
    const head = `${p.side === 1 ? 'LONG' : 'SHORT'} ${(p.units / 100_000).toFixed(2)}`;
    let x = box(g, start(y, [head, fmt.money(pnl, true), '✕✕']), y, head, THEME.blue, '#fff', THEME.blue);
    x = box(g, x, y, fmt.money(pnl, true), THEME.bg, pnl >= 0 ? THEME.up : THEME.down, THEME.blue);
    const cx = x;
    box(g, cx, y, '✕', THEME.bg, THEME.text, THEME.blue);
    grabs.push({ key: `p${p.id}`, kind: 'position', id: p.id, y, close: { x: cx, y: y - 9, w: 22, h: 18 } });
    axisTags.push({ y, text: fmt.price(s.pair, p.entry), color: THEME.blue });
    for (const kind of ['sl', 'tp'] as const) {
      const at = p[kind];
      if (at === null) continue;
      const key = `${kind}${p.id}`;
      const level = lineAt(key, at);
      const ly = priceToY(level);
      const color = kind === 'sl' ? THEME.down : THEME.up;
      hline(g, ly, pw, color, [6, 4]);
      const result = toUsd(p.pair, (level - p.entry) * p.side * p.units, level);
      const after = box(g, start(ly, [kind.toUpperCase(), fmt.money(result, true), '✕✕']), ly, kind.toUpperCase(), color, '#fff', color);
      const end = box(g, after, ly, fmt.money(result, true), THEME.bg, color, color);
      box(g, end, ly, '✕', THEME.bg, THEME.text, color);
      grabs.push({ key, kind, id: p.id, y: ly, close: { x: end, y: ly - 9, w: 22, h: 18 } });
      axisTags.push({ y: ly, text: fmt.price(s.pair, level), color });
    }
  }
  for (const o of s.account.orders) {
    if (o.pair !== s.pair) continue;
    const key = `o${o.id}`;
    const level = lineAt(key, o.price);
    const y = priceToY(level);
    const color = o.side === 1 ? THEME.blue : THEME.down;
    hline(g, y, pw, color, [2, 3]);
    const name = `${o.side === 1 ? 'BUY' : 'SELL'} ${o.kind.toUpperCase()} ${(o.units / 100_000).toFixed(2)}`;
    const x = box(g, start(y, [name, '✕✕']), y, name, color, '#fff', color);
    box(g, x, y, '✕', THEME.bg, THEME.text, color);
    grabs.push({ key, kind: 'order', id: o.id, y, close: { x, y: y - 9, w: 22, h: 18 } });
    axisTags.push({ y, text: fmt.price(s.pair, level), color });
  }
  for (const d of s.draft) {
    const y = priceToY(d.price);
    g.globalAlpha = 0.75;
    hline(g, y, pw, d.color, [4, 4]);
    box(g, start(y, [d.label]), y, d.label, THEME.bg, d.color, d.color);
    g.globalAlpha = 1;
    axisTags.push({ y, text: fmt.price(s.pair, d.price), color: d.color });
  }

  // The price now: a dotted line in the live candle's color, its tag on the scale with the time left in the candle.
  const nowColor = now.c >= now.o ? THEME.up : THEME.down;
  const yNow = priceToY(now.c);
  hline(g, yNow, pw, nowColor, [1, 2]);

  // The scale's own column, over anything that ran into it.
  g.fillStyle = THEME.bg;
  g.fillRect(pw, 0, AXIS_W, H);
  g.fillRect(0, ph, W, AXIS_H);
  g.strokeStyle = THEME.border;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pw + 0.5, 0);
  g.lineTo(pw + 0.5, ph);
  g.moveTo(0, ph + 0.5);
  g.lineTo(W, ph + 0.5);
  g.stroke();
  g.font = font(11);
  g.fillStyle = THEME.dim;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  for (const p of ticks) {
    const y = priceToY(p);
    if (y > 8 && y < ph - 8) g.fillText(fmt.price(s.pair, p), pw + 7, y);
  }
  g.textAlign = 'center';
  for (const l of labels) {
    g.font = font(11, l.bold ? 700 : 400);
    g.fillStyle = l.bold ? THEME.text : THEME.dim;
    g.fillText(l.text, l.x, ph + AXIS_H / 2);
  }
  g.font = font(11);
  for (const t of axisTags) if (t.y > 0 && t.y < ph) tag(g, pw + 1, t.y, AXIS_W - 2, t.text, t.color);
  const left = bucketStart(Math.floor((liveStart + offset) / (tfMin * 60)), tfMin) + tfMin * 60 - nowT;
  tag(g, pw + 1, yNow, AXIS_W - 2, fmt.price(s.pair, now.c), nowColor);
  g.fillStyle = nowColor;
  g.beginPath();
  g.roundRect(pw + 1, yNow + 9, AXIS_W - 2, 16, 2);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'left';
  g.font = font(10);
  g.fillText(fmt.countdown(left), pw + 7, yNow + 17.5);

  // The crosshair, and the candle under it for the legend.
  let legendC = now;
  let legendK = liveK;
  if (hover && hover.x >= 0 && hover.x < pw && hover.y >= 0 && hover.y < ph) {
    const k = Math.round(liveK - v.shift - (pw - hover.x) / v.spacing + 0.5);
    const kk = Math.max(kLo, Math.min(kHi, k));
    legendC = candle(kk);
    legendK = kk;
    const x = xOf(kk);
    g.strokeStyle = THEME.cross;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, 0);
    g.lineTo(Math.round(x) + 0.5, ph);
    g.moveTo(0, Math.round(hover.y) + 0.5);
    g.lineTo(pw, Math.round(hover.y) + 0.5);
    g.stroke();
    g.setLineDash([]);
    g.font = font(11);
    tag(g, pw + 1, hover.y, AXIS_W - 2, fmt.price(s.pair, yToPrice(hover.y)), THEME.crossTag);
    const label = tfMin >= 1440 ? fmt.day(legendC.t + offset) : fmt.stamp(legendC.t);
    const lw = g.measureText(label).width + 14;
    g.fillStyle = THEME.crossTag;
    g.fillRect(Math.min(pw - lw, Math.max(0, x - lw / 2)), ph + 2, lw, AXIS_H - 4);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.fillText(label, Math.min(pw - lw / 2, Math.max(lw / 2, x)), ph + AXIS_H / 2);
  }

  // The legend: the pair and timeframe, the candle's open, high, low and close, the averages, the news.
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  let x = 10;
  const ly = 16;
  g.font = font(13, 600);
  g.fillStyle = THEME.text;
  const title = `${pairName(pair)} · ${s.tf} · FX`;
  g.fillText(title, x, ly);
  x += g.measureText(title).width + 14;
  const col = legendC.c >= legendC.o ? THEME.up : THEME.down;
  g.font = font(12);
  for (const [k, val] of [
    ['O', legendC.o],
    ['H', legendC.h],
    ['L', legendC.l],
    ['C', legendC.c],
  ] as const) {
    g.fillStyle = THEME.dim;
    g.fillText(k, x, ly);
    x += g.measureText(k).width + 3;
    g.fillStyle = col;
    const t = fmt.price(s.pair, val);
    g.fillText(t, x, ly);
    x += g.measureText(t).width + 9;
  }
  const prev = legendK > 0 ? cs.c[legendK - 1] : legendC.o;
  const ch = legendC.c - prev;
  g.fillStyle = col;
  g.fillText(`${ch >= 0 ? '+' : '−'}${fmt.price(s.pair, Math.abs(ch))} (${ch >= 0 ? '+' : '−'}${Math.abs((ch / prev) * 100).toFixed(2)}%)`, x, ly);
  let y2 = ly + 19;
  if (s.emas) {
    let ex = 10;
    for (const period of EMAS) {
      const val = legendK === liveK ? liveEma(cs, period, liveK, now.c) : cs.ema.get(period)![legendK];
      g.fillStyle = THEME.dim;
      const name = `EMA ${period}`;
      g.fillText(name, ex, y2);
      ex += g.measureText(name).width + 5;
      g.fillStyle = EMA_COLOR[period];
      const t = fmt.price(s.pair, val);
      g.fillText(t, ex, y2);
      ex += g.measureText(t).width + 14;
    }
    y2 += 19;
  }
  // The news under the crosshair, or else the next release that moves this pair.
  const near = hover ? shownNews.find((n) => Math.abs(n.x - hover.x) < 7) : undefined;
  const next = near?.ev ?? s.market.news.find((ev) => ev.time > nowT && (ev.ccy === pair.base || ev.ccy === pair.quote));
  if (next) {
    const when = next.time > nowT ? `in ${fmt.countdown(next.time - nowT)}` : fmt.stamp(next.time);
    g.fillStyle = IMPACT[next.impact];
    g.beginPath();
    g.arc(14, y2, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = THEME.dim;
    g.fillText(`${next.ccy} ${next.name} · ${when}`, 24, y2);
  }

  return { plot: { w: pw, h: ph }, yToPrice, grabs };
}
