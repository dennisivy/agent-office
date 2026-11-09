// A chart you can work: scroll to zoom, drag to look back through history, double-click to come back
// to now, and drag a position's stop or target (or a waiting order) to move it, or click its ✕. It
// draws with chartdraw.ts, at the screen's own resolution.

import { defaultView, paintChart, type Grab, type Painted, type Scene, type View } from './chartdraw';
import { PAIRS } from './pairs';

export interface ChartHooks {
  /** What to draw now. */
  scene(): Omit<Scene, 'dragging'>;
  /** A line was dragged to `price`. */
  moved(grab: Grab, price: number): void;
  /** A line's ✕ was clicked. */
  closed(grab: Grab): void;
}

export class ChartPane {
  readonly el = document.createElement('div');
  readonly view: View = defaultView();
  private readonly canvas = document.createElement('canvas');
  private hover: { x: number; y: number } | null = null;
  private painted: Painted | null = null;
  private drag: { pan: true; x0: number; shift0: number } | { pan: false; grab: Grab; price: number } | null = null;
  private size = { w: 0, h: 0, dpr: 1 };

  constructor(private readonly hooks: ChartHooks) {
    this.el.className = 'tx-canvas';
    this.el.append(this.canvas);
    new ResizeObserver(() => this.fit()).observe(this.el);
    window.addEventListener('resize', () => this.fit());
    // The platform can be scaled to fit its monitor: the mouse is in page pixels, the drawing in the platform's.
    const at = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const k = this.size.w / (r.width || 1);
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = at(e);
      const hit = this.hit(p);
      if (hit?.onClose) {
        this.hooks.closed(hit.grab);
        return;
      }
      this.canvas.setPointerCapture(e.pointerId);
      if (hit && hit.grab.kind !== 'position') this.drag = { pan: false, grab: hit.grab, price: this.painted!.yToPrice(p.y) };
      else this.drag = { pan: true, x0: p.x, shift0: this.view.shift };
      this.cursor(p);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const p = at(e);
      this.hover = p;
      const d = this.drag;
      if (d?.pan) this.view.shift = this.clampShift(d.shift0 - (p.x - d.x0) / this.view.spacing);
      else if (d) d.price = this.snap(this.painted!.yToPrice(p.y));
      this.cursor(p);
    });
    const end = () => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.pan) this.hooks.moved(d.grab, d.price);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag) this.hover = null;
    });
    this.canvas.addEventListener('dblclick', () => this.reset());
    // Up and down (or a pinch) zooms; side to side is left to the desk, which swipes between screens.
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : 1;
        const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0022));
        this.view.spacing = Math.max(1.5, Math.min(60, this.view.spacing * factor));
        this.view.shift = this.clampShift(this.view.shift);
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Set to fit the chart to what there is when it next draws. */
  private fresh = true;

  /** Back to now, at the usual zoom (after a change of pair or timeframe). */
  reset() {
    Object.assign(this.view, defaultView());
    this.fresh = true;
  }

  /** The usual zoom, unless there are too few candles to fill the chart that way: then wide enough to fill it. */
  private fitToHistory() {
    const s = this.hooks.scene();
    const candles = s.cache.get(s.pair, s.tf).of[s.minute] + 1;
    const room = (this.size.w - 68) / defaultView().spacing - defaultView().shift;
    if (candles < room) this.view.spacing = Math.min(40, (this.size.w - 68) / (candles + defaultView().shift + 2));
  }

  private clampShift(shift: number): number {
    const fits = this.size.w / this.view.spacing;
    return Math.max(-20000, Math.min(fits - 5, shift));
  }

  private snap(price: number): number {
    const step = PAIRS[this.hooks.scene().pair].pip / 10;
    return Math.round(price / step) * step;
  }

  /** The line (and whether its ✕) under `p`. */
  private hit(p: { x: number; y: number }): { grab: Grab; onClose: boolean } | null {
    if (!this.painted || p.x > this.painted.plot.w) return null;
    for (const g of this.painted.grabs) {
      const c = g.close;
      if (c && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return { grab: g, onClose: true };
    }
    let best: Grab | null = null;
    for (const g of this.painted.grabs) if (Math.abs(g.y - p.y) <= 5 && (!best || Math.abs(g.y - p.y) < Math.abs(best.y - p.y))) best = g;
    return best ? { grab: best, onClose: false } : null;
  }

  private cursor(p: { x: number; y: number }) {
    const d = this.drag;
    if (d) this.canvas.style.cursor = d.pan ? 'grabbing' : 'ns-resize';
    else {
      const hit = this.hit(p);
      this.canvas.style.cursor = hit?.onClose ? 'pointer' : hit && hit.grab.kind !== 'position' ? 'ns-resize' : 'crosshair';
    }
  }

  fit() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    // Pixels for every page pixel it covers, however it's scaled.
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * (this.el.getBoundingClientRect().width / (w || 1) || 1));
    this.size = { w, h, dpr };
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.draw();
  }

  draw() {
    const { w, h, dpr } = this.size;
    if (w < 10 || h < 10) return;
    if (this.fresh) {
      this.fresh = false;
      this.fitToHistory();
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = this.drag;
    const scene: Scene = { ...this.hooks.scene(), dragging: d && !d.pan ? { key: d.grab.key, price: d.price } : null };
    this.painted = paintChart(g, w, h, scene, this.view, this.hover);
  }
}
