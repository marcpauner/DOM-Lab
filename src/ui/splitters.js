import { readPref, writePref } from '../lib/storage.js';

/*
 * Resizable panels. Each splitter updates a CSS variable on the workspace
 * (in %), and the grid in layout.css does the rest.
 */

const DEFAULTS = { editor: 33, tree: 27, console: 30 };
const LIMITS = { editor: [15, 60], tree: [15, 50], console: [6, 85] };
const COLLAPSED_CONSOLE = 0; // the row's minmax() keeps the header visible

export function initSplitters(workspace, stack) {
  const sizes = { ...DEFAULTS, ...readPref('layout', {}) };
  let consoleBeforeCollapse = sizes.console || DEFAULTS.console;

  const clamp = (key, value) => {
    const [min, max] = LIMITS[key];
    let result = Math.min(max, Math.max(min, value));
    // Editor and tree together must leave room for the preview
    if (key === 'editor') result = Math.min(result, 80 - sizes.tree);
    if (key === 'tree') result = Math.min(result, 80 - sizes.editor);
    return result;
  };

  const apply = () => {
    workspace.style.setProperty('--editor-size', `${sizes.editor}%`);
    workspace.style.setProperty('--tree-size', `${sizes.tree}%`);
    workspace.style.setProperty('--console-size', `${sizes.console}%`);
    for (const handle of workspace.querySelectorAll('[data-splitter]')) {
      handle.setAttribute('aria-valuenow', String(Math.round(sizes[handle.dataset.splitter])));
    }
  };

  /** Size (%) the panel would have if the splitter were at the pointer. */
  const measure = (key, event) => {
    if (key === 'console') {
      const box = stack.getBoundingClientRect();
      return ((box.bottom - event.clientY) / box.height) * 100;
    }
    const box = workspace.getBoundingClientRect();
    return key === 'editor'
      ? ((event.clientX - box.left) / box.width) * 100
      : ((box.right - event.clientX) / box.width) * 100;
  };

  const set = (key, value) => {
    sizes[key] = key === 'console' && value <= LIMITS.console[0] ? COLLAPSED_CONSOLE : clamp(key, value);
    apply();
  };

  for (const handle of workspace.querySelectorAll('[data-splitter]')) {
    const key = handle.dataset.splitter;
    const axis = key === 'console' ? 'y' : 'x';
    handle.setAttribute('aria-valuemin', String(LIMITS[key][0]));
    handle.setAttribute('aria-valuemax', String(LIMITS[key][1]));

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // Pointer "capture" sends every move to this element, even when the
      // pointer leaves it.
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.documentElement.classList.add('is-resizing', `is-resizing-${axis}`);

      const onMove = (moveEvent) => set(key, measure(key, moveEvent));
      const onEnd = () => {
        handle.classList.remove('is-dragging');
        document.documentElement.classList.remove('is-resizing', `is-resizing-${axis}`);
        handle.removeEventListener('pointermove', onMove);
        writePref('layout', sizes);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('lostpointercapture', onEnd, { once: true });
    });

    // Double click: back to the default size
    handle.addEventListener('dblclick', () => {
      set(key, DEFAULTS[key]);
      writePref('layout', sizes);
    });

    // Keyboard accessible: arrow keys (bigger steps with Shift)
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 2;
      const grow = axis === 'x' ? (key === 'editor' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
      const shrink = axis === 'x' ? (key === 'editor' ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      set(key, (sizes[key] || LIMITS[key][0]) + (event.key === grow ? step : -step));
      writePref('layout', sizes);
    });
  }

  apply();

  return {
    get consoleCollapsed() {
      return sizes.console === COLLAPSED_CONSOLE;
    },
    toggleConsole() {
      if (sizes.console === COLLAPSED_CONSOLE) {
        sizes.console = consoleBeforeCollapse;
      } else {
        consoleBeforeCollapse = sizes.console;
        sizes.console = COLLAPSED_CONSOLE;
      }
      apply();
      writePref('layout', sizes);
      return sizes.console === COLLAPSED_CONSOLE;
    },
  };
}
