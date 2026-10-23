import { h } from '../lib/dom.js';
import './overlay.css';

const round = (value) => Math.round(value * 10) / 10;

/**
 * DevTools-style box model overlay, drawn by the APP on top of the iframe:
 * margin (orange), border (yellow), padding (green) and content (blue).
 * Drawing it here instead of inside the preview keeps the user's DOM untouched.
 *
 * Four nested layers do the trick: each one is the size of its parent's
 * inner area, and its CSS border widths are the margin / border / padding
 * values. That way every band is a ring with its own color and none overlap.
 */
export class Overlay {
  #root;
  #margin;
  #border;
  #padding;
  #label;
  #name;
  #size;

  constructor(host) {
    this.#padding = h('div', { className: 'overlay__padding' }, h('div', { className: 'overlay__content' }));
    this.#border = h('div', { className: 'overlay__border' }, this.#padding);
    this.#margin = h('div', { className: 'overlay__margin' }, this.#border);
    this.#name = h('span', { className: 'overlay__name' });
    this.#size = h('span', { className: 'overlay__size' });
    this.#label = h('div', { className: 'overlay__label' }, this.#name, this.#size);
    this.#root = h('div', { className: 'overlay', 'aria-hidden': 'true' }, this.#margin, this.#label);
    host.append(this.#root);
  }

  /** @param {import('../protocol/messages.js').Box} box */
  show(box, label) {
    // Negative margins pull other boxes closer; they are not drawn
    const margin = box.margin.map((value) => Math.max(0, value));
    const [top, right, bottom, left] = margin;
    const outer = {
      x: box.x - left,
      y: box.y - top,
      width: box.width + left + right,
      height: box.height + top + bottom,
    };

    Object.assign(this.#margin.style, {
      transform: `translate(${outer.x}px, ${outer.y}px)`,
      width: `${outer.width}px`,
      height: `${outer.height}px`,
      borderWidth: sides(margin),
    });
    this.#border.style.borderWidth = sides(box.border);
    this.#padding.style.borderWidth = sides(box.padding);

    this.#name.textContent = label;
    this.#size.textContent = `${round(box.width)} × ${round(box.height)}`;
    this.#root.classList.add('is-visible');
    this.#placeLabel(outer);
  }

  hide() {
    this.#root.classList.remove('is-visible');
  }

  /** Above the element if it fits, otherwise below it, otherwise pinned to the top. */
  #placeLabel(outer) {
    const gap = 6;
    const { clientWidth, clientHeight } = this.#root;
    const { offsetWidth, offsetHeight } = this.#label;
    const above = outer.y - offsetHeight - gap;
    const below = outer.y + outer.height + gap;
    let y = gap;
    if (above >= gap) y = above;
    else if (below + offsetHeight <= clientHeight - gap) y = below;
    const x = Math.min(Math.max(gap, outer.x), clientWidth - offsetWidth - gap);
    this.#label.style.transform = `translate(${Math.max(gap, x)}px, ${y}px)`;
  }
}

const sides = ([top, right, bottom, left]) => `${top}px ${right}px ${bottom}px ${left}px`;
