/* global PROTOCOL, CONFIG */
/*
 * PREVIEW AGENT
 * ─────────────
 * This code does NOT run in the app. preview/srcdoc.js imports it as text
 * (agent.js?raw) and injects it into the iframe's <head>, BEFORE the user's
 * code. That is why:
 *   - it has no import/export: PROTOCOL and CONFIG are defined for it;
 *   - it lives in an opaque origin ("null"): it cannot touch the app and the
 *     app cannot touch this document. They only talk through postMessage.
 */

const { CHANNEL, VERSION, FROM_AGENT, TO_AGENT, LIMITS } = PROTOCOL;
const { runId, appOrigin } = CONFIG;

// Grab what we need BEFORE the user's code runs: if it later redefines
// setTimeout or console.log, the agent keeps working.
const appWindow = window.parent;
const schedule = window.setTimeout.bind(window);

function send(type, payload) {
  // The second argument (targetOrigin) guarantees the message is only
  // delivered if the parent window really is the app.
  appWindow.postMessage({ channel: CHANNEL, version: VERSION, runId, type, payload }, appOrigin);
}

const truncate = (text, max) => (text.length > max ? text.slice(0, max) : text);

// ── 1. Stable identifiers ───────────────────────────────────────────
// Every node gets a number that never changes while it exists, so the app
// and the agent can talk about "node 42". We use a WeakMap (node → id)
// because it does not stop the garbage collector from freeing nodes the
// user removes; a regular Map would keep them alive forever.
const ids = new WeakMap();
let nextId = 1;

// The reverse direction (id → node) is needed to obey commands such as
// "highlight node 42". A WeakRef points to the node without keeping it
// alive, and the FinalizationRegistry drops the entry once it is collected.
const refs = new Map();
const cleanup = new FinalizationRegistry((id) => refs.delete(id));

function idOf(node) {
  let id = ids.get(node);
  if (id === undefined) {
    id = nextId++;
    ids.set(node, id);
    refs.set(id, new WeakRef(node));
    cleanup.register(node, id);
  }
  return id;
}

const nodeOf = (id) => refs.get(id)?.deref() ?? null;

// ── 2. Serializing the DOM ──────────────────────────────────────────
// postMessage copies data with the "structured clone algorithm", which does
// not support DOM nodes. So we walk the tree and turn it into plain objects
// (see SerializedNode in protocol/messages.js).

// Nodes the app already has in its tree. Live updates refer to them by id
// and only send new nodes in full.
let known = new WeakSet();

/** childNodes, plus the "hidden" children: shadow root and <template> content. */
function childrenOf(node) {
  const kids = [];
  if (node.shadowRoot) kids.push(node.shadowRoot);
  // A <template>'s content is not in childNodes but in a separate
  // DocumentFragment: template.content
  if (node instanceof HTMLTemplateElement) kids.push(node.content);
  // childNodes includes ALL children (elements, text, comments);
  // children would only include the elements.
  kids.push(...node.childNodes);
  return kids;
}

function serialize(node, depth, budget) {
  budget.left--;
  known.add(node);
  const out = { id: idOf(node), nodeType: node.nodeType, nodeName: node.nodeName };

  switch (node.nodeType) {
    case Node.ELEMENT_NODE:
      // node.attributes is a NamedNodeMap; we turn it into [name, value] pairs.
      out.attributes = Array.from(node.attributes, (attr) => [
        attr.name,
        truncate(attr.value, LIMITS.MAX_ATTR_VALUE),
      ]);
      break;
    case Node.TEXT_NODE:
    case Node.COMMENT_NODE:
    case Node.CDATA_SECTION_NODE:
    case Node.PROCESSING_INSTRUCTION_NODE:
      // These nodes have no children: their content lives in .data
      out.value = truncate(node.data, LIMITS.MAX_TEXT);
      if (node.data.length > LIMITS.MAX_TEXT) out.truncated = true;
      return out;
    case Node.DOCUMENT_TYPE_NODE:
      return out; // <!DOCTYPE html>: nodeName is "html"
    case Node.DOCUMENT_FRAGMENT_NODE:
      if (node instanceof ShadowRoot) out.mode = node.mode;
      break;
  }

  out.children = [];
  if (depth >= LIMITS.MAX_DEPTH) {
    budget.truncated = true;
    return out;
  }
  for (const child of childrenOf(node)) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    out.children.push(serialize(child, depth + 1, budget));
  }
  return out;
}

