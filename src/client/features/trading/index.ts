/**
 * The trading desk south of the desk pods: four monitors of a made-up but true-to-life forex market
 * (the seven major pairs). Press E there to take the screens over, swipe between them, trade, and play
 * the market's clock fast to watch a trade play out in seconds instead of hours.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { TradingDesk } from './desk';
import './ui.css';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    trading: true;
  }
}

export function installTrading(ctx: Ctx): TradingDesk {
  const desk = new TradingDesk(ctx.office.tradingDesk);
  ctx.ticks.add('play', ({ dt }) => desk.update(ctx.camera, dt, ctx.player.pos));
  ctx.interactions.define('trading', {
    reach: 3,
    hint: () => {
      const now = desk.summary();
      return { k: now ?? '', parts: [hintTitle('📈 Trading desk'), aside(now ?? 'forex on four screens'), key('E', 'Trade')] };
    },
    use: onE(() => desk.take()),
  });
  // With the camera up at the screens, they have the view: no hands drawn over them.
  ctx.view.add({ covers: () => desk.zoomed });
  return desk;
}
