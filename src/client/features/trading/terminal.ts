// One screen at the desk: a trading platform with a pair's chart, the clock's controls along the top,
// the order ticket down the right and your account along the bottom. Every screen trades the same
// account on the same clock; each shows its own pair and timeframe.

import { h } from '../../ui/dom';
import { TIMEFRAMES, type Tf } from './bars';
import { Blotter } from './blotter';
import { ChartPane } from './chart';
import * as fmt from './format';
import { PAIRS, pairName } from './pairs';
import { SPEEDS, type ScreenSetup, type Session } from './session';
import { Ticket, bigPrice } from './ticket';

export class Terminal {
  readonly el: HTMLElement;
  readonly chart: ChartPane;
  readonly ticket: Ticket;
  readonly blotter: Blotter;
  private readonly symbol = h('button.tx-symbol', { type: 'button' });
  private readonly pairMenu = h('div.tx-menu.tx-pairs');
  private readonly moreMenu = h('div.tx-menu.tx-more');
  private readonly tfButtons = new Map<Tf, HTMLButtonElement>();
  private readonly emaBtn = h('button.tx-btn', { type: 'button' }, 'EMA 20/50');
  private readonly volBtn = h('button.tx-btn', { type: 'button' }, 'Volume');
  private readonly playBtn = h('button.tx-play', { type: 'button', title: 'Play / pause (Space)' });
  private readonly speedBtns: HTMLButtonElement[];
  private readonly runBtn = h('button.tx-btn.tx-run', { type: 'button', title: 'Play fast until everything open has closed (R)' }, '⚡ Run to result');
  private readonly clock = h('div.tx-clock');
  private readonly quickSell = h('span');
  private readonly quickBuy = h('span');
  private readonly quickSpread = h('span.tx-qs');
  private readonly toasts = h('div.tx-toasts');
  private pauseBox!: HTMLInputElement;
  private slow = 0;