function sendSnapshot() {
  // A full snapshot replaces the app's tree: start the "known" list over,
  // and drop pending changes (the snapshot already includes them).
  known = new WeakSet();
  pendingRecords.length = 0;
  observer.takeRecords();
  const budget = { left: LIMITS.MAX_NODES, truncated: false };
  const root = serialize(document, 0, budget);
  send(FROM_AGENT.SNAPSHOT, { root, truncated: budget.truncated });
  startObserving();
}

// ── 2b. Live updates: MutationObserver ──────────────────────────────
// After the first snapshot, a MutationObserver reports every change to the
// DOM. Records are batched for a few milliseconds, then turned into:
//   - patches: the CURRENT state of whatever changed ("ul#list now has these
//     children", "li now has these attributes"). Replaying each record one by
//     one would be fragile: by the time the callback runs, the DOM may have
//     changed again. Applying a patch twice gives the same result.
//   - records: what happened and when, for the history of changes.
const OBSERVE = {
  childList: true,
  attributes: true,
  characterData: true,
  subtree: true, // the whole document, not just the node we observe
  attributeOldValue: true,
  characterDataOldValue: true,
};
const BATCH_MS = 50;
const pendingRecords = []; // { record, time }
let flushTimer = 0;
let observing = false;

const observer = new MutationObserver((records) => {
  const time = Date.now();
  for (const record of records) pendingRecords.push({ record, time });
  if (!flushTimer) flushTimer = schedule(flushMutations, BATCH_MS);
});
// Saved now: the user's code could replace MutationObserver.prototype.observe later
const observe = MutationObserver.prototype.observe;

function startObserving() {
  if (observing) return;
  observing = true;
  observe.call(observer, document, OBSERVE);
}

/** A removed node and its subtree are no longer in the app's tree. */
function forgetSubtree(node) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    known.delete(current);
    stack.push(...childrenOf(current));
  }
}

const isWhitespaceText = (node) => node.nodeType === Node.TEXT_NODE && /^[ \t\n\f\r]*$/.test(node.data);
const nodeRef = (node) => ({ id: idOf(node), label: nodeLabel(node), whitespace: isWhitespaceText(node) });

function liveValue(record) {
  return record.type === 'attributes' ? record.target.getAttribute(record.attributeName) : record.target.data;
}

