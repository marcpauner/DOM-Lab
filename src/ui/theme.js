import { readPref, writePref } from '../lib/storage.js';

const MODES = ['system', 'light', 'dark'];
const LABELS = { system: 'automatic (system)', light: 'light', dark: 'dark' };

/**
 * Three-state theme toggle: system → light → dark.
 * "System" removes data-theme from <html> and lets prefers-color-scheme
 * decide; the other two pin color-scheme (see styles/tokens.css).
 */
export function initTheme(button) {
  let mode = readPref('theme', 'system');
  if (!MODES.includes(mode)) mode = 'system';
  apply(mode);

  button.addEventListener('click', () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    writePref('theme', mode);
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // View Transitions API: a smooth cross-fade between the two themes
    if (document.startViewTransition && !reduceMotion) document.startViewTransition(() => apply(mode));
    else apply(mode);
  });

  function apply(next) {
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    button.dataset.mode = next;
    button.title = `Theme: ${LABELS[next]}`;
    button.setAttribute('aria-label', `Change theme (currently ${LABELS[next]})`);
  }
}
