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