function flushMutations() {
  flushTimer = 0;
  const time = Date.now();
  const batch = pendingRecords.splice(0);
  for (const record of observer.takeRecords()) batch.push({ record, time });
  if (batch.length === 0) return;

  if (batch.length > LIMITS.MAX_MUTATIONS) {
    send(FROM_AGENT.MUTATIONS, { patches: [], records: [], dropped: 0, overflow: batch.length });
    sendSnapshot();
    return;
  }

  // Nodes that left the document stop being "known": if they come back,
  // they are sent in full again (with the same id, thanks to the WeakMap).
  for (const { record } of batch) {
    for (const node of record.removedNodes) if (!node.isConnected) forgetSubtree(node);
  }

  const parents = new Set();
  const elements = new Set();
  const texts = new Set();
  for (const { record } of batch) {
    if (record.type === 'childList') parents.add(record.target);
    else if (record.type === 'attributes') elements.add(record.target);
    else texts.add(record.target);
  }

  const patches = [];
  const budget = { left: LIMITS.MAX_NODES, truncated: false };
  const current = (node) => known.has(node) && node.isConnected;
  for (const parent of parents) {
    if (!current(parent)) continue;
    const children = childrenOf(parent).map((child) => (known.has(child) ? idOf(child) : serialize(child, 0, budget)));
    patches.push({ op: 'children', id: idOf(parent), children });
  }
  for (const element of elements) {
    if (!current(element)) continue;
    const attributes = Array.from(element.attributes, (attr) => [attr.name, truncate(attr.value, LIMITS.MAX_ATTR_VALUE)]);
    patches.push({ op: 'attributes', id: idOf(element), attributes });
  }
  for (const node of texts) {
    if (!current(node)) continue;
    patches.push({ op: 'text', id: idOf(node), value: truncate(node.data, LIMITS.MAX_TEXT), truncated: node.data.length > LIMITS.MAX_TEXT });
  }

  // The value right AFTER each change is the oldValue of the next change to
  // the same attribute (or text), or the live value for the last one. So we
  // walk the batch backwards.
  const after = new Map(); // node → Map(attribute name → value)
  const values = [];
  for (let i = batch.length - 1; i >= 0; i--) {
    const { record } = batch[i];
    if (record.type === 'childList') continue;
    const key = record.attributeName ?? '#data';
    const byKey = after.get(record.target) ?? new Map();
    after.set(record.target, byKey);
    values[i] = byKey.has(key) ? byKey.get(key) : liveValue(record);
    byKey.set(key, record.oldValue);
  }

  const records = [];
  batch.slice(0, LIMITS.MAX_HISTORY).forEach(({ record, time: when }, index) => {
    const entry = { type: record.type, time: when, targetId: idOf(record.target), target: nodeLabel(record.target) };
    if (record.type === 'childList') {
      entry.added = Array.from(record.addedNodes).slice(0, 20).map(nodeRef);
      entry.removed = Array.from(record.removedNodes).slice(0, 20).map(nodeRef);
    } else {
      if (record.type === 'attributes') entry.name = record.attributeName;
      entry.oldValue = record.oldValue === null ? null : truncate(record.oldValue, 300);
      entry.value = values[index] === null ? null : truncate(values[index], 300);
    }
    records.push(entry);
  });

  send(FROM_AGENT.MUTATIONS, { patches, records, dropped: Math.max(0, batch.length - LIMITS.MAX_HISTORY), overflow: 0 });
}

// ── 3. Capturing the console and errors ─────────────────────────────
// Messages are batched and sent on the next "tick": a loop with 10,000
// console.log calls produces a single postMessage, not 10,000.
const queue = [];
let dropped = 0;
let flushPending = false;

function report(kind, level, values, extra) {
  if (queue.length < LIMITS.MAX_CONSOLE_BATCH) {
    queue.push({ kind, level, args: values.map(describe), time: Date.now(), ...extra });
  } else {
    dropped++;
  }
  if (!flushPending) {
    flushPending = true;
    schedule(flush, 0);
  }
}

function flush() {
  flushPending = false;
  send(FROM_AGENT.CONSOLE, { entries: queue.splice(0), dropped });
  dropped = 0;
}

/** Short CSS-selector-like label for a node: div#app.card */
function nodeLabel(node) {
  switch (node.nodeType) {
    case Node.ELEMENT_NODE: {
      let label = node.localName;
      if (node.id) label += `#${node.id}`;
      for (const name of node.classList) label += `.${name}`;
      return label;
    }
    case Node.TEXT_NODE:
      return `#text "${truncate(node.data, 40)}"`;
    case Node.COMMENT_NODE:
      return `<!--${truncate(node.data, 40)}-->`;
    case Node.DOCUMENT_TYPE_NODE:
      return `<!DOCTYPE ${node.name}>`;
    default:
      return node.nodeName; // #document, #document-fragment…
  }
}

const MAX_ITEMS = 20;

function constructorName(value) {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? '';
  } catch {
    return '';
  }
}

