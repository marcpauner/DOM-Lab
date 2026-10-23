import { h } from '../lib/dom.js';
import { FILE_NAMES } from '../preview/srcdoc.js';
import './console.css';

const MAX_ENTRIES = 1000;

const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/**
 * Our own console: shows the console.* calls and errors sent by the agent.
 *
 * Events it emits:
 *   - "counts"       { error, warn }           for the header badges
 *   - "goto"         { file, line, column }    click on "script.js:12:5"
 *   - "reveal-node"  { id }                    click on a DOM node logged with console.log
 */
export class ConsolePanel extends EventTarget {
  #host;
  #list;
  #empty;
  #locate;
  #counts = { error: 0, warn: 0 };
  #last = null; // { key, badge, repeat }

  /** @param {(line: number, column: number) => ({ file: string, line: number, column: number } | null)} locate */
  constructor(host, { locate }) {
    super();
    this.#host = host;
    this.#locate = locate;
    this.#list = h('div', { className: 'console', role: 'log', 'aria-label': 'Console messages' });
    this.#empty = h(
      'p',
      { className: 'console__empty' },
      'Anything you write with ',
      h('code', {}, 'console.log()'),
      ' and the errors in your code show up here.',
    );
    host.append(this.#list, this.#empty);
    this.#list.addEventListener('click', (event) => this.#onClick(event));
  }

  /** @param {import('../protocol/messages.js').ConsoleEntry[]} entries */
  add(entries, dropped = 0) {
    const atBottom = this.#host.scrollHeight - this.#host.scrollTop - this.#host.clientHeight < 32;
    for (const entry of entries) {
      if (entry.kind === 'clear') this.clear('console.clear()');
      else this.#append(entry);
    }
    if (dropped > 0) this.system(`${dropped} more messages skipped: too many in too little time.`, 'warn');
    if (atBottom) this.#host.scrollTop = this.#host.scrollHeight;
  }

  /** A message from the app itself (not from the user's code). */
  system(text, level = 'info') {
    this.#append({ kind: 'system', level, args: [{ type: 'string', text }], time: Date.now() });
  }

  clear(reason) {
    this.#list.replaceChildren();
    this.#last = null;
    this.#counts = { error: 0, warn: 0 };
    this.#emitCounts();
    this.#empty.hidden = Boolean(reason);
    if (reason) this.system(`Console was cleared with ${reason}`);
  }

  #append(entry) {
    this.#empty.hidden = true;
    const location = entry.location ? this.#locate(entry.location.line, entry.location.column) : null;

    // Identical consecutive messages are grouped with a counter (like DevTools)
    const key = JSON.stringify([entry.kind, entry.level, entry.args, location]);
    if (this.#last?.key === key) {
      this.#last.repeat++;
      this.#last.badge.textContent = String(this.#last.repeat);
      this.#last.badge.hidden = false;
      this.#count(entry.level);
      return;
    }

    const badge = h('span', { className: 'log__repeat', hidden: true });
    const meta = h('span', { className: 'log__meta' }, badge);
    if (location) {
      meta.append(
        h(
          'button',
          {
            className: 'log__location',
            type: 'button',
            title: 'Go to this line',
            dataset: { file: location.file, line: location.line, column: location.column },
          },
          `${FILE_NAMES[location.file]}:${location.line}:${location.column}`,
        ),
      );
    }
    meta.append(h('time', { className: 'log__time', dateTime: new Date(entry.time).toISOString() }, timeFormat.format(entry.time)));

    const message = h('div', { className: 'log__message' });
    entry.args.forEach((value, index) => {
      if (index > 0) message.append(' ');
      message.append(this.#renderValue(value));
    });

    const body = h('div', { className: 'log__body' }, message);
    if (entry.stack) {
      const stack = this.#cleanStack(entry.stack);
      if (stack) body.append(h('details', { className: 'log__stack' }, h('summary', {}, 'Stack trace'), h('pre', {}, stack)));
    }

    const row = h(
      'div',
      { className: `log log--${entry.level} log--${entry.kind}` },
      h('span', { className: 'log__icon', 'aria-hidden': 'true' }),
      body,
      meta,
    );
    this.#list.append(row);
    this.#last = { key, badge, repeat: 1 };
    this.#count(entry.level);

    while (this.#list.childElementCount > MAX_ENTRIES) this.#list.firstElementChild.remove();
  }

  /** @param {import('../protocol/messages.js').ConsoleValue} value */
  #renderValue(value) {
    if (value.type === 'node' && value.nodeId !== undefined) {
      return h(
        'button',
        { className: 'val val--node', type: 'button', title: 'Show in the tree', dataset: { nodeId: value.nodeId } },
        value.text,
      );
    }
    return h('span', { className: `val val--${value.type}` }, value.text);
  }

  /** Turns "about:srcdoc:57:3" into "script.js:12:3" and drops the first line (it repeats the message). */
  #cleanStack(stack) {
    return stack
      .split('\n')
      .slice(1)
      .map((line) =>
        line.replace(/about:srcdoc:(\d+):(\d+)/g, (match, line, column) => {
          const location = this.#locate(Number(line), Number(column));
          return location ? `${FILE_NAMES[location.file]}:${location.line}:${location.column}` : match;
        }),
      )
      .join('\n')
      .trim();
  }

  #count(level) {
    if (level !== 'error' && level !== 'warn') return;
    this.#counts[level]++;
    this.#emitCounts();
  }

  #emitCounts() {
    this.dispatchEvent(new CustomEvent('counts', { detail: { ...this.#counts } }));
  }

  #onClick(event) {
    const location = event.target.closest('.log__location');
    if (location) {
      const { file, line, column } = location.dataset;
      this.dispatchEvent(new CustomEvent('goto', { detail: { file, line: Number(line), column: Number(column) } }));
      return;
    }
    const node = event.target.closest('.val--node');
    if (node) this.dispatchEvent(new CustomEvent('reveal-node', { detail: { id: Number(node.dataset.nodeId) } }));
  }
}
