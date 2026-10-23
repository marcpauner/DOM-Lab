import { h } from '../lib/dom.js';
import { renderRow } from './renderRow.js';
import './tree.css';

const ROW_HEIGHT = 26;
const OVERSCAN = 8; // extra rows above and below so scrolling never shows gaps
const ANIMATION_MS = 260;
const MAX_ANIMATED_CHANGE = 200; // if more rows change at once, skip the animation (it would not show anyway)
const COLLAPSED_BY_DEFAULT = new Set(['HEAD', 'SCRIPT', 'STYLE']);

const rowY = (index) => `translateY(${index * ROW_HEIGHT}px)`;

/**
 * VIRTUALIZED DOM tree.
 *
 * With thousands of nodes we cannot create thousands of <div>s: the browser
 * would stutter. Instead:
 *   1. We "flatten" the tree: a list of the visible nodes in order (the
 *      children of a collapsed node are not in it).
 *   2. We only create rows for the part of that list that fits on screen.
 *   3. Each row is placed with transform: translateY(index × row height)
 *      inside a canvas as tall as the whole list (so the scrollbar is real).
 *
 * Rows are keyed by node id: when expanding or collapsing, the rows that
 * stay on screen only change their translateY, and a CSS transition slides
 * them into place. New rows fade in.
 */
export class TreeView extends EventTarget {
  #scroller;
  #canvas;
  #placeholder;
  /** @type {import('./model.js').TreeModel|null} */
  #model = null;
  #rows = []; // flattened tree
  #indexById = new Map();
  #rendered = new Map(); // id → row currently in the DOM
  #leaving = new Set(); // rows on their way out (exit animation)
  #expanded = new Map(); // path → expanded/collapsed (what the user chose)
  #selectedId = null;
  #selectedPath = null;
  #selectedNode = null; // kept even if the node is removed: its .parent says where the selection goes
  #hoveredId = null; // node under the pointer in the preview (inspect mode)
  #hideWhitespace = true;
  #canvasTop = 0;
  #frame = 0;
  #animationTimer = 0;