/** One-line preview of any value, similar to DevTools. */
function inline(value, depth) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return depth === 0 ? value : `'${truncate(value, 200)}'`;
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `ƒ ${value.name || 'anonymous'}()`;
    case 'boolean':
    case 'undefined':
      return String(value);
  }
  if (value instanceof Node) return nodeLabel(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Date || value instanceof RegExp) return String(value);

  const name = constructorName(value);
  const isList = Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection;
  if (depth >= 2) return isList ? `${name}(${value.length})` : name && name !== 'Object' ? name : '{…}';

  const parts = [];
  if (isList) {
    for (let i = 0; i < Math.min(value.length, MAX_ITEMS); i++) parts.push(inline(value[i], depth + 1));
    if (value.length > MAX_ITEMS) parts.push('…');
    const prefix = Array.isArray(value) ? `(${value.length})` : `${name}(${value.length})`;
    return `${prefix} [${parts.join(', ')}]`;
  }
  if (value instanceof Map || value instanceof Set) {
    for (const item of value) {
      if (parts.length === MAX_ITEMS) {
        parts.push('…');
        break;
      }
      parts.push(
        value instanceof Map ? `${inline(item[0], depth + 1)} => ${inline(item[1], depth + 1)}` : inline(item, depth + 1),
      );
    }
    return `${name}(${value.size}) {${parts.join(', ')}}`;
  }

  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_ITEMS)) {
    let text;
    try {
      text = inline(value[key], depth + 1);
    } catch {
      text = '(error)'; // a getter that throws
    }
    parts.push(`${key}: ${text}`);
  }
  if (keys.length > MAX_ITEMS) parts.push('…');
  const prefix = name && name !== 'Object' ? `${name} ` : '';
  return `${prefix}{${parts.join(', ')}}`;
}

/** Turns any value into a ConsoleValue that can actually be sent. */
function describe(value) {
  try {
    if (value instanceof Node) return { type: 'node', text: nodeLabel(value), nodeId: idOf(value) };
    if (value instanceof Error) return { type: 'error', text: inline(value, 0) };
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return { type, text: truncate(inline(value, 0), LIMITS.MAX_TEXT) };
  } catch {
    return { type: 'object', text: '[value cannot be displayed]' };
  }
}

// Wrap the console methods: notify the app and call the original, so the
// messages still show up in the browser DevTools as well.
const CONSOLE_METHODS = { log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug', dir: 'log', table: 'log', trace: 'log' };

for (const [method, level] of Object.entries(CONSOLE_METHODS)) {
  const original = console[method];
  if (typeof original !== 'function') continue;
  console[method] = function (...args) {
    report('console', level, args);
    return original.apply(this, args);
  };
}

const originalAssert = console.assert;
console.assert = function (condition, ...args) {
  if (!condition) report('console', 'error', ['Assertion failed:', ...args]);
  return originalAssert.call(this, condition, ...args);
};

const originalClear = console.clear;
console.clear = function () {
  report('clear', 'info', []);
  return originalClear.call(this);
};

// Uncaught errors. We listen in the CAPTURE phase (third argument true)
// because load errors from <img>, <script src>… do not bubble.
window.addEventListener(
  'error',
  (event) => {
    if (event.target instanceof Element) {
      const url = event.target.getAttribute('src') ?? event.target.getAttribute('href') ?? '';
      report('resource', 'error', [`Failed to load <${event.target.localName}> ${url}`]);
      return;
    }
    const extra = { location: { line: event.lineno, column: event.colno } };
    if (typeof event.error?.stack === 'string') extra.stack = event.error.stack;
    report('exception', 'error', [event.message || 'Unknown error'], extra);
  },
  true,
);

window.addEventListener('unhandledrejection', (event) => {
  const extra = typeof event.reason?.stack === 'string' ? { stack: event.reason.stack } : undefined;
  report('rejection', 'error', ['Uncaught (in promise)', event.reason], extra);
});

// ── 4. Highlighting and inspect mode ────────────────────────────────
// The overlay is NOT drawn here: adding elements to this document would
// change the user's DOM (and the tree). The agent only measures the node
// and sends its box model; the app draws the overlay on top of the iframe.
const nextFrame = window.requestAnimationFrame.bind(window);
const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
let tracked = null; // node whose box we are following
let lastBox = '';
let following = false;

function measure(node) {
  if (!node.isConnected) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    // A text node has no box of its own, but a Range around it does
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return rect.width || rect.height ? toBox(rect, null) : null;
  }
  // getClientRects() is empty for elements that are not rendered (display: none, <head>…)
  if (!(node instanceof Element) || node.getClientRects().length === 0) return null;
  return toBox(node.getBoundingClientRect(), getComputedStyle(node));
}

