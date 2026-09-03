/** Light / dark / system theme, remembered per browser. Applied to <html data-theme> before React renders. */
export type Theme = 'light' | 'dark' | 'auto';
const KEY = 'gs-theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* private mode: the choice just does not persist */
  }
}

applyTheme(readTheme());

/** Colour palette, remembered per browser. 'greystone' is the default sand + navy look. */
export type Palette = 'greystone' | 'sand' | 'slate' | 'forest' | 'graphite' | 'midnight';
export const PALETTES: Array<{ id: Palette; label: string; swatch: [string, string, string] }> = [
  { id: 'greystone', label: 'Greystone', swatch: ['#f3efe8', '#17362b', '#8fc3a8'] },
  { id: 'sand', label: 'Sand', swatch: ['#f1ece1', '#242931', '#2b6b64'] },
  { id: 'slate', label: 'Slate', swatch: ['#eef1f5', '#1c2230', '#3b5bdb'] },
  { id: 'forest', label: 'Forest', swatch: ['#f2f1ea', '#16302a', '#2f7d5a'] },
  { id: 'graphite', label: 'Graphite', swatch: ['#f4f4f4', '#202124', '#1a73e8'] },
  { id: 'midnight', label: 'Midnight', swatch: ['#f5f7fb', '#0b1f3a', '#0f6fb8'] },
];
const PKEY = 'gs-palette';
export function readPalette(): Palette {
  try {
    const v = localStorage.getItem(PKEY);
    return PALETTES.some((p) => p.id === v) ? (v as Palette) : 'greystone';
  } catch {
    return 'greystone';
  }
}
export function applyPalette(p: Palette): void {
  const root = document.documentElement;
  if (p === 'greystone') delete root.dataset.palette;
  else root.dataset.palette = p;
  try {
    if (p === 'greystone') localStorage.removeItem(PKEY);
    else localStorage.setItem(PKEY, p);
  } catch {
    /* private mode */
  }
}
applyPalette(readPalette());
