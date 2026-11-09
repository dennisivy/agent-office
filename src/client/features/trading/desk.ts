// Taking over the trading desk. Press E at it and the camera glides up to a monitor while that
// screen's trading platform (terminal.ts) is laid exactly over it. Swipe sideways on the trackpad (or
// Ctrl+←/→, as on a Mac, or the arrows under the screen) and the camera glides along to the next
// monitor, the way a Mac slides between desktops. The clock plays only while you're at the desk.
//
// The monitors show what each screen's set to all the time, so the charts are up as you walk past.
// The market and the account are this browser's own: everyone else sees their own desk on them.

import * as THREE from 'three';
import { h, openModal, type Modal } from '../../ui/dom';
import { paintChart, defaultView } from './chartdraw';
import * as fmt from './format';
import { PAIRS, pairName } from './pairs';
import { Session } from './session';
import { Terminal } from './terminal';
import { SCREEN_PX, type TradingDeskModel } from './world';

/** How much of the view (across or down) the screen fills while you're at it. */
const FILL = 0.94;
/** How long gliding from one monitor to the next takes, in seconds. */
const GLIDE = 0.42;
/** How far a sideways swipe has to go (in wheel pixels) to change screens. */
const SWIPE = 70;
/** The size the platform is laid out at before it's scaled to fit the screen. */
const DESIGN = { w: 1360 };

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class TradingDesk {
  private modal: Modal | null = null;
  /** Made the first time someone sits down: making a market takes a moment. */
  private session: Session | null = null;
  private terminals: Terminal[] = [];
  private active = 0;
  /** 0 is your own view, 1 is up at the screens. */
  private zoom = 0;
  /** Gliding between monitors: from where, and how far along (1 is there). */
  private glide = { from: 0, t: 1 };
  private readonly box = h('div.trading-box');
  private readonly dots = h('div.trading-dots');
  private readonly stage = h('div.trading-stage');
  private swipe = { sum: 0, fired: false, timer: 0 as ReturnType<typeof setTimeout> | 0 };
  private repaint = 0;
  private saveTimer = 0;
  private readonly pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

  constructor(private readonly model: TradingDeskModel) {
    this.paintIdle();
    void document.fonts.ready.then(() => this.paintIdle());
  }

  get zoomed(): boolean {
    return this.zoom > 0;
  }

  get open(): boolean {
    return this.modal !== null;
  }

  /** The prices on the desk now, for the hint. */
  summary(): string | null {
    const s = this.session;
    if (!s) return null;
    const p = s.screens[0].pair;
    return `${pairName(PAIRS[p])} ${fmt.price(p, s.quote(p).bid)}`;
  }

  private ensureSession(): Session {
    if (!this.session) {
      const s = new Session();
      s.onFill = (f) => {
        const t = this.terminals[this.active];
        if (!t) return;
        if (f.kind === 'open') {
          const p = f.position;
          if (f.from) t.say(`${f.from.side === 1 ? 'Buy' : 'Sell'} ${f.from.kind} filled: ${fmt.lots(p.units)} ${pairName(PAIRS[p.pair])} at ${fmt.price(p.pair, p.entry)}`);
        } else {
          const tr = f.trade;
          const why = { tp: '🎯 Take profit hit', sl: '🛑 Stop loss hit', manual: 'Closed', stopout: '⚠️ Margin call: stopped out' }[tr.why];
          t.say(`${why}: ${pairName(PAIRS[tr.pair])} ${fmt.money(tr.pnl, true)}`, tr.pnl < 0);
        }
      };
      this.session = s;
      this.terminals = s.screens.map((_, i) => new Terminal(s, i));
    }
    return this.session;
  }

  /** Sits down at the desk, at the screen you were on last. */
  take() {
    if (this.modal) return;
    this.ensureSession();
    this.glide = { from: this.active, t: 1 };
    const left = h('button.trading-arrow', { type: 'button', title: 'Previous screen (Ctrl+←)', onclick: () => this.go(this.active - 1) }, '‹');
    const right = h('button.trading-arrow', { type: 'button', title: 'Next screen (Ctrl+→)', onclick: () => this.go(this.active + 1) }, '›');
    const bar = h(
      'div.trading-bar',
      {},
      left,
      this.dots,
      right,
      h('span.tip', {}, 'Swipe sideways or Ctrl+←/→ for the other screens · Space plays · Esc to stand up'),
    );
    const root = h('div.trading', { role: 'dialog', 'aria-label': 'Trading desk' }, this.box, bar);
    this.box.replaceChildren(this.stage);
    this.show(this.active, 0);
    const fit = () => {
      const { width, height } = this.size();
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      // The platform is laid out at a fixed size and scaled to the screen, so it looks the same on any display.
      const scale = width / DESIGN.w;
      this.stage.style.width = `${DESIGN.w}px`;
      this.stage.style.height = `${DESIGN.w / (width / height)}px`;
      this.stage.style.transform = `scale(${scale})`;
      for (const t of this.terminals) t.chart.fit();
    };
    fit();
    const onKey = (e: KeyboardEvent) => this.key(e);
    const onWheel = (e: WheelEvent) => this.wheel(e);
    window.addEventListener('resize', fit);
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('wheel', onWheel, { passive: false });
    this.modal = openModal(root, {
      backdropCloses: false,
      doing: '📈 trading forex',
      onClose: () => {
        window.removeEventListener('resize', fit);
        window.removeEventListener('keydown', onKey, true);
        this.modal = null;
        const s = this.session!;
        s.play(false);
        s.save();
      },
    });
    this.modal.backdrop.classList.add('clear');
    // Swiping back and forth over the office must never turn into the browser's back and forward.
    this.modal.backdrop.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  }

  stop() {
    this.modal?.close();
  }

  /** The screen's size on the page once the camera is up at it. */
  private size(): { width: number; height: number } {
    const { width, height } = this.model.screens[0].geometry.parameters;
    const aspect = width / height;
    // Room under it for the bar of screens, and over it to match, so it stays in the middle.
    const w = Math.min(innerWidth * FILL, (innerHeight - 120) * aspect);
    return { width: w, height: w / aspect };
  }

  /** Puts screen `i`'s platform up, sliding in from the side it's on (`dir`). */
  private show(i: number, dir: number) {
    const t = this.terminals[i];
    const el = t.el;
    el.classList.remove('from-left', 'from-right');
    if (dir) {
      void el.offsetWidth;
      el.classList.add(dir > 0 ? 'from-right' : 'from-left');
    }
    this.stage.replaceChildren(el);
    this.dots.replaceChildren(
      ...this.terminals.map((term, k) =>
        h(`button${k === i ? '.on' : ''}`, { type: 'button', title: `${pairName(PAIRS[term.setup.pair])} · ${term.setup.tf}`, onclick: () => this.go(k) }, pairName(PAIRS[term.setup.pair])),
      ),
    );
  }

  /** Glides to screen `i`. */
  private go(i: number) {
    if (i < 0 || i >= this.terminals.length || i === this.active) {
      // A little bump at either end, like a Mac's last desktop.
      this.stage.classList.remove('bump-left', 'bump-right');
      void this.stage.offsetWidth;
      this.stage.classList.add(i < 0 ? 'bump-left' : 'bump-right');
      return;
    }
    const dir = Math.sign(i - this.active);
    this.glide = { from: this.active, t: 0 };
    this.active = i;
    this.box.classList.add('gliding');
    setTimeout(() => {
      this.box.classList.remove('gliding');
      this.show(i, dir);
    }, GLIDE * 900);
  }

  private wheel(e: WheelEvent) {
    // Up and down is left alone, so the tables scroll; only sideways is a swipe.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.ctrlKey) return;
    e.preventDefault();
    // One swipe, one screen: the rest of the gesture (and the trackpad's coasting) does nothing more.
    this.swipe.sum += e.deltaX;
    if (!this.swipe.fired && Math.abs(this.swipe.sum) > SWIPE) {
      this.swipe.fired = true;
      this.go(this.active + Math.sign(this.swipe.sum));
    }
    clearTimeout(this.swipe.timer);
    this.swipe.timer = setTimeout(() => (this.swipe = { sum: 0, fired: false, timer: 0 }), 260);
  }

  private key(e: KeyboardEvent) {
    if (!this.modal) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const s = this.session!;
    if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      this.go(this.active + (e.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') s.play();
    else if (e.key === 'r' || e.key === 'R') s.runToResult();
    else if (e.key === '.') s.step(this.terminals[this.active].setup.tf);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Where the camera goes to look straight at monitor `i`, so it's exactly as big on the page as the platform laid over it. */
  private poseOf(i: number, camera: THREE.PerspectiveCamera, out: { pos: THREE.Vector3; quat: THREE.Quaternion }) {
    const screen = this.model.screens[i];
    const { height } = screen.geometry.parameters;
    const tall = this.size().height / innerHeight;
    const back = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * tall);
    screen.getWorldQuaternion(out.quat);
    screen.localToWorld(out.pos.set(0, 0, back));
  }

  /** Each frame: plays the clock, moves the camera, draws the screens. Call it once the player has placed the camera. */
  update(camera: THREE.PerspectiveCamera, dt: number, player: THREE.Vector3) {
    const s = this.session;
    if (s && this.modal) {
      s.tick(dt);
      this.terminals[this.active].update();
      if ((this.saveTimer += dt) > 3) {
        this.saveTimer = 0;
        s.save();
      }
    }
    this.moveCamera(camera, dt);
    // The monitors and the ticker, a few times a second when you're near enough to see them.
    const near = player.distanceTo(this.model.center) < 16;
    if (near && s && (this.repaint -= dt) <= 0) {
      this.repaint = this.modal ? 0.12 : 0.5;
      this.paintScreens();
    }
  }

  private moveCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const want = this.modal ? 1 : 0;
    if (this.zoom === want && !want) return;
    if (this.zoom !== want) {
      this.zoom += (want - this.zoom) * Math.min(1, dt * 8);
      if (Math.abs(want - this.zoom) < 0.002) this.zoom = want;
    }
    const target = this.pose;
    this.poseOf(this.active, camera, target);
    if (this.glide.t < 1) {
      this.glide.t = Math.min(1, this.glide.t + dt / GLIDE);
      const from = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      this.poseOf(this.glide.from, camera, from);
      const k = ease(this.glide.t);
      target.pos.lerpVectors(from.pos, target.pos, k);
      target.quat.slerpQuaternions(from.quat, target.quat, k);
    }
    camera.position.lerp(target.pos, this.zoom);
    camera.quaternion.slerp(target.quat, this.zoom);
  }

  /** Each monitor's chart, as its screen is set up, and the ticker's prices. */
  private paintScreens() {
    const s = this.session!;
    const scale = SCREEN_PX.w / 760;
    this.terminals.forEach((t, i) => {
      // The one you're looking at is covered by its platform.
      if (this.modal && i === this.active && this.glide.t >= 1) return;
      const g = this.model.canvases[i].getContext('2d')!;
      g.setTransform(scale, 0, 0, scale, 0, 0);
      const set = t.setup;
      paintChart(g, 760, SCREEN_PX.h / scale, { market: s.market, cache: s.cache, account: s.account, pair: set.pair, tf: set.tf, minute: s.minute, frac: s.frac, emas: set.emas, volume: set.volume, draft: [], dragging: null }, { ...defaultView(), spacing: 7 }, null);
      this.model.textures[i].needsUpdate = true;
    });
    this.paintTicker();
  }

  private paintTicker() {
    const s = this.session!;
    const { canvas, texture } = this.model.ticker;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#07080c';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = "700 34px 'SF Mono', Menlo, Consolas, monospace";
    g.textBaseline = 'middle';
    let x = 20;
    for (let i = 0; i < PAIRS.length; i++) {
      const d = s.cache.get(i, 'D');
      const k = d.of[s.minute];
      const bid = s.quote(i).bid;
      const ch = ((bid - d.o[k]) / d.o[k]) * 100;
      g.fillStyle = '#ffb000';
      const name = `${pairName(PAIRS[i])} ${fmt.price(i, bid)}`;
      g.fillText(name, x, 33);
      x += g.measureText(name).width + 12;
      g.fillStyle = ch >= 0 ? '#2bd99f' : '#ff4d5e';
      const c = `${ch >= 0 ? '▲' : '▼'}${Math.abs(ch).toFixed(2)}%`;
      g.fillText(c, x, 33);
      x += g.measureText(c).width + 44;
    }
    texture.needsUpdate = true;
  }

  /** Before anyone's sat down: the screens show they're waiting. */
  private paintIdle() {
    this.model.canvases.forEach((c, i) => {
      const g = c.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#131722';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#2962ff';
      g.font = "700 64px -apple-system, 'Trebuchet MS', sans-serif";
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'][i] ?? 'FX', c.width / 2, c.height / 2 - 30);
      g.fillStyle = '#787b86';
      g.font = "400 34px -apple-system, 'Trebuchet MS', sans-serif";
      g.fillText('Press E at the desk to trade', c.width / 2, c.height / 2 + 40);
      this.model.textures[i].needsUpdate = true;
    });
    const { canvas, texture } = this.model.ticker;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#07080c';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#ffb000';
    g.font = "700 34px 'SF Mono', Menlo, Consolas, monospace";
    g.textBaseline = 'middle';
    g.fillText('FX DESK · EUR/USD · GBP/USD · USD/JPY · USD/CHF · AUD/USD · USD/CAD · NZD/USD · MARKETS PAUSED · ', 20, 33);
    texture.needsUpdate = true;
  }
}