function toBox(rect, style) {
  const sides = (property, suffix = '') =>
    SIDES.map((side) => (style ? parseFloat(style[`${property}${side}${suffix}`]) || 0 : 0));
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    margin: sides('margin'),
    border: sides('border', 'Width'),
    padding: sides('padding'),
  };
}

// The first box is sent right away. After that we measure the node on every
// frame, but only send its box when it changes: scrolling, animations and
// layout changes are followed for free.
function track(node) {
  tracked = node;
  lastBox = '';
  if (!node) {
    send(FROM_AGENT.BOX, { id: null, box: null, label: '' });
    return;
  }
  sendBoxIfChanged();
  if (!following) {
    following = true;
    nextFrame(follow);
  }
}

function follow() {
  if (!tracked) {
    following = false;
    return;
  }
  sendBoxIfChanged();
  nextFrame(follow);
}

function sendBoxIfChanged() {
  const box = measure(tracked);
  const key = JSON.stringify(box);
  if (key === lastBox) return;
  lastBox = key;
  send(FROM_AGENT.BOX, { id: idOf(tracked), box, label: nodeLabel(tracked) });
}

// Inspect mode: hovering highlights, clicking picks. Everything a click is
// made of is blocked so the user's code never sees it.
const CLICK_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
let inspecting = false;
let hovered = null;
let cursorSheet = null;

function setInspecting(enabled) {
  if (enabled === inspecting) return;
  inspecting = enabled;
  // A constructed stylesheet changes the cursor without adding a single node to the document
  cursorSheet ??= new CSSStyleSheet();
  cursorSheet.replaceSync('* { cursor: crosshair !important; }');
  document.adoptedStyleSheets = enabled
    ? [...document.adoptedStyleSheets, cursorSheet]
    : document.adoptedStyleSheets.filter((sheet) => sheet !== cursorSheet);
  hovered = null;
  track(null);
}

function hover(node) {
  if (node === hovered) return;
  hovered = node;
  // HOVER goes first: the app only accepts boxes for the node it knows is hovered
  send(FROM_AGENT.HOVER, { id: node ? idOf(node) : null });
  track(node);
}

// CAPTURE phase on window, registered before the user's code runs: these
// listeners go first, before any listener the user adds.
window.addEventListener(
  'pointermove',
  (event) => {
    if (inspecting) hover(event.target instanceof Node ? event.target : null);
  },
  true,
);

window.addEventListener(
  'pointerout',
  (event) => {
    // relatedTarget null → the pointer left the document
    if (inspecting && !event.relatedTarget) hover(null);
  },
  true,
);

for (const type of CLICK_EVENTS) {
  window.addEventListener(
    type,
    (event) => {
      if (!inspecting) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type !== 'click') return;
      const node = event.target instanceof Node ? event.target : null;
      setInspecting(false);
      send(FROM_AGENT.PICK, { id: node ? idOf(node) : null });
    },
    true,
  );
}

// ── 5. Sandbox adaptations ──────────────────────────────────────────
// Without "allow-modals", alert/confirm/prompt do nothing. We replace them
// so they warn in our console instead of failing silently.
const MODAL_RESULTS = { alert: undefined, confirm: false, prompt: null };

for (const [name, result] of Object.entries(MODAL_RESULTS)) {
  window[name] = function (message) {
    const args = [`${name}() is not available in the sandboxed preview (returns ${result}).`];
    if (message !== undefined) args.push(message);
    report('sandbox', 'warn', args);
    return result;
  };
}

// If the document navigated to another URL, the agent would go with it.
// These listeners are on window (bubble phase): they run AFTER the user's
// own listeners, so we respect their event.preventDefault().
window.addEventListener('click', (event) => {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const link = event.target.closest('a[href]');
  if (!link) return;
  const href = link.getAttribute('href').trim();
  if (href.startsWith('#') || /^javascript:/i.test(href)) return;
  event.preventDefault();
  report('sandbox', 'warn', [`Navigation to "${href}" blocked: the preview cannot leave your document.`]);
});

