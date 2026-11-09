// The panel along the bottom of a screen: the account (balance, equity, margin), and tabs for the
// positions you hold, the orders waiting, the trades you've closed with how you're doing overall, and
// the economic calendar.

import { h } from '../../ui/dom';
import { openPnl, pipsOf, STOP_OUT, type Trade } from './account';
import * as fmt from './format';
import { PAIRS, pairName } from './pairs';
import type { Session } from './session';

type Tab = 'positions' | 'orders' | 'history' | 'calendar';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const cls = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const sideTag = (side: number) => `<span class="${side === 1 ? 'up' : 'down'}">${side === 1 ? 'Buy' : 'Sell'}</span>`;

export interface BlotterHooks {
  /** Show this pair on the screen's chart. */
  show(pair: number): void;
  said(text: string, bad?: boolean): void;
}

/** How a run of trades has gone. */
export function stats(trades: readonly Trade[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const won = wins.reduce((s, t) => s + t.pnl, 0);
  const lost = -losses.reduce((s, t) => s + t.pnl, 0);
  let peak = 0;
  let run = 0;
  let drawdown = 0;
  for (const t of trades) {
    run += t.pnl;
    peak = Math.max(peak, run);
    drawdown = Math.max(drawdown, peak - run);
  }
  return {
    n: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    net: won - lost,
    avgWin: wins.length ? won / wins.length : 0,
    avgLoss: losses.length ? lost / losses.length : 0,
    factor: lost ? won / lost : won ? Infinity : 0,
    drawdown,
  };
}

export class Blotter {
  readonly el: HTMLElement;
  private tab: Tab = 'positions';
  private readonly strip = h('div.tx-acct');
  private readonly body = h('div.tx-table');
  private readonly tabs = new Map<Tab, HTMLButtonElement>();
  private last = '';

  constructor(
    private readonly session: Session,
    private readonly hooks: BlotterHooks,
  ) {
    const bar = h('div.tx-tabs');
    for (const t of ['positions', 'orders', 'history', 'calendar'] as const) {
      const b = h('button', { type: 'button', onclick: () => this.show(t) }) as HTMLButtonElement;
      this.tabs.set(t, b);
      bar.append(b);
    }
    this.el = h('div.tx-bottom', {}, this.strip, bar, this.body);
    // One listener for every button the tables draw.
    this.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-do]');
      if (!b) return;
      const id = Number(b.dataset.id);
      const acct = this.session.account;
      const at = this.session.now();
      const pos = acct.positions.find((p) => p.id === id);
      const act = b.dataset.do;
      switch (act) {
        case 'close':
          if (pos) acct.close(id, this.session.quote(pos.pair), at);
          break;
        case 'cancel':
          acct.cancel(id);
          this.hooks.said('Order cancelled');
          break;
        case 'sl':
        case 'tp':
          if (pos) {
            // Twenty pips away to start with: drag it on the chart from there.
            const pip = PAIRS[pos.pair].pip;
            pos[act] = pos.entry + (act === 'tp' ? 1 : -1) * pos.side * 20 * pip;
            this.hooks.show(pos.pair);
          }
          break;
        case 'show':
          this.hooks.show(id);
          break;
        case 'closeall':
          for (const p of [...acct.positions]) acct.close(p.id, this.session.quote(p.pair), at);
          break;
      }
      this.session.changed();
      this.update(true);
    });
    this.show('positions');
  }

  show(t: Tab) {
    this.tab = t;
    for (const [k, b] of this.tabs) b.classList.toggle('on', k === t);
    this.update(true);
  }

  /** Redraws what's changed. */
  update(force = false) {
    const s = this.session;
    const acct = s.account;
    const quote = (i: number) => s.quote(i);
    const equity = acct.equity(quote);
    const used = acct.marginUsed(quote);
    const open = equity - acct.balance;
    const level = used ? equity / used : Infinity;
    const strip = [
      ['Balance', fmt.money(acct.balance), ''],
      ['Equity', fmt.money(equity), ''],
      ['Open P&L', fmt.money(open, true), cls(open)],
      ['Margin', fmt.money(used), ''],
      ['Free margin', fmt.money(equity - used), ''],
      ['Margin level', used ? `${(level * 100).toFixed(0)}%` : '—', level < STOP_OUT * 2 ? 'down' : ''],
    ]
      .map(([k, v, c]) => `<div><span>${k}</span><b class="${c}">${v}</b></div>`)
      .join('');
    const counts = { positions: acct.positions.length, orders: acct.orders.length, history: acct.trades.length };
    const labels: Record<Tab, string> = { positions: `Positions ${counts.positions || ''}`, orders: `Orders ${counts.orders || ''}`, history: 'History', calendar: 'Calendar' };
    for (const [k, b] of this.tabs) b.textContent = labels[k].trim();
    const html = strip + '\u0000' + this.table();
    if (!force && html === this.last) return;
    this.last = html;
    const [a, b] = html.split('\u0000');
    this.strip.innerHTML = a;
    this.body.innerHTML = b;
  }

  private table(): string {
    const s = this.session;
    const acct = s.account;
    if (this.tab === 'positions') {
      if (!acct.positions.length) return `<p class="tx-empty">No open positions. Buy or sell from the ticket on the right, or the buttons on the chart.</p>`;
      const rows = acct.positions.map((p) => {
        const q = s.quote(p.pair);
        const now = p.side === 1 ? q.bid : q.ask;
        const pnl = openPnl(p, q);
        const lvl = (k: 'sl' | 'tp') => (p[k] === null ? `<button class="tx-mini" data-do="${k}" data-id="${p.id}">+ ${k.toUpperCase()}</button>` : fmt.price(p.pair, p[k]!));
        return `<tr><td><a data-do="show" data-id="${p.pair}">${pairName(PAIRS[p.pair])}</a></td><td>${sideTag(p.side)}</td><td>${(p.units / 100_000).toFixed(2)}</td><td>${fmt.price(p.pair, p.entry)}</td><td>${fmt.price(p.pair, now)}</td><td>${lvl('sl')}</td><td>${lvl('tp')}</td><td class="${cls(pnl)}">${fmt.pips(pipsOf(p.pair, p.side, p.entry, now))}</td><td class="${cls(pnl)}"><b>${fmt.money(pnl, true)}</b></td><td><button class="tx-mini" data-do="close" data-id="${p.id}">Close</button></td></tr>`;
      });
      return `<table><thead><tr><th>Symbol</th><th>Side</th><th>Lots</th><th>Entry</th><th>Price</th><th>Stop loss</th><th>Take profit</th><th>Pips</th><th>P&amp;L</th><th>${acct.positions.length > 1 ? '<button class="tx-mini" data-do="closeall">Close all</button>' : ''}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    if (this.tab === 'orders') {
      if (!acct.orders.length) return `<p class="tx-empty">No orders waiting. Switch the ticket to Limit / Stop to leave one at a price.</p>`;
      const rows = acct.orders.map((o) => {
        const q = s.quote(o.pair);
        const away = Math.abs((o.side === 1 ? q.ask : q.bid) - o.price) / PAIRS[o.pair].pip;
        return `<tr><td><a data-do="show" data-id="${o.pair}">${pairName(PAIRS[o.pair])}</a></td><td>${sideTag(o.side)} ${o.kind}</td><td>${(o.units / 100_000).toFixed(2)}</td><td>${fmt.price(o.pair, o.price)}</td><td>${away.toFixed(1)} pips away</td><td>${o.sl === null ? '—' : fmt.price(o.pair, o.sl)}</td><td>${o.tp === null ? '—' : fmt.price(o.pair, o.tp)}</td><td>${fmt.stamp(o.at)}</td><td><button class="tx-mini" data-do="cancel" data-id="${o.id}">Cancel</button></td></tr>`;
      });
      return `<table><thead><tr><th>Symbol</th><th>Type</th><th>Lots</th><th>Price</th><th>Distance</th><th>Stop loss</th><th>Take profit</th><th>Placed</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    if (this.tab === 'history') {
      if (!acct.trades.length) return `<p class="tx-empty">No closed trades yet.</p>`;
      const st = stats(acct.trades);
      const why = { tp: 'Take profit', sl: 'Stop loss', manual: 'Closed', stopout: 'Stopped out' };
      const head = `<div class="tx-stats"><span>Trades <b>${st.n}</b></span><span>Win rate <b>${(st.winRate * 100).toFixed(0)}%</b></span><span>Net <b class="${cls(st.net)}">${fmt.money(st.net, true)}</b></span><span>Avg win <b class="up">${fmt.money(st.avgWin)}</b></span><span>Avg loss <b class="down">${fmt.money(st.avgLoss)}</b></span><span>Profit factor <b>${Number.isFinite(st.factor) ? st.factor.toFixed(2) : '∞'}</b></span><span>Max drawdown <b>${fmt.money(st.drawdown)}</b></span></div>`;
      const rows = [...acct.trades]
        .reverse()
        .slice(0, 100)
        .map((t) => `<tr><td>${pairName(PAIRS[t.pair])}</td><td>${sideTag(t.side)}</td><td>${(t.units / 100_000).toFixed(2)}</td><td>${fmt.price(t.pair, t.entry)}</td><td>${fmt.price(t.pair, t.exit)}</td><td class="${cls(t.pnl)}">${fmt.pips(pipsOf(t.pair, t.side, t.entry, t.exit))}</td><td class="${cls(t.pnl)}"><b>${fmt.money(t.pnl, true)}</b></td><td>${why[t.why]}</td><td>${fmt.countdown(t.closed - t.opened)} held</td><td>${fmt.stamp(t.closed)}</td></tr>`);
      return `${head}<table><thead><tr><th>Symbol</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Pips</th><th>P&amp;L</th><th>Closed by</th><th>Held</th><th>Closed</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    const now = s.now();
    const list = s.market.news.filter((e) => e.time > now - 6 * 3600 && e.time < now + 36 * 3600);
    if (!list.length) return `<p class="tx-empty">Nothing on the calendar for the next day and a half.</p>`;
    const rows = list.map((e) => {
      const dots = '●'.repeat(e.impact) + '○'.repeat(3 - e.impact);
      const when = e.time > now ? `in ${fmt.countdown(e.time - now)}` : 'out';
      return `<tr class="${e.time <= now ? 'past' : ''}"><td>${fmt.stamp(e.time)}</td><td><b>${e.ccy}</b></td><td class="impact-${e.impact}">${dots}</td><td>${esc(e.name)}</td><td>${when}</td></tr>`;
    });
    return `<table><thead><tr><th>Time (UTC)</th><th>Currency</th><th>Impact</th><th>Event</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
}
