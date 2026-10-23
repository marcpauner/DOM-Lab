import { h } from '../lib/dom.js';
import './menu.css';

/**
 * Context menu for a tree node, built on the native Popover API: the
 * browser closes it when you click outside or press Esc ("light dismiss").
 * It can also turn into a small one-field form (e.g. "tag name").
 */
export class NodeMenu {
  #popover;
  #returnFocus = null;

  constructor() {
    this.#popover = h('div', { className: 'node-menu', popover: 'auto', role: 'menu' });
    this.#popover.addEventListener('keydown', (event) => this.#onKeyDown(event));
    this.#popover.addEventListener('toggle', (event) => {
      if (event.newState === 'closed') this.#returnFocus?.focus({ preventScroll: true });
    });
    document.body.append(this.#popover);
  }

  /**
   * @param {{ x: number, y: number }} at  Where to open it (viewport coordinates)
   * @param {Array<{ label: string, keys?: string, danger?: boolean, run: () => void } | 'separator'>} items
   */
  open(at, items, { title } = {}) {
    this.#rememberFocus();
    this.#popover.replaceChildren(
      title ? h('div', { className: 'node-menu__title' }, title) : null,
      ...items.map((item) =>
        item === 'separator'
          ? h('div', { className: 'node-menu__separator', role: 'separator' })
          : h(
              'button',
              {
                className: `node-menu__item${item.danger ? ' node-menu__item--danger' : ''}`,
                type: 'button',
                role: 'menuitem',
                onclick: () => {
                  this.close();
                  item.run();
                },
              },
              h('span', {}, item.label),
              item.keys ? h('kbd', {}, item.keys) : null,
            ),
      ),
    );
    this.#show(at);
    this.#popover.querySelector('[role="menuitem"]')?.focus();
  }

  /** A one-field form: "Tag name: [li] [Add]". Resolves with the text, or null if cancelled. */
  ask(at, { title, placeholder, action }) {
    this.#rememberFocus();
    return new Promise((resolve) => {
      const input = h('input', { className: 'node-menu__input', type: 'text', placeholder, 'aria-label': title });
      input.spellcheck = false;
      const form = h(
        'form',
        { className: 'node-menu__form' },
        h('div', { className: 'node-menu__title' }, title),
        h('div', { className: 'node-menu__row' }, input, h('button', { className: 'button button--primary', type: 'submit' }, action)),
      );
      let answered = false;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        answered = true;
        this.close();
        resolve(input.value);
      });
      // Not { once: true }: toggle events are coalesced, so the first one may be
      // the "open" of this very form
      const onToggle = (event) => {
        if (event.newState !== 'closed') return;
        this.#popover.removeEventListener('toggle', onToggle);
        if (!answered) resolve(null);
      };
      this.#popover.addEventListener('toggle', onToggle);
      this.#popover.replaceChildren(form);
      this.#show(at);
      input.focus();
    });
  }

  close() {
    if (this.#popover.matches(':popover-open')) this.#popover.hidePopover();
  }

  /** Where the focus goes back when the menu closes (not to the menu itself, nor to <body>). */
  #rememberFocus() {
    const active = document.activeElement;
    if (active && active !== document.body && !this.#popover.contains(active)) this.#returnFocus = active;
  }

  #show({ x, y }) {
    if (!this.#popover.matches(':popover-open')) this.#popover.showPopover();
    // Keep it on screen: measure it, then clamp the position
    const { offsetWidth, offsetHeight } = this.#popover;
    this.#popover.style.left = `${Math.max(8, Math.min(x, innerWidth - offsetWidth - 8))}px`;
    this.#popover.style.top = `${Math.max(8, Math.min(y, innerHeight - offsetHeight - 8))}px`;
  }

  /** Arrow keys move between the items, like a native menu. */
  #onKeyDown(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...this.#popover.querySelectorAll('[role="menuitem"]')];
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  }
}