  constructor(
    private readonly session: Session,
    private readonly index: number,
  ) {
    const said = (text: string, bad = false) => this.say(text, bad);
    this.ticket = new Ticket(session, () => this.setup.pair, said);
    this.chart = new ChartPane({
      scene: () => ({ market: session.market, cache: session.cache, account: session.account, pair: this.setup.pair, tf: this.setup.tf, minute: session.minute, frac: session.frac, emas: this.setup.emas, volume: this.setup.volume, draft: this.ticket.draft() }),
      moved: (g, price) => {
        const acct = session.account;
        if (g.kind === 'order') {
          const o = acct.orders.find((x) => x.id === g.id);
          if (o) {
            const q = session.quote(o.pair);
            // Dragged to the other side of the market, a limit becomes a stop and back.
            const now = o.side === 1 ? q.ask : q.bid;
            o.kind = o.side === 1 ? (price < now ? 'limit' : 'stop') : price > now ? 'limit' : 'stop';
            o.price = price;
          }
        } else if (g.kind === 'sl' || g.kind === 'tp') {
          const p = acct.positions.find((x) => x.id === g.id);
          if (p) p[g.kind] = price;
        }
        session.changed();
      },
      closed: (g) => {
        const acct = session.account;
        if (g.kind === 'position') {
          const p = acct.positions.find((x) => x.id === g.id);
          if (p) acct.close(p.id, session.quote(p.pair), session.now());
        } else if (g.kind === 'order') acct.cancel(g.id);
        else {
          const p = acct.positions.find((x) => x.id === g.id);
          if (p) p[g.kind] = null;
        }
        session.changed();
      },
    });
    this.blotter = new Blotter(session, { show: (pair) => this.setPair(pair), said });

    // Along the top: the pair, the timeframe, what's drawn, then the clock's controls.
    this.symbol.addEventListener('click', (e) => {
      e.stopPropagation();
      this.moreMenu.classList.remove('open');
      this.fillPairs();
      this.pairMenu.classList.toggle('open');
    });
    const tfs = h('div.tx-group');
    for (const t of TIMEFRAMES) {
      const b = h('button.tx-btn', { type: 'button', onclick: () => this.setTf(t.id) }, t.id) as HTMLButtonElement;
      this.tfButtons.set(t.id, b);
      tfs.append(b);
    }
    this.emaBtn.addEventListener('click', () => this.toggle('emas'));
    this.volBtn.addEventListener('click', () => this.toggle('volume'));
    this.playBtn.addEventListener('click', () => session.play());
    this.speedBtns = SPEEDS.map((sp, i) => h('button.tx-btn', { type: 'button', onclick: () => session.setSpeed(i), title: `${sp.label}: ${i < 2 ? 'real time' : 'of market a second'}` }, sp.label) as HTMLButtonElement);
    const step = h('button.tx-btn', { type: 'button', title: 'Play to the end of this candle (.)', onclick: () => session.step(this.setup.tf) }, '⏭');
    this.runBtn.addEventListener('click', () => {
      if (!session.account.busy) this.say('Open a trade or leave an order first: this plays on until it closes', true);
      session.runToResult();
    });
    const more = h('button.tx-btn', { type: 'button', title: 'More' }, '⋯');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pairMenu.classList.remove('open');
      this.moreMenu.classList.toggle('open');
    });
    this.pauseBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.pauseBox.addEventListener('change', () => (session.pauseOnFill = this.pauseBox.checked));
    this.moreMenu.append(
      h('label', {}, this.pauseBox, 'Pause when an order fills or a trade closes'),
      h('button', { type: 'button', onclick: () => this.confirmThen('Close everything and start a new market?', () => session.newMarket()) }, '🎲 New market'),
      h('button', { type: 'button', onclick: () => this.confirmThen('Put the account back to $10,000 and clear its history?', () => session.resetAccount()) }, '↺ Reset account'),
    );
    const top = h(
      'div.tx-top',
      {},
      h('div.tx-anchor', {}, this.symbol, this.pairMenu),
      h('i.tx-sep'),
      tfs,
      h('i.tx-sep'),
      this.emaBtn,
      this.volBtn,
      h('div.tx-grow'),
      this.playBtn,
      h('div.tx-group', {}, ...this.speedBtns),
      step,
      this.runBtn,
      h('i.tx-sep'),
      this.clock,
      h('div.tx-anchor', {}, more, this.moreMenu),
    );

    // On the chart: one-click buy and sell, with the ticket's size, stop and target.
    const quick = h(
      'div.tx-quick',
      {},
      h('button.sell', { type: 'button', onclick: () => this.ticket.trade(-1), onmouseenter: () => (this.ticket.hoverSide = -1), onmouseleave: () => (this.ticket.hoverSide = null) }, this.quickSell),
      this.quickSpread,
      h('button.buy', { type: 'button', onclick: () => this.ticket.trade(1), onmouseenter: () => (this.ticket.hoverSide = 1), onmouseleave: () => (this.ticket.hoverSide = null) }, this.quickBuy),
    );
    this.el = h('div.tx', {}, top, h('div.tx-mid', {}, h('div.tx-chart', {}, this.chart.el, quick, this.toasts), this.ticket.el), this.blotter.el);
    this.el.addEventListener('click', (e) => {
      this.pairMenu.classList.remove('open');
      this.moreMenu.classList.remove('open');
      // A clicked button lets go of the focus, so Space plays the clock rather than clicking Buy again.
      if ((e.target as HTMLElement).closest('button')) (document.activeElement as HTMLElement | null)?.blur();
    });
    this.sync();
  }

  get setup(): ScreenSetup {
    return this.session.screens[this.index];
  }

  private confirmThen(question: string, then: () => void) {
    this.moreMenu.classList.remove('open');
    if (window.confirm(question)) then();
  }

  private fillPairs() {
    const s = this.session;
    this.pairMenu.replaceChildren(
      ...PAIRS.map((p, i) => {
        const d = s.cache.get(i, 'D');
        const k = d.of[s.minute];
        const q = s.quote(i);
        const ch = ((q.bid - d.o[k]) / d.o[k]) * 100;
        return h(
          `button${i === this.setup.pair ? '.on' : ''}`,
          { type: 'button', onclick: () => this.setPair(i) },
          h('b', {}, pairName(p)),
          h('span', {}, fmt.price(i, q.bid)),
          h('span', { class: ch >= 0 ? 'up' : 'down' }, `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`),
        );
      }),
    );
  }

  setPair(pair: number) {
    this.setup.pair = pair;
    this.pairMenu.classList.remove('open');
    this.chart.reset();
    this.ticket.pairChanged();
    this.session.changed();
    this.sync();
  }

  setTf(tf: Tf) {
    this.setup.tf = tf;
    this.chart.reset();
    this.session.changed();
    this.sync();
  }

  private toggle(what: 'emas' | 'volume') {
    this.setup[what] = !this.setup[what];
    this.session.changed();
    this.sync();
  }

  /** The buttons as the screen's settings and the clock stand. */
  private sync() {
    const s = this.setup;
    this.symbol.replaceChildren(h('b', {}, pairName(PAIRS[s.pair])), h('span', {}, '▾'));
    for (const [tf, b] of this.tfButtons) b.classList.toggle('on', tf === s.tf);
    this.emaBtn.classList.toggle('on', s.emas);
    this.volBtn.classList.toggle('on', s.volume);
  }

  /** A note over the chart for a few seconds. */
  say(text: string, bad = false) {
    const t = h('div.tx-toast', { class: bad ? 'bad' : '' }, text);
    this.toasts.append(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
    setTimeout(() => t.remove(), 3600);
  }

  /** Each frame the screen's in view. */
  update() {
    const s = this.session;
    this.chart.draw();
    this.ticket.update();
    const q = s.quote(this.setup.pair);
    this.quickSell.replaceChildren(h('small', {}, 'SELL'), bigPrice(this.setup.pair, q.bid));
    this.quickBuy.replaceChildren(h('small', {}, 'BUY'), bigPrice(this.setup.pair, q.ask));
    this.quickSpread.textContent = ((q.ask - q.bid) / PAIRS[this.setup.pair].pip).toFixed(1);
    this.playBtn.textContent = s.playing ? '❚❚' : '▶';
    this.playBtn.classList.toggle('on', s.playing);
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', !s.running && i === s.speed));
    this.runBtn.classList.toggle('on', s.running);
    this.pauseBox.checked = s.pauseOnFill;
    // The rest a few times a second: it's text and tables.
    if (++this.slow % 8 === 0) {
      const now = s.now();
      const secs = new Date(now * 1000).getUTCSeconds();
      this.clock.replaceChildren(h('b', {}, `${fmt.day(now)} · ${fmt.clock(now)}:${String(secs).padStart(2, '0')} UTC`), h('span', {}, fmt.sessions(now).join(' · ') || 'Quiet'));
      this.blotter.update();
    }
  }
}