window.addEventListener('submit', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  report('sandbox', 'info', [
    'Form submitted. The navigation was cancelled so the preview is not lost. ' +
      'To handle it with JavaScript, call event.preventDefault() in the "submit" event.',
  ]);
});

// ── 6. Node details and event listeners ─────────────────────────────
// There is no standard API to list an element's listeners
// (getEventListeners() only exists inside DevTools). So the agent wraps
// addEventListener / removeEventListener and keeps its own record. The
// wrappers are installed at the very end of startup: the agent's own
// listeners are not recorded, only the ones your code adds.
const listenerRegistry = new WeakMap(); // target → [{ type, callback, capture, once, passive }]
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;

const captureOf = (options) => (typeof options === 'boolean' ? options : Boolean(options?.capture));
const sameListener = (entry, type, callback, capture) =>
  entry.type === type && entry.callback === callback && entry.capture === capture;

function forget(target, type, callback, capture) {
  const entries = listenerRegistry.get(target);
  const index = entries ? entries.findIndex((entry) => sameListener(entry, type, callback, capture)) : -1;
  if (index >= 0) entries.splice(index, 1);
}

function recordListeners() {
  EventTarget.prototype.addEventListener = function addEventListener(type, callback, options) {
    nativeAdd.call(this, type, callback, options); // if the arguments are wrong, it throws before we record anything
    if (!callback || options?.signal?.aborted) return;
    type = String(type);
    const capture = captureOf(options);
    const entries = listenerRegistry.get(this) ?? [];
    // The browser ignores a listener added twice (same type, function and capture): so do we
    if (entries.some((entry) => sameListener(entry, type, callback, capture))) return;
    listenerRegistry.set(this, entries);
    entries.push({ type, callback, capture, once: Boolean(options?.once), passive: Boolean(options?.passive) });
    // Listeners that remove themselves: { once: true } after the first event, or an AbortSignal
    const drop = () => forget(this, type, callback, capture);
    if (options?.once) nativeAdd.call(this, type, drop, { once: true, capture });
    if (options?.signal) nativeAdd.call(options.signal, 'abort', drop, { once: true });
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, callback, options) {
    nativeRemove.call(this, type, callback, options);
    forget(this, String(type), callback, captureOf(options));
  };
}

// Event handler properties (onclick, oninput…): el.onclick = fn, or the
// onclick="…" attribute. Collected now, before the user's code adds globals.
const HANDLER_PROPERTIES = new Set();
for (const source of [HTMLElement.prototype, Document.prototype, window]) {
  for (const key in source) if (key.startsWith('on')) HANDLER_PROPERTIES.add(key);
}

function describeHandler(handler) {
  try {
    // A function's toString() returns its source code
    if (typeof handler === 'function') return truncate(String(handler), LIMITS.MAX_HANDLER);
    if (typeof handler?.handleEvent === 'function') {
      return truncate(`{ handleEvent: ${handler.handleEvent} }`, LIMITS.MAX_HANDLER);
    }
  } catch {
    // A Proxy or an object whose toString() throws
  }
  return '';
}

/**
 * Listeners on the node and on every ancestor up to window. Most events
 * bubble, so the ancestors' listeners also receive events that start on
 * this node: that is how event delegation works.
 */
function listenersOf(node) {
  const targets = [];
  for (let target = node; target; target = target.parentNode) targets.push(target);
  targets.push(window);

  const result = [];
  for (const target of targets) {
    const where = {
      own: target === node,
      target: target === window ? 'window' : nodeLabel(target),
      targetId: target === window ? null : idOf(target),
    };
    for (const entry of listenerRegistry.get(target) ?? []) {
      const { type, capture, once, passive, callback } = entry;
      result.push({ ...where, type, kind: 'listener', capture, once, passive, handler: describeHandler(callback) });
    }
    for (const property of HANDLER_PROPERTIES) {
      let handler;
      try {
        handler = target[property];
      } catch {
        continue;
      }
      if (typeof handler !== 'function') continue;
      const inline = target instanceof Element && target.hasAttribute(property);
      result.push({
        ...where,
        type: property.slice(2),
        kind: inline ? 'attribute' : 'property',
        capture: false,
        once: false,
        passive: false,
        handler: inline ? truncate(target.getAttribute(property), LIMITS.MAX_HANDLER) : describeHandler(handler),
      });
    }
    if (result.length >= LIMITS.MAX_LISTENERS) break;
  }
  return result.slice(0, LIMITS.MAX_LISTENERS);
}

