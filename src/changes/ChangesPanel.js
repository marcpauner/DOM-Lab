import { h } from '../lib/dom.js';
import { whitespaceSymbols } from '../tree/renderRow.js';
import './changes.css';

const MAX_ENTRIES = 1000;
const MAX_LABELS = 4; // nodes named in one entry; the rest are counted

const preview = (value) => {
  if (value === null) return '';
  if (/^[ \t\n\f\r]*$/.test(value)) return whitespaceSymbols(value);
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
};

/**
 * History of DOM changes: one entry per MutationRecord, newest at the
 * bottom, with the time since the code started running. Consecutive
 * identical changes (an animation updating the same attribute, a loop adding
 * the same kind of node) are grouped with a counter.
 *
 * Events it emits:
 *   - "count"        { count }   number of changes, for the tab badge
 *   - "select-node"  { id }      click on a node
 */
export class ChangesPanel extends EventTarget {
  #host;
  #list;
  #empty;
  #start = Date.now();
  #count = 0;
  #last = null; // { key, badge, time, value, repeat }
  hideWhitespace = true;

  constructor(host) {
    super();
    this.#host = host;
    this.#list = h('div', { className: 'changes', role: 'log', 'aria-label': 'History of DOM changes' });
    this.#empty = h(
      'p',
      { className: 'changes__empty' },
      'Every change your JavaScript makes to the DOM after the page has loaded shows up here: ',
      'nodes added or removed, attributes and text. Try a setTimeout, or a button with a click listener.',
    );
    host.append(this.#list, this.#empty);
    this.#list.addEventListener('click', (event) => {
      const target = event.target.closest('button[data-node-id]');
      if (target) this.dispatchEvent(new CustomEvent('select-node', { detail: { id: Number(target.dataset.nodeId) } }));
    });
  }

  /** A new run: the history is cleared and the clock starts again. */
  reset(start = Date.now()) {
    this.#start = start;
    this.clear();
  }

  clear() {
    this.#list.replaceChildren();
    this.#last = null;
    this.#count = 0;
    this.#empty.hidden = false;
    this.#emitCount();
  }

  /** @param {import('../protocol/messages.js').ChangeRecord[]} records */
  add(records, dropped = 0) {
    const atBottom = this.#host.scrollHeight - this.#host.scrollTop - this.#host.clientHeight < 32;
    for (const record of records) this.#append(record);
    if (dropped > 0) this.system(`${dropped} more changes in that batch are not listed.`);
    while (this.#list.childElementCount > MAX_ENTRIES) this.#list.firstElementChild.remove();
    if (atBottom) this.#host.scrollTop = this.#host.scrollHeight;
  }

  /** A note from the app itself. */
  system(text) {
    this.#empty.hidden = true;
    this.#last = null;
    this.#list.append(h('div', { className: 'change change--system' }, h('span', { className: 'change__icon' }), h('div', { className: 'change__body' }, text)));
  }

  #append(record) {
    let message = this.#describe(record);
    if (!message) return;
    this.#empty.hidden = true;

    // Moving a node (appendChild / insertBefore with a node that is already in
    // the document) produces two records: removed from its old parent, added to
    // the new one. Shown together, it makes clear that a node is never copied.
    const single = record.type === 'childList' && message.kind === 'added' && record.added.length === 1;
    const removal = this.#last?.removal;
    if (single && removal?.id === record.added[0].id && this.#last.repeat === 1) {
      const node = chip(removal.id, removal.label);
      const parts = removal.fromId === record.targetId
        ? ['Moved ', node, ' within ', chip(record.targetId, record.target)]
        : ['Moved ', node, ' from ', chip(removal.fromId, removal.from), ' to ', chip(record.targetId, record.target)];
      message = { kind: 'moved', signature: null, parts };
      this.#last.element.remove();
      this.#last = null;
    } else {
      this.#count++;
    }

    // The same change again (same node, same attribute, same kind of nodes): count it
    const key = JSON.stringify([message.kind, record.source, record.targetId, record.name, message.signature]);
    if (this.#last?.key === key) {
      this.#last.repeat++;
      this.#last.badge.textContent = `×${this.#last.repeat}`;
      this.#last.badge.hidden = false;
      this.#last.time.textContent = this.#elapsed(record.time);
      if (message.value) this.#last.value.replaceWith(message.value);
      this.#last.value = message.value;
      this.#emitCount();
      return;
    }

    const badge = h('span', { className: 'change__repeat', hidden: true });
    const time = h('time', { className: 'change__time' }, this.#elapsed(record.time));
    // Changes you made from DOM Lab's interface, as opposed to the ones your code made
    const source = record.source === 'app' ? h('span', { className: 'change__source', title: 'Made from the DOM Lab interface' }, 'edit') : null;
    const element = h(
      'div',
      { className: `change change--${message.kind}` },
      h('span', { className: 'change__icon', 'aria-hidden': 'true' }),
      h('div', { className: 'change__body' }, ...message.parts),
      h('span', { className: 'change__meta' }, source, badge, time),
    );
    this.#list.append(element);
    const removed = record.type === 'childList' && message.kind === 'removed' && record.removed.length === 1 ? record.removed[0] : null;
    this.#last = {
      key,
      badge,
      time,
      element,
      value: message.value,
      repeat: 1,
      removal: removed && { id: removed.id, label: removed.label, fromId: record.targetId, from: record.target },
    };
    this.#emitCount();
  }

  /** Turns a ChangeRecord into a sentence made of text and node chips. */
  #describe(record) {
    const target = chip(record.targetId, record.target);
    if (record.type === 'childList') {
      const visible = (refs) => (this.hideWhitespace ? refs.filter((ref) => !ref.whitespace) : refs);
      const added = visible(record.added);
      const removed = visible(record.removed);
      if (added.length === 0 && removed.length === 0) return null; // only whitespace nodes
      const signature = [added.map((ref) => ref.label), removed.map((ref) => ref.label)];
      if (added.length && removed.length) {
        return {
          kind: 'replaced',
          signature,
          parts: ['Replaced ', ...chips(removed, true), ' with ', ...chips(added), ' in ', target],
        };
      }
      return added.length
        ? { kind: 'added', signature, parts: ['Added ', ...chips(added), ' to ', target] }
        : { kind: 'removed', signature, parts: ['Removed ', ...chips(removed, true), ' from ', target] };
    }

    const value = h('span', { className: 'change__value' }, preview(record.value));
    if (record.type === 'characterData') {
      // The target's label already shows the new text, so the chip just says what kind of node it is
      const node = chip(record.targetId, record.target.startsWith('<!--') ? 'comment' : '#text');
      return {
        kind: 'text',
        signature: null,
        value,
        parts: ['Changed ', node, ': "', h('span', { className: 'change__old' }, preview(record.oldValue)), '" → "', value, '"'],
      };
    }
    const name = h('code', { className: 'change__attr' }, record.name);
    if (record.oldValue === null) {
      return { kind: 'attribute', signature: null, value, parts: ['Set ', name, '="', value, '" on ', target] };
    }
    if (record.value === null) {
      return {
        kind: 'removed',
        signature: null,
        parts: ['Removed ', name, ' from ', target, ' (was "', h('span', { className: 'change__old' }, preview(record.oldValue)), '")'],
      };
    }
    return {
      kind: 'attribute',
      signature: null,
      value,
      parts: [target, ' ', name, ': "', h('span', { className: 'change__old' }, preview(record.oldValue)), '" → "', value, '"'],
    };
  }

  #elapsed(time) {
    return `${Math.max(0, (time - this.#start) / 1000).toFixed(2)} s`;
  }

  #emitCount() {
    this.dispatchEvent(new CustomEvent('count', { detail: { count: this.#count } }));
  }
}

/** A node in a sentence. Nodes still in the document can be hovered and clicked. */
function chip(id, label, removed = false) {
  if (removed || id === null) return h('span', { className: `change__node${removed ? ' change__node--removed' : ''}` }, label);
  return h('button', { className: 'change__node', type: 'button', title: 'Select in the tree', dataset: { nodeId: id } }, label);
}

function chips(refs, removed = false) {
  const parts = [];
  refs.slice(0, MAX_LABELS).forEach((ref, index) => {
    if (index > 0) parts.push(', ');
    parts.push(chip(ref.id, ref.whitespace ? `#text ${whitespaceSymbols('\n')}` : ref.label, removed));
  });
  if (refs.length > MAX_LABELS) parts.push(` and ${refs.length - MAX_LABELS} more`);
  return parts;
}
