// How the desk writes prices, money and times. Times are UTC, as forex platforms show them, and never
// with a year: the market's made up, so its calendar is too.

import { PAIRS } from './pairs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function price(pair: number, p: number): string {
  return p.toFixed(PAIRS[pair].digits);
}

/** $1,234.56, with a sign when `signed`. */
export function money(x: number, signed = false): string {
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}$${s}`;
}

export function pips(x: number): string {
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 14:35 */
export function clock(t: number): string {
  const d = new Date(t * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Tue 14 Mar */
export function day(t: number): string {
  const d = new Date(t * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Tue 14 Mar 14:35 */
export function stamp(t: number): string {
  return `${day(t)} ${clock(t)}`;
}

export function dayOfMonth(t: number): number {
  return new Date(t * 1000).getUTCDate();
}

export function monthName(t: number): string {
  return MONTHS[new Date(t * 1000).getUTCMonth()];
}

/** 01:23:45 or 12:34 till something, from seconds. */
export function countdown(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${pad(h)}:${pad(m)}:${pad(total % 60)}` : `${pad(m)}:${pad(total % 60)}`;
}

/** Which of the big sessions are open at `t`: Sydney, Tokyo, London, New York. */
export function sessions(t: number): string[] {
  const h = new Date(t * 1000).getUTCHours();
  const open: string[] = [];
  if (h >= 21 || h < 6) open.push('Sydney');
  if (h >= 0 && h < 9) open.push('Tokyo');
  if (h >= 7 && h < 16) open.push('London');
  if (h >= 12 && h < 21) open.push('New York');
  return open;
}

/** 1.00 lot, 0.10 lots */
export function lots(units: number): string {
  const l = units / 100_000;
  return `${l.toFixed(2)} ${l === 1 ? 'lot' : 'lots'}`;
}