// Shorthands are not listed in the computed style (only their longhands),
// but "margin: 16px 0px" reads much better than four separate values.
const SHORTHANDS = [
  'margin', 'padding', 'border', 'border-radius', 'inset', 'gap', 'flex', 'overflow',
  'font', 'background', 'transition', 'animation',
];

function computedStyles(element) {
  const style = getComputedStyle(element);
  const styles = [];
  for (let i = 0; i < style.length && styles.length < LIMITS.MAX_STYLES; i++) {
    styles.push([style[i], style.getPropertyValue(style[i])]);
  }
  for (const name of SHORTHANDS) {
    const value = style.getPropertyValue(name);
    if (value) styles.push([name, value]);
  }
  return styles;
}

const METRICS = [
  'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
  'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft',
];

function metricsOf(element) {
  const metrics = {};
  // offset* only exist on HTML elements; client* and scroll* on every Element
  for (const key of METRICS) if (typeof element[key] === 'number') metrics[key] = element[key];
  if (element.offsetParent) metrics.offsetParent = nodeLabel(element.offsetParent);
  return metrics;
}

function detailsOf(node) {
  if (!node) return null;
  const isElement = node instanceof Element;
  const details = {
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    childNodes: node.childNodes.length,
    children: node.children?.length ?? 0,
    attributes: isElement
      ? Array.from(node.attributes, (attr) => [attr.name, truncate(attr.value, LIMITS.MAX_ATTR_VALUE)])
      : [],
    box: measure(node),
    metrics: isElement ? metricsOf(node) : null,
    styles: isElement && node.isConnected ? computedStyles(node) : [],
    listeners: listenersOf(node),
  };
  if (typeof node.data === 'string') {
    details.text = truncate(node.data, LIMITS.MAX_TEXT);
    details.length = node.data.length;
  }
  return details;
}

// ── 7. Commands from the app ────────────────────────────────────────
window.addEventListener('message', (event) => {
  // We only obey the parent window. The user's code could pretend to be
  // the app with window.postMessage(), but then event.source would be this
  // very window, not the app.
  if (event.source !== appWindow) return;
  const message = event.data;
  if (
    !message ||
    message.channel !== CHANNEL ||
    message.version !== VERSION ||
    message.runId !== runId
  ) return;

  const { payload } = message;
  switch (message.type) {
    case TO_AGENT.REQUEST_SNAPSHOT:
      sendSnapshot();
      break;
    case TO_AGENT.HIGHLIGHT:
      // While inspecting, the pointer decides what is highlighted
      if (!inspecting) track(Number.isInteger(payload?.id) ? nodeOf(payload.id) : null);
      break;
    case TO_AGENT.SET_INSPECT:
      setInspecting(payload?.enabled === true);
      break;
    case TO_AGENT.REQUEST_DETAILS: {
      if (!Number.isInteger(payload?.id)) break;
      let details = null;
      try {
        details = detailsOf(nodeOf(payload.id));
      } catch {
        // The user's code may have broken a DOM API the agent relies on
      }
      send(FROM_AGENT.DETAILS, { id: payload.id, details });
      break;
    }
  }
});

// ── 8. Startup ──────────────────────────────────────────────────────
// Remove our own <script> so the tree only shows your document.
document.currentScript?.remove();
send(FROM_AGENT.READY, {});

// The user's JS is at the end of <body>: by DOMContentLoaded it has already
// run. We wait one more "tick" (setTimeout 0) to also include whatever its
// own DOMContentLoaded listeners do. From then on, the MutationObserver
// reports every change (including what "load" listeners or timers do).
document.addEventListener('DOMContentLoaded', () => schedule(sendSnapshot, 0), { once: true });

// Last of all: from here on, every listener added belongs to your code.
recordListeners();
