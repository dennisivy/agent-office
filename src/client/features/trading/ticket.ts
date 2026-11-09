// The order ticket down the right of a screen, laid out like a broker's: the sell and buy prices big,
// one click to trade at the market, or a price to leave an order at; how big, and a take profit and a
// stop loss in pips, with what each would make or lose and how much of the account is at risk.

import { h } from '../../ui/dom';
import { LOT, marginFor, pipValue, type Side } from './account';
import * as fmt from './format';
import { PAIRS } from './pairs';
import type { Session } from './session';
import { THEME } from './chartdraw';

/** A price as a broker shows it: the big figure small, the pips big, the tenth of a pip raised. */
export function bigPrice(pair: number, p: number): HTMLElement {
  const s = fmt.price(pair, p);
  return h('span.tx-px', {}, s.slice(0, -3), h('b', {}, s.slice(-3, -1)), h('sup', {}, s.slice(-1)));
}

export class Ticket {
  readonly el: HTMLElement;
  mode: 'market' | 'pending' = 'market';
  lots = 0.1;
  tp = { on: true, pips: 20 };
  sl = { on: true, pips: 10 };
  entry: number | null = null;
  /** The side under the mouse, whose stop and target the chart shows as a draft. */
  hoverSide: Side | null = null;
  private readonly sellPx = h('div.tx-big');
  private readonly buyPx = h('div.tx-big');
  private readonly sellKind = h('span', {}, 'SELL');
  private readonly buyKind = h('span', {}, 'BUY');
  private readonly spread = h('div.tx-spread');
  private readonly units = h('div.tx-note');
  private readonly tpNote = h('div.tx-note');
  private readonly slNote = h('div.tx-note');
  private readonly risk = h('div.tx-risk');
  private readonly entryRow: HTMLElement;
  private readonly entryInput = h('input', { type: 'number', step: 'any' }) as HTMLInputElement;
  private readonly tabs: HTMLButtonElement[];

