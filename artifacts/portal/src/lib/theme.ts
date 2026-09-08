/** The portal has one look: the light Greystone restyle (cream ground, chrome sidebar, teal primary). No dark mode, no palette picker. */
export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = 'light';
  delete root.dataset.palette;
  try {
    localStorage.removeItem('gs-theme');
    localStorage.removeItem('gs-palette');
  } catch {
    /* private mode */
  }
}
applyTheme();
