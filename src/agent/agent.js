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

function idOf(node) {
  let id = ids.get(node);
  if (id === undefined) {
    id = nextId++;
    ids.set(node, id);
  }
  return id;
}

// ── 2. Serializing the DOM ──────────────────────────────────────────
// postMessage copies data with the "structured clone algorithm", which does
// not support DOM nodes. So we walk the tree and turn it into plain objects
// (see SerializedNode in protocol/messages.js).

function serialize(node, depth, budget) {
  budget.left--;
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

  // childNodes includes ALL children (elements, text, comments);
  // children would only include the elements.
  const kids = [];
  if (node.shadowRoot) kids.push(node.shadowRoot);
  // A <template>'s content is not in childNodes but in a separate
  // DocumentFragment: template.content
  if (node instanceof HTMLTemplateElement) kids.push(node.content);
  kids.push(...node.childNodes);

  out.children = [];
  if (depth >= LIMITS.MAX_DEPTH) {
    budget.truncated = true;
    return out;
  }
  for (const child of kids) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    out.children.push(serialize(child, depth + 1, budget));
  }
  return out;
}

function sendSnapshot() {
  const budget = { left: LIMITS.MAX_NODES, truncated: false };
  const root = serialize(document, 0, budget);
  send(FROM_AGENT.SNAPSHOT, { root, truncated: budget.truncated });
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

// ── 4. Sandbox adaptations ──────────────────────────────────────────
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

// ── 5. Commands from the app ────────────────────────────────────────
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

  switch (message.type) {
    case TO_AGENT.REQUEST_SNAPSHOT:
      sendSnapshot();
      break;
  }
});

// ── 6. Startup ──────────────────────────────────────────────────────
// Remove our own <script> so the tree only shows your document.
document.currentScript?.remove();
send(FROM_AGENT.READY, {});

// The user's JS is at the end of <body>: by DOMContentLoaded it has already
// run. We wait one more "tick" (setTimeout 0) to also include whatever its
// own DOMContentLoaded and load listeners do.
document.addEventListener('DOMContentLoaded', () => schedule(sendSnapshot, 0), { once: true });
window.addEventListener('load', () => schedule(sendSnapshot, 0), { once: true });
