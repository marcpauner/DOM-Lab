/*
 * Keyboard shortcuts with a single registry: the same list is used to
 * listen for keys and to render the help dialog.
 *
 * Format: 'Mod+Enter', 'Alt+1', '?'
 *   Mod → ⌘ on Mac, Ctrl on Windows/Linux.
 *   SECONDARY → Ctrl on Mac (because on many layouts, e.g. Spanish, ⌥+key
 *   types symbols such as @ or #) and Alt on Windows/Linux.
 */

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
export const SECONDARY = isMac ? 'Ctrl' : 'Alt';

const MAC_SYMBOLS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↵' };
const PC_NAMES = { Mod: 'Ctrl', Enter: 'Enter' };

const registry = [];

/**
 * @param {string} combo   e.g. 'Mod+Enter'
 * @param {string} label   description for the help dialog
 * @param {(event: KeyboardEvent) => void} handler
 */
export function registerShortcut(combo, label, handler) {
  registry.push({ combo, label, handler, ...parse(combo) });
}

export const listShortcuts = () => registry.map(({ combo, label }) => ({ combo, label }));

/** Text to display a shortcut: "⌘↵" on Mac, "Ctrl+Enter" on Windows. */
export function formatShortcut(combo) {
  const parts = combo.split('+');
  return isMac
    ? parts.map((part) => MAC_SYMBOLS[part] ?? part.toUpperCase()).join('')
    : parts.map((part) => PC_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join('+');
}

function parse(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const has = (name) => parts.includes(name);
  return {
    key,
    ctrl: has('Ctrl') || (has('Mod') && !isMac),
    meta: has('Mod') && isMac,
    alt: has('Alt'),
    shift: has('Shift'),
  };
}

// Letters and digits are compared by physical key (event.code): that way
// Alt+1 works the same with any keyboard layout.
function matches(shortcut, event) {
  const { key } = shortcut;
  if (/^[a-z0-9]$/i.test(key)) {
    const code = /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
    if (event.code !== code) return false;
  } else if (key.length === 1) {
    // Symbols like "?" depend on the layout: compare the character and do
    // not require Shift (every keyboard types it differently).
    return event.key === key && !event.ctrlKey && !event.metaKey && !event.altKey;
  } else if (event.key !== key) {
    return false;
  }
  return (
    event.ctrlKey === shortcut.ctrl &&
    event.metaKey === shortcut.meta &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
}

const isTyping = (target) =>
  target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable], .cm-editor'));

// CAPTURE phase on window: we see the key before CodeMirror does. That way
// Ctrl+Enter runs the code instead of inserting a line in the editor.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.repeat || event.isComposing) return;
    for (const shortcut of registry) {
      if (!matches(shortcut, event)) continue;
      // A shortcut without modifiers (like "?") must not fire while typing
      const plain = !shortcut.ctrl && !shortcut.meta && !shortcut.alt;
      if (plain && isTyping(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      shortcut.handler(event);
      return;
    }
  },
  true,
);