  constructor(scroller) {
    super();
    this.#scroller = scroller;
    scroller.classList.add('tree');
    scroller.setAttribute('role', 'tree');
    scroller.setAttribute('aria-label', 'DOM tree');
    scroller.tabIndex = 0;
    scroller.style.setProperty('--row-h', `${ROW_HEIGHT}px`);

    this.#canvas = h('div', { className: 'tree__canvas' });
    this.#placeholder = h('div', { className: 'tree__placeholder' }, 'Waiting for the preview…');
    scroller.append(this.#canvas, this.#placeholder);

    scroller.addEventListener('scroll', () => this.#scheduleRender(), { passive: true });
    scroller.addEventListener('click', (event) => this.#onClick(event));
    scroller.addEventListener('dblclick', (event) => this.#onDoubleClick(event));
    scroller.addEventListener('keydown', (event) => this.#onKeyDown(event));
    // If the panel changes size, more or fewer rows fit
    new ResizeObserver(() => {
      this.#canvasTop = this.#canvas.offsetTop;
      this.#scheduleRender();
    }).observe(scroller);
  }

  /** @param {import('./model.js').TreeModel} model */
  setModel(model) {
    this.#model = model;
    this.#placeholder.hidden = true;
    // Keep the selection even though ids change, thanks to the path
    const selected = this.#selectedPath === null ? null : (model.byPath.get(this.#selectedPath) ?? null);
    this.#selectedId = selected?.id ?? null;
    this.#selectedNode = selected;
    this.#rebuild();
    this.dispatchEvent(new CustomEvent('select', { detail: selected }));
  }

  /** Message shown instead of the tree (only while there is none yet). */
  setPlaceholder(text) {
    this.#placeholder.textContent = text;
    this.#placeholder.hidden = this.#model !== null;
  }

  setHideWhitespace(hide) {
    this.#hideWhitespace = hide;
    this.#rebuild();
  }

  expandAll() {
    for (const node of this.#model?.byId.values() ?? []) {
      if (node.children.length > 0) this.#expanded.set(node.path, true);
    }
    this.#update(false);
  }

  collapseAll() {
    for (const node of this.#model?.byId.values() ?? []) {
      if (node.children.length > 0) this.#expanded.set(node.path, node === this.#model.root);
    }
    this.#scroller.scrollTop = 0;
    this.#update(false);
  }

  /** Expands or collapses a node. With deep, all of its descendants too. */
  toggle(node, expand = !this.#isExpanded(node), { deep = false } = {}) {
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.children.length > 0) this.#expanded.set(current.path, expand);
      if (deep) stack.push(...current.children);
    }
    this.#update(true);
  }

  /** Selects a node. With reveal, expands its ancestors and flashes it. */
  select(id, { reveal = false } = {}) {
    const node = this.#model?.byId.get(id);
    if (!node || (node.isWhitespace && this.#hideWhitespace)) return false;
    if (reveal) {
      for (let parent = node.parent; parent; parent = parent.parent) this.#expanded.set(parent.path, true);
      this.#update(false);
    }
    this.#setSelected(node);
    this.#scrollIntoView(this.#indexById.get(id));
    if (reveal) {
      this.#render();
      const row = this.#rendered.get(id);
      row?.classList.remove('is-flashing');
      void row?.offsetWidth; // restarts the animation if it was already running
      row?.classList.add('is-flashing');
    }
    return true;
  }

  /**
   * Marks the node the pointer is over in the preview. With reveal, expands
   * its ancestors and scrolls to it (like DevTools while inspecting).
   */
  setHovered(id, { reveal = false } = {}) {
    if (id === this.#hoveredId) return;
    this.#rendered.get(this.#hoveredId)?.classList.remove('is-hovered');
    this.#hoveredId = id;
    const node = id === null ? null : this.#model?.byId.get(id);
    if (!node || (node.isWhitespace && this.#hideWhitespace)) return;
    if (reveal) {
      let expanded = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (this.#isExpanded(parent)) continue;
        this.#expanded.set(parent.path, true);
        expanded = true;
      }
      if (expanded) this.#update(false);
      this.#scrollIntoView(this.#indexById.get(id));
      this.#render();
    }
    this.#rendered.get(id)?.classList.add('is-hovered');
  }

  /**
   * Live changes (see applyPatches in model.js): the model has already been
   * updated in place. Rows whose content changed are drawn again and flash:
   * green for new nodes, purple for changed text or attributes.
   * @param {import('./model.js').ChangeSummary} summary
   */
  applyChanges({ added, changed, structural }) {
    if (!this.#model) return;
    // Paths shift when siblings are added or removed
    if (this.#model.byId.get(this.#selectedId) === this.#selectedNode) this.#selectedPath = this.#selectedNode?.path ?? null;

    for (const id of [...changed.keys(), ...added]) {
      this.#rendered.get(id)?.remove();
      this.#rendered.delete(id);
    }
    if (structural) this.#update(true);
    else this.#render();

    for (const id of added) this.#flash(this.#rendered.get(id), 'added');
    for (const [id, change] of changed) {
      const row = this.#rendered.get(id);
      if (!row || added.has(id)) continue;
      if (change.text) this.#flash(row, 'changed');
      for (const name of change.attributes) {
        // Only the attribute's pill flashes; a removed attribute has no pill left, so the row does
        const pill = [...row.querySelectorAll('.tok-attr')].find((element) => element.dataset.attr === name);
        this.#flash(pill ?? row, 'changed');
      }
    }
  }

  get selectedId() {
    return this.#selectedId;
  }

  get selectedNode() {
    return this.#selectedId === null ? null : (this.#model?.byId.get(this.#selectedId) ?? null);
  }

  focus() {
    this.#scroller.focus({ preventScroll: true });
  }

  // ── State ───────────────────────────────────────────────────────

  #isExpanded(node) {
    const saved = this.#expanded.get(node.path);
    if (saved !== undefined) return saved;
    if (node.nodeType !== Node.ELEMENT_NODE) return true; // document and fragments
    return node.depth <= 6 && node.children.length <= 100 && !COLLAPSED_BY_DEFAULT.has(node.nodeName.toUpperCase());
  }

  #visibleChildren(node) {
    return this.#hideWhitespace ? node.children.filter((child) => !child.isWhitespace) : node.children;
  }

  #setSelected(node) {
    const id = node?.id ?? null;
    if (id === this.#selectedId && node?.path === this.#selectedPath) return;
    const previous = this.#rendered.get(this.#selectedId);
    previous?.classList.remove('is-selected');
    previous?.setAttribute('aria-selected', 'false');

    this.#selectedId = id;
    this.#selectedPath = node?.path ?? null;
    this.#selectedNode = node ?? null;
    const current = this.#rendered.get(id);
    current?.classList.add('is-selected');
    current?.setAttribute('aria-selected', 'true');
    if (node) this.#scroller.setAttribute('aria-activedescendant', `tree-row-${id}`);
    else this.#scroller.removeAttribute('aria-activedescendant');
    this.dispatchEvent(new CustomEvent('select', { detail: node }));
  }

  /**
   * If the selected node ended up inside a collapsed one, or was removed
   * from the document, the selection moves up to the closest visible ancestor.
   */
  #keepSelectionVisible() {
    if (this.#selectedId === null || this.#indexById.has(this.#selectedId)) return;
    let node = this.#selectedNode?.parent;
    while (node && !this.#indexById.has(node.id)) node = node.parent;
    this.#setSelected(node ?? null);
  }

  #flash(element, kind) {
    if (!element) return;
    element.classList.remove('flash-added', 'flash-changed');
    void element.offsetWidth; // restarts the animation if it was already running
    element.classList.add(`flash-${kind}`);
  }

  // ── Rendering ───────────────────────────────────────────────────

  /** Throws away every rendered row and starts over (new model or filter). */
  #rebuild() {
    this.#canvas.replaceChildren();
    this.#rendered.clear();
    this.#leaving.clear();
    this.#update(false);
  }

  #update(animate) {
    const previous = this.#indexById;
    const previousLength = this.#rows.length;
    this.#flatten();
    this.#keepSelectionVisible();
    this.#canvas.style.height = `${this.#rows.length * ROW_HEIGHT}px`;
    const smallChange = Math.abs(this.#rows.length - previousLength) <= MAX_ANIMATED_CHANGE;
    this.#render(animate && smallChange ? previous : null);
  }

  /** Depth-first (pre-order) walk of the visible nodes. */
  #flatten() {
    const rows = [];
    const indexById = new Map();
    const stack = this.#model ? [this.#model.root] : [];
    while (stack.length > 0) {
      const node = stack.pop();
      indexById.set(node.id, rows.length);
      rows.push(node);
      if (this.#isExpanded(node)) {
        const children = this.#visibleChildren(node);
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
    this.#rows = rows;
    this.#indexById = indexById;
  }

  #scheduleRender() {
    if (!this.#frame) this.#frame = requestAnimationFrame(() => this.#render());
  }

  #visibleRange() {
    const top = this.#scroller.scrollTop - this.#canvasTop;
    const bottom = top + this.#scroller.clientHeight;
    return {
      start: Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN),
      end: Math.min(this.#rows.length, Math.ceil(bottom / ROW_HEIGHT) + OVERSCAN),
    };
  }

  /**
   * Syncs the DOM rows with the visible part of the list.
   * @param {Map<number, number>|null} previousIndex  Positions before the change (when animating)
   */
  #render(previousIndex = null) {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    const animate = previousIndex !== null;
    const { start, end } = this.#visibleRange();
    const visible = new Set();
    const moves = []; // [row, new index], applied after the reflow
    let created = false;

    for (let i = start; i < end; i++) {
      const node = this.#rows[i];
      visible.add(node.id);
      let row = this.#rendered.get(node.id);
      if (!row) {
        row = renderRow(node, { childCount: this.#visibleChildren(node).length });
        const from = animate ? previousIndex.get(node.id) : undefined;
        // Was it already in the list (off screen)? It slides in from its old place.
        // Is it new (its parent was just expanded)? It fades in.
        row.style.transform = rowY(from ?? i);
        if (animate && from === undefined) row.classList.add('is-entering');
        this.#rendered.set(node.id, row);
        this.#canvas.append(row);
        created = true;
      }
      this.#syncRow(row, node);
      if (animate) moves.push([row, i]);
      else row.style.transform = rowY(i);
    }

    // Rendered rows that are no longer in the visible part
    for (const [id, row] of this.#rendered) {
      if (visible.has(id)) continue;
      this.#rendered.delete(id);
      if (!animate) {
        row.remove();
        continue;
      }
      const index = this.#indexById.get(id);
      if (index === undefined) row.classList.add('is-leaving'); // its parent was collapsed
      else moves.push([row, index]); // still in the list, but leaving the screen
      this.#leaving.add(row);
    }

    if (!animate) return;
    this.#canvas.classList.add('is-animating');
    // Reading offsetHeight forces the browser to compute the current styles:
    // that way new rows "start" from their initial position and the transition shows.
    if (created) void this.#canvas.offsetHeight;
    for (const [row, index] of moves) {
      row.style.transform = rowY(index);
      row.classList.remove('is-entering');
    }
    clearTimeout(this.#animationTimer);
    this.#animationTimer = setTimeout(() => {
      this.#canvas.classList.remove('is-animating');
      for (const row of this.#leaving) row.remove();
      this.#leaving.clear();
    }, ANIMATION_MS);
  }

  #syncRow(row, node) {
    if (row.classList.contains('has-children')) row.setAttribute('aria-expanded', String(this.#isExpanded(node)));
    const selected = node.id === this.#selectedId;
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-hovered', node.id === this.#hoveredId);
    row.setAttribute('aria-selected', String(selected));
  }

  #scrollIntoView(index) {
    if (index === undefined) return;
    // The translucent header covers the first #canvasTop pixels
    const rowTop = index * ROW_HEIGHT;
    const minScroll = this.#canvasTop + rowTop + ROW_HEIGHT - this.#scroller.clientHeight + 4;
    if (this.#scroller.scrollTop > rowTop) this.#scroller.scrollTop = rowTop;
    else if (this.#scroller.scrollTop < minScroll) this.#scroller.scrollTop = minScroll;
  }

  // ── Interaction ─────────────────────────────────────────────────

  #nodeFromEvent(event) {
    const row = event.target.closest('.tree-row');
    return row ? (this.#model?.byId.get(Number(row.dataset.nodeId)) ?? null) : null;
  }

  #onClick(event) {
    const node = this.#nodeFromEvent(event);
    if (!node) return;
    // Alt + click on the arrow: also expands or collapses every descendant
    if (event.target.closest('.tree-row__twisty') && this.#visibleChildren(node).length > 0) {
      this.toggle(node, undefined, { deep: event.altKey });
    }
    this.#setSelected(node);
  }

  #onDoubleClick(event) {
    if (event.target.closest('.tree-row__twisty')) return;
    const node = this.#nodeFromEvent(event);
    if (node && this.#visibleChildren(node).length > 0) this.toggle(node);
  }

  #onKeyDown(event) {
    if (this.#rows.length === 0 || event.ctrlKey || event.metaKey) return;
    let index = this.#indexById.get(this.#selectedId) ?? -1;
    const node = this.#rows[index];
    const expandable = node ? this.#visibleChildren(node).length > 0 : false;
    const expanded = expandable && this.#isExpanded(node);
    const page = Math.max(1, Math.floor((this.#scroller.clientHeight - this.#canvasTop) / ROW_HEIGHT) - 1);

    switch (event.key) {
      case 'ArrowDown':
        index += 1;
        break;
      case 'ArrowUp':
        index -= 1;
        break;
      case 'PageDown':
        index += page;
        break;
      case 'PageUp':
        index -= page;
        break;
      case 'Home':
        index = 0;
        break;
      case 'End':
        index = this.#rows.length - 1;
        break;
      case 'ArrowRight':
        if (expandable && (!expanded || event.altKey)) {
          event.preventDefault();
          this.toggle(node, true, { deep: event.altKey });
          return;
        }
        if (expandable) index += 1; // first child
        break;
      case 'ArrowLeft':
        if (expandable && expanded) {
          event.preventDefault();
          this.toggle(node, false, { deep: event.altKey });
          return;
        }
        if (node?.parent) index = this.#indexById.get(node.parent.id);
        break;
      case 'Enter':
      case ' ':
        if (expandable) this.toggle(node, undefined, { deep: event.altKey });
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    index = Math.min(Math.max(0, index), this.#rows.length - 1);
    this.#setSelected(this.#rows[index]);
    this.#scrollIntoView(index);
  }
}
