export function money(v: number | null | undefined): string {
  const n = Math.round(Number(v) || 0);
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
}
export function moneyCents(v: number | null | undefined): string {
  const n = Number(v) || 0;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return '$' + (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return '$' + Math.round(v / 1000) + 'K';
  return '$' + Math.round(v);
}
export function pct(v: number): string {
  const p = v * 100;
  return (p % 1 ? p.toFixed(1) : p.toFixed(0)) + '%';
}
const asDate = (s: string) => new Date(`${s}T12:00:00Z`);
export function day(s: string | null | undefined): string {
  return s ? asDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
}
export function fullDay(s: string | null | undefined): string {
  return s ? asDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
}
export function monthLabel(ym: string): string {
  return new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}
export function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
export const todayIso = () => new Date().toISOString().slice(0, 10);
export type Period = '7d' | '30d' | 'QTD' | 'YTD';
export function periodRange(p: Period, today = todayIso()): { from: string; to: string } {
  const t = new Date(`${today}T00:00:00Z`);
  const back = (n: number) => new Date(t.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  if (p === '7d') return { from: back(7), to: today };
  if (p === '30d') return { from: back(30), to: today };
  if (p === 'QTD') return { from: `${t.getUTCFullYear()}-${String(Math.floor(t.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`, to: today };
  return { from: `${t.getUTCFullYear()}-01-01`, to: today };
}
