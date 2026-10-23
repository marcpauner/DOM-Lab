import { h } from '../lib/dom.js';
import './menu.css';

/**
 * A floating menu built on the native Popover API: the browser closes it
 * when you click outside or press Esc ("light dismiss"). Used for the tree's
 * context menu and the toolbar menus. It can also show a one-field form
 * (e.g. "tag name") or any other content.
 */
export class Menu {
  #popover;
  #returnFocus = null;

  constructor() {
    this.#popover = h('div', { className: 'menu', popover: 'auto' });
    this.#popover.addEventListener('keydown', (event) => this.#onKeyDown(event));
    this.#popover.addEventListener('toggle', (event) => {
      if (event.newState === 'closed') this.#returnFocus?.focus({ preventScroll: true });
    });
    document.body.append(this.#popover);
  }

  /** Just below an element, aligned with its left edge. */
  static below(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 6 };
  }

  /**
   * @param {{ x: number, y: number }} at  Where to open it (viewport coordinates)
   * @param {Array<{ label: string, description?: string, keys?: string, danger?: boolean, run: () => void } | 'separator'>} items
   */
  open(at, items, { title } = {}) {
    this.#rememberFocus();
    this.#popover.setAttribute('role', 'menu');
    this.#popover.replaceChildren(
      title ? h('div', { className: 'menu__title' }, title) : null,
      ...items.map((item) =>
        item === 'separator'
          ? h('div', { className: 'menu__separator', role: 'separator' })
          : h(
              'button',
              {
                className: `menu__item${item.danger ? ' menu__item--danger' : ''}${item.description ? ' menu__item--described' : ''}`,
                type: 'button',
                role: 'menuitem',
                onclick: () => {
                  this.close();
                  item.run();
                },
              },
              h('span', { className: 'menu__label' }, item.label, item.description ? h('small', {}, item.description) : null),
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
      const input = h('input', { className: 'menu__input', type: 'text', placeholder, 'aria-label': title });
      input.spellcheck = false;
      const form = h(
        'form',
        { className: 'menu__form' },
        h('div', { className: 'menu__title' }, title),
        h('div', { className: 'menu__row' }, input, h('button', { className: 'button button--primary', type: 'submit' }, action)),
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
      this.#popover.setAttribute('role', 'dialog');
      this.#popover.replaceChildren(form);
      this.#show(at);
      input.focus();
    });
  }

  /** Any content (e.g. the share panel). */
  show(at, ...content) {
    this.#rememberFocus();
    this.#popover.setAttribute('role', 'dialog');
    this.#popover.replaceChildren(h('div', { className: 'menu__content' }, ...content));
    this.#show(at);
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