  constructor(
    private readonly session: Session,
    private readonly pair: () => number,
    private readonly said: (text: string, bad?: boolean) => void,
  ) {
    const number = (value: number, step: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', step: String(step), min: '0', value: String(value) }) as HTMLInputElement;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= 0) set(v);
      });
      return input;
    };
    const lotsInput = number(this.lots, 0.01, (v) => (this.lots = Math.min(50, Math.max(0.01, v))));
    const nudge = (by: number) => {
      this.lots = Math.round(Math.min(50, Math.max(0.01, this.lots + by)) * 100) / 100;
      lotsInput.value = this.lots.toFixed(2);
    };
    const check = (on: boolean, set: (v: boolean) => void) => {
      const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
      c.checked = on;
      c.addEventListener('change', () => set(c.checked));
      return c;
    };
    this.entryInput.addEventListener('input', () => {
      const v = Number(this.entryInput.value);
      if (Number.isFinite(v) && v > 0) this.entry = v;
    });
    const step = (pips: number) => {
      const p = PAIRS[this.pair()];
      this.entry = (this.entry ?? this.session.quote(this.pair()).bid) + pips * p.pip;
      this.entryInput.value = fmt.price(this.pair(), this.entry);
    };
    this.entryRow = h(
      'label.tx-field',
      {},
      h('span', {}, 'Price'),
      h('div.tx-step', {}, h('button', { type: 'button', onclick: () => step(-1) }, '−'), this.entryInput, h('button', { type: 'button', onclick: () => step(1) }, '+')),
    );
    const side = (s: Side, kind: HTMLElement, px: HTMLElement) =>
      h(
        `button.tx-side.${s === 1 ? 'buy' : 'sell'}`,
        { type: 'button', onclick: () => this.trade(s), onmouseenter: () => (this.hoverSide = s), onmouseleave: () => (this.hoverSide = null) },
        kind,
        px,
      );
    this.tabs = (['market', 'pending'] as const).map((m) =>
      h('button', { type: 'button', onclick: () => this.setMode(m) }, m === 'market' ? 'Market' : 'Limit / Stop'),
    ) as HTMLButtonElement[];
    this.el = h(
      'div.tx-ticket',
      {},
      h('div.tx-tabs2', {}, ...this.tabs),
      h('div.tx-sides', {}, side(-1, this.sellKind, this.sellPx), this.spread, side(1, this.buyKind, this.buyPx)),
      this.entryRow,
      h(
        'label.tx-field',
        {},
        h('span', {}, 'Size (lots)'),
        h('div.tx-step', {}, h('button', { type: 'button', onclick: () => nudge(-0.01) }, '−'), lotsInput, h('button', { type: 'button', onclick: () => nudge(0.01) }, '+')),
      ),
      this.units,
      h('label.tx-field.tx-check', {}, check(this.tp.on, (v) => (this.tp.on = v)), h('span', { style: `color:${THEME.up}` }, 'Take profit'), number(this.tp.pips, 1, (v) => (this.tp.pips = v)), h('em', {}, 'pips')),
      this.tpNote,
      h('label.tx-field.tx-check', {}, check(this.sl.on, (v) => (this.sl.on = v)), h('span', { style: `color:${THEME.down}` }, 'Stop loss'), number(this.sl.pips, 1, (v) => (this.sl.pips = v)), h('em', {}, 'pips')),
      this.slNote,
      this.risk,
    );
    this.setMode('market');
  }

  setMode(m: 'market' | 'pending') {
    this.mode = m;
    this.tabs.forEach((t, i) => t.classList.toggle('on', (i === 0) === (m === 'market')));
    this.entryRow.style.display = m === 'pending' ? '' : 'none';
    if (m === 'pending') {
      // Ten pips under the market to start with: a buy limit, or a sell stop.
      const pair = this.pair();
      this.entry = this.session.quote(pair).bid - 10 * PAIRS[pair].pip;
      this.entryInput.value = fmt.price(pair, this.entry);
    }
  }

  /** A new pair: no price left over from the last one. */
  pairChanged() {
    if (this.mode === 'pending') this.setMode('pending');
  }

  /** Where a trade on `side` would go in, its stop and its target. */
  plan(side: Side): { entry: number; sl: number | null; tp: number | null } {
    const pair = this.pair();
    const pip = PAIRS[pair].pip;
    const q = this.session.quote(pair);
    const entry = this.mode === 'pending' && this.entry !== null ? this.entry : side === 1 ? q.ask : q.bid;
    return {
      entry,
      tp: this.tp.on && this.tp.pips > 0 ? entry + side * this.tp.pips * pip : null,
      sl: this.sl.on && this.sl.pips > 0 ? entry - side * this.sl.pips * pip : null,
    };
  }

  /** The lines the chart shows for what the ticket would do. */
  draft(): { price: number; label: string; color: string }[] {
    const out: { price: number; label: string; color: string }[] = [];
    const s = this.hoverSide;
    if (this.mode === 'pending' && this.entry !== null) out.push({ price: this.entry, label: 'ORDER', color: THEME.dim });
    if (s === null) return out;
    const p = this.plan(s);
    if (p.tp !== null) out.push({ price: p.tp, label: `TP ${this.tp.pips}`, color: THEME.up });
    if (p.sl !== null) out.push({ price: p.sl, label: `SL ${this.sl.pips}`, color: THEME.down });
    return out;
  }

  trade(side: Side) {
    const session = this.session;
    const pair = this.pair();
    const q = session.quote(pair);
    const units = Math.round(this.lots * 100) * (LOT / 100);
    const p = this.plan(side);
    const quote = (i: number) => session.quote(i);
    const need = marginFor(pair, units, q.bid);
    const free = session.account.equity(quote) - session.account.marginUsed(quote);
    if (need > free) {
      this.said(`Not enough margin: ${fmt.lots(units)} needs ${fmt.money(need)}, you have ${fmt.money(Math.max(0, free))} free`, true);
      return;
    }
    const name = `${side === 1 ? 'Buy' : 'Sell'} ${fmt.lots(units)} ${PAIRS[pair].base}/${PAIRS[pair].quote}`;
    if (this.mode === 'market') {
      const pos = session.account.market(pair, side, units, q, session.now(), p.sl, p.tp);
      this.said(`${name} at ${fmt.price(pair, pos.entry)}`);
    } else {
      const o = session.account.place(pair, side, units, p.entry, q, session.now(), p.sl, p.tp);
      this.said(`${name} ${o.kind} at ${fmt.price(pair, o.price)} placed`);
    }
    session.changed();
  }

  /** The live prices and what the numbers come to. */
  update() {
    const pair = this.pair();
    const q = this.session.quote(pair);
    this.sellPx.replaceChildren(bigPrice(pair, q.bid));
    this.buyPx.replaceChildren(bigPrice(pair, q.ask));
    this.spread.textContent = ((q.ask - q.bid) / PAIRS[pair].pip).toFixed(1);
    if (this.mode === 'pending' && this.entry !== null) {
      this.buyKind.textContent = this.entry < q.ask ? 'BUY LIMIT' : 'BUY STOP';
      this.sellKind.textContent = this.entry > q.bid ? 'SELL LIMIT' : 'SELL STOP';
    } else {
      this.buyKind.textContent = 'BUY';
      this.sellKind.textContent = 'SELL';
    }
    const units = Math.round(this.lots * 100) * (LOT / 100);
    const pv = pipValue(pair, units, q.bid);
    this.units.textContent = `${units.toLocaleString('en-US')} ${PAIRS[pair].base} · ${fmt.money(pv)} a pip · margin ${fmt.money(marginFor(pair, units, q.bid))}`;
    this.tpNote.textContent = this.tp.on ? `+${fmt.money(this.tp.pips * pv)}` : 'off';
    this.slNote.textContent = this.sl.on ? `−${fmt.money(this.sl.pips * pv)}` : 'off';
    const equity = this.session.account.equity((i) => this.session.quote(i));
    const risk = this.sl.on ? this.sl.pips * pv : NaN;
    this.risk.textContent = Number.isFinite(risk)
      ? `Risking ${fmt.money(risk)} (${((risk / Math.max(1, equity)) * 100).toFixed(2)}%)${this.tp.on && this.sl.pips ? ` for ${(this.tp.pips / this.sl.pips).toFixed(1)}R` : ''}`
      : 'No stop loss: the risk is open-ended';
    this.risk.classList.toggle('bad', !Number.isFinite(risk) || risk / Math.max(1, equity) > 0.02);
  }
}
