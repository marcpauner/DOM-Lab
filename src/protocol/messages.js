/**
 * MESSAGE PROTOCOL  app ⇄ agent (iframe)
 * ──────────────────────────────────────
 * The app and the preview live in different origins (the iframe gets an
 * opaque origin, "null"), so postMessage is the only way they can talk.
 * Every message travels inside the same envelope:
 *
 *   {
 *     channel: 'dom-lab',      // filters out foreign messages (extensions, other sites…)
 *     version: 1,              // lets the protocol evolve
 *     runId:   'lx3k9-a8f2',   // identifies each run: messages from an older one are ignored
 *     type:    'dom:snapshot', // "domain:action"
 *     payload: { … }           // plain data only (no functions, no DOM nodes)
 *   }
 *
 * This module is the single source of truth: the agent receives these same
 * constants injected as JSON (see preview/srcdoc.js).
 * Full documentation: docs/protocol.md
 */

export const CHANNEL = 'dom-lab';
export const VERSION = 1;

/** iframe → app */
export const FROM_AGENT = Object.freeze({
  /** The agent has loaded. payload: {} */
  READY: 'agent:ready',
  /** Full DOM tree. payload: { root: SerializedNode, truncated: boolean } */
  SNAPSHOT: 'dom:snapshot',
  /** Batch of console messages and errors. payload: { entries: ConsoleEntry[], dropped: number } */
  CONSOLE: 'console:entries',
  /** Box model of the highlighted node, sent whenever it changes. payload: { id: number|null, box: Box|null, label: string } */
  BOX: 'overlay:box',
  /** Inspect mode: the pointer moved onto another node. payload: { id: number|null } */
  HOVER: 'inspect:hover',
  /** Inspect mode: the user clicked a node (inspect mode ends). payload: { id: number|null } */
  PICK: 'inspect:pick',
  /** Everything the details panel shows about a node. payload: { id: number, details: NodeDetails|null } */
  DETAILS: 'node:details',
  /**
   * Live changes seen by the MutationObserver since the last batch.
   * payload: { patches: Patch[], records: ChangeRecord[], dropped: number, overflow: number }
   * overflow > 0: too many changes at once; a full dom:snapshot follows.
   */
  MUTATIONS: 'dom:mutations',
});

/** app → iframe */
export const TO_AGENT = Object.freeze({
  /** Asks for a fresh full tree. payload: {} */
  REQUEST_SNAPSHOT: 'dom:request-snapshot',
  /** Starts following a node's box (null stops). payload: { id: number|null } */
  HIGHLIGHT: 'overlay:highlight',
  /** Turns inspect mode on or off. payload: { enabled: boolean } */
  SET_INSPECT: 'inspect:set',
  /** Asks for a node's details (answered with node:details). payload: { id: number } */
  REQUEST_DETAILS: 'node:request-details',
});

/** Shared limits: they protect the app from huge or malicious documents. */
export const LIMITS = Object.freeze({
  MAX_NODES: 50_000,
  MAX_DEPTH: 256,
  MAX_TEXT: 10_000,
  MAX_ATTR_VALUE: 2_000,
  MAX_CONSOLE_BATCH: 300,
  MAX_STYLES: 1_000,
  MAX_LISTENERS: 200,
  MAX_HANDLER: 600,
  MAX_MUTATIONS: 5_000, // MutationRecords in one batch; more than that → a full snapshot instead
  MAX_HISTORY: 300, // ChangeRecords sent per batch
});

/**
 * A DOM node turned into a plain object.
 * @typedef {Object} SerializedNode
 * @property {number} id            Stable identifier while the node exists
 * @property {number} nodeType      1 element, 3 text, 8 comment, 9 document, 10 doctype, 11 fragment
 * @property {string} nodeName      'DIV', '#text', '#comment', '#document'…
 * @property {Array<[string, string]>} [attributes]  Elements only, in order
 * @property {string} [value]       Content of text and comment nodes
 * @property {boolean} [truncated]  The text was cut to LIMITS.MAX_TEXT
 * @property {'open'|'closed'} [mode] Shadow roots only
 * @property {SerializedNode[]} [children]
 */

/**
 * @typedef {'string'|'number'|'bigint'|'boolean'|'undefined'|'null'|'symbol'|'function'|'object'|'array'|'node'|'error'} ValueType
 * @typedef {Object} ConsoleValue  Preview of a value passed to console.log
 * @property {ValueType} type
 * @property {string} text
 * @property {number} [nodeId]      If it is a DOM node, its id in the tree
 *
 * @typedef {'log'|'info'|'warn'|'error'|'debug'} ConsoleLevel
 * @typedef {'console'|'exception'|'rejection'|'resource'|'sandbox'|'clear'} EntryKind
 * @typedef {Object} ConsoleEntry
 * @property {EntryKind} kind
 * @property {ConsoleLevel} level
 * @property {ConsoleValue[]} args
 * @property {number} time          Date.now() when it happened
 * @property {{ line: number, column: number }} [location]  Line in the iframe document
 * @property {string} [stack]
 */

/**
 * Box model of a node, in CSS pixels relative to the preview's viewport.
 * x, y, width and height describe the BORDER box (what getBoundingClientRect
 * returns); every side list is [top, right, bottom, left].
 * @typedef {[number, number, number, number]} Sides
 * @typedef {Object} Box
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {Sides} margin
 * @property {Sides} border
 * @property {Sides} padding
 */

/**
 * An event listener on the node or on one of its ancestors.
 * @typedef {Object} Listener
 * @property {boolean} own          true: on the node itself; false: on an ancestor (or window)
 * @property {string} target        Label of the node that has it: 'ul#list', '#document', 'window'
 * @property {number|null} targetId Its id in the tree (null for window)
 * @property {string} type          'click', 'input'…
 * @property {'listener'|'property'|'attribute'} kind  addEventListener, el.onclick = …, or onclick="…"
 * @property {boolean} capture
 * @property {boolean} once
 * @property {boolean} passive
 * @property {string} handler       Source code of the function (or of the attribute)
 *
 * Measurement properties of an element (CSSOM View), in CSS pixels.
 * The offset* ones only exist on HTML elements (not on SVG).
 * @typedef {Object} Metrics
 * @property {number} [offsetWidth]
 * @property {number} [offsetHeight]
 * @property {number} [offsetTop]
 * @property {number} [offsetLeft]
 * @property {string} [offsetParent]  Label of the offsetParent
 * @property {number} clientWidth
 * @property {number} clientHeight
 * @property {number} scrollWidth
 * @property {number} scrollHeight
 * @property {number} scrollTop
 * @property {number} scrollLeft
 *
 * @typedef {Object} NodeDetails
 * @property {number} nodeType
 * @property {string} nodeName
 * @property {number} childNodes     childNodes.length
 * @property {number} children       children.length (elements only count)
 * @property {Array<[string, string]>} attributes
 * @property {string} [text]         data of text and comment nodes
 * @property {number} [length]       Its real length (text may be truncated)
 * @property {Box|null} box
 * @property {Metrics|null} metrics
 * @property {Array<[string, string]>} styles  Computed styles: [property, value]
 * @property {Listener[]} listeners
 */

/**
 * A live change, described as the CURRENT state of what changed (not as a
 * replay of each MutationRecord): applying it twice gives the same result.
 * @typedef {{ op: 'children', id: number, children: Array<number|SerializedNode> }} ChildrenPatch
 *   The node's children now, in order: the id of a node the app already has,
 *   or a full SerializedNode for a new one. Children that are no longer listed were removed.
 * @typedef {{ op: 'attributes', id: number, attributes: Array<[string, string]> }} AttributesPatch
 * @typedef {{ op: 'text', id: number, value: string, truncated: boolean }} TextPatch
 * @typedef {ChildrenPatch|AttributesPatch|TextPatch} Patch
 *
 * @typedef {Object} NodeRef
 * @property {number} id
 * @property {string} label
 * @property {boolean} whitespace   A text node with only whitespace
 *
 * One MutationRecord, for the history of changes.
 * @typedef {Object} ChangeRecord
 * @property {'childList'|'attributes'|'characterData'} type
 * @property {number} time          Date.now() when the observer saw it
 * @property {number|null} targetId
 * @property {string} target        Label of the node that changed
 * @property {NodeRef[]} [added]    childList only
 * @property {NodeRef[]} [removed]  childList only
 * @property {string} [name]        attributes only: the attribute name
 * @property {string|null} [oldValue]  attributes and characterData (null: the attribute did not exist)
 * @property {string|null} [value]     The value right after this change (null: removed)
 */

/** Builds a message in the protocol format. */
export function createMessage(runId, type, payload = {}) {
  return { channel: CHANNEL, version: VERSION, runId, type, payload };
}

const isObject = (value) => value !== null && typeof value === 'object';

/** Does `data` look like one of our messages for run `runId`? */
export function isMessage(data, runId) {
  return (
    isObject(data) &&
    data.channel === CHANNEL &&
    data.version === VERSION &&
    data.runId === runId &&
    typeof data.type === 'string' &&
    isObject(data.payload)
  );
}

/**
 * Turns a received payload into data with the expected shape, or returns
 * null if it is invalid. Important: the user's code runs inside the iframe
 * and can call parent.postMessage() with ANYTHING. That is why the app never
 * trusts this data: it validates it and renders it as text.
 */
export function readPayload(type, payload) {
  switch (type) {
    case FROM_AGENT.READY:
      return {};
    case FROM_AGENT.SNAPSHOT:
      // The tree is validated node by node while building the model (tree/model.js).
      return isObject(payload.root) ? { root: payload.root, truncated: payload.truncated === true } : null;
    case FROM_AGENT.CONSOLE:
      return readConsole(payload);
    case FROM_AGENT.BOX:
      return readBox(payload);
    case FROM_AGENT.HOVER:
    case FROM_AGENT.PICK:
      return isIdOrNull(payload.id) ? { id: payload.id } : null;
    case FROM_AGENT.DETAILS:
      return readDetails(payload);
    case FROM_AGENT.MUTATIONS:
      return readMutations(payload);
    default:
      return null;
  }
}

const isIdOrNull = (value) => value === null || (Number.isInteger(value) && value > 0);
const isCoordinate = (value) => Number.isFinite(value) && Math.abs(value) < 1e6;
const isSides = (value) => Array.isArray(value) && value.length === 4 && value.every(isCoordinate);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/** A valid Box copied field by field (anything else the iframe sent is dropped), or undefined. */
function copyBox(box) {
  const valid =
    isObject(box) &&
    ['x', 'y', 'width', 'height'].every((key) => isCoordinate(box[key])) &&
    isSides(box.margin) &&
    isSides(box.border) &&
    isSides(box.padding);
  if (!valid) return undefined;
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    margin: [...box.margin],
    border: [...box.border],
    padding: [...box.padding],
  };
}

function readBox(payload) {
  const { id, box, label } = payload;
  if (!isIdOrNull(id)) return null;
  if (box === null) return { id, box: null, label: '' };
  const copy = copyBox(box);
  return copy ? { id, box: copy, label: text(label, 200) } : null;
}

/** [string, string] pairs, at most `max` of them. */
function readPairs(value, max, valueMax) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string')
    .map(([name, val]) => [name.slice(0, 200), val.slice(0, valueMax)]);
}

const METRIC_KEYS = [
  'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
  'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft',
];
const LISTENER_KINDS = new Set(['listener', 'property', 'attribute']);

function readMetrics(raw) {
  if (!isObject(raw)) return null;
  const metrics = {};
  for (const key of METRIC_KEYS) if (isCoordinate(raw[key])) metrics[key] = raw[key];
  if (typeof raw.offsetParent === 'string') metrics.offsetParent = raw.offsetParent.slice(0, 200);
  return metrics;
}

function readListener(raw) {
  if (!isObject(raw) || !LISTENER_KINDS.has(raw.kind) || typeof raw.type !== 'string') return null;
  return {
    own: raw.own === true,
    target: text(raw.target, 200),
    targetId: Number.isInteger(raw.targetId) && raw.targetId > 0 ? raw.targetId : null,
    type: raw.type.slice(0, 60),
    kind: raw.kind,
    capture: raw.capture === true,
    once: raw.once === true,
    passive: raw.passive === true,
    handler: text(raw.handler, LIMITS.MAX_HANDLER),
  };
}

function readDetails(payload) {
  const { id, details: raw } = payload;
  if (!Number.isInteger(id) || id <= 0) return null;
  if (raw === null) return { id, details: null };
  if (!isObject(raw) || !Number.isInteger(raw.nodeType)) return null;
  /** @type {NodeDetails} */
  const details = {
    nodeType: raw.nodeType,
    nodeName: text(raw.nodeName, 200),
    childNodes: count(raw.childNodes),
    children: count(raw.children),
    attributes: readPairs(raw.attributes, 500, LIMITS.MAX_ATTR_VALUE),
    box: copyBox(raw.box) ?? null,
    metrics: readMetrics(raw.metrics),
    styles: readPairs(raw.styles, LIMITS.MAX_STYLES, 1_000),
    listeners: Array.isArray(raw.listeners)
      ? raw.listeners.slice(0, LIMITS.MAX_LISTENERS).map(readListener).filter(Boolean)
      : [],
  };
  if (typeof raw.text === 'string') {
    details.text = raw.text.slice(0, LIMITS.MAX_TEXT);
    details.length = count(raw.length);
  }
  return { id, details };
}

const isId = (value) => Number.isInteger(value) && value > 0;
const RECORD_TYPES = new Set(['childList', 'attributes', 'characterData']);
const stringOrNull = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function readPatch(raw) {
  if (!isObject(raw) || !isId(raw.id)) return null;
  switch (raw.op) {
    case 'children':
      // New nodes (objects) are validated node by node when they join the model (tree/model.js)
      return Array.isArray(raw.children)
        ? { op: 'children', id: raw.id, children: raw.children.slice(0, LIMITS.MAX_NODES).filter((child) => isId(child) || isObject(child)) }
        : null;
    case 'attributes':
      return { op: 'attributes', id: raw.id, attributes: readPairs(raw.attributes, 500, LIMITS.MAX_ATTR_VALUE) };
    case 'text':
      return typeof raw.value === 'string'
        ? { op: 'text', id: raw.id, value: raw.value.slice(0, LIMITS.MAX_TEXT), truncated: raw.truncated === true }
        : null;
    default:
      return null;
  }
}

function readNodeRef(raw) {
  return isObject(raw) && isId(raw.id) ? { id: raw.id, label: text(raw.label, 200), whitespace: raw.whitespace === true } : null;
}

function readRecord(raw) {
  if (!isObject(raw) || !RECORD_TYPES.has(raw.type)) return null;
  /** @type {ChangeRecord} */
  const record = {
    type: raw.type,
    time: Number.isFinite(raw.time) ? raw.time : Date.now(),
    targetId: isId(raw.targetId) ? raw.targetId : null,
    target: text(raw.target, 200),
  };
  if (raw.type === 'childList') {
    const refs = (list) => (Array.isArray(list) ? list.slice(0, 20).map(readNodeRef).filter(Boolean) : []);
    record.added = refs(raw.added);
    record.removed = refs(raw.removed);
  } else {
    if (raw.type === 'attributes') record.name = text(raw.name, 200);
    record.oldValue = stringOrNull(raw.oldValue, 300);
    record.value = stringOrNull(raw.value, 300);
  }
  return record;
}

function readMutations(payload) {
  if (!Array.isArray(payload.patches) || !Array.isArray(payload.records)) return null;
  return {
    patches: payload.patches.slice(0, LIMITS.MAX_MUTATIONS).map(readPatch).filter(Boolean),
    records: payload.records.slice(0, LIMITS.MAX_HISTORY).map(readRecord).filter(Boolean),
    dropped: count(payload.dropped),
    overflow: count(payload.overflow),
  };
}

const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const KINDS = new Set(['console', 'exception', 'rejection', 'resource', 'sandbox', 'clear']);
const VALUE_TYPES = new Set([
  'string', 'number', 'bigint', 'boolean', 'undefined', 'null',
  'symbol', 'function', 'object', 'array', 'node', 'error',
]);

function readConsole(payload) {
  if (!Array.isArray(payload.entries)) return null;
  const entries = payload.entries.slice(0, LIMITS.MAX_CONSOLE_BATCH).map(readEntry).filter(Boolean);
  const dropped = Number.isInteger(payload.dropped) && payload.dropped > 0 ? payload.dropped : 0;
  return { entries, dropped };
}

function readEntry(raw) {
  if (!isObject(raw) || !KINDS.has(raw.kind)) return null;
  /** @type {ConsoleEntry} */
  const entry = {
    kind: raw.kind,
    level: LEVELS.has(raw.level) ? raw.level : 'log',
    args: Array.isArray(raw.args) ? raw.args.slice(0, 50).map(readValue).filter(Boolean) : [],
    time: Number.isFinite(raw.time) ? raw.time : Date.now(),
  };
  if (isObject(raw.location) && Number.isInteger(raw.location.line) && Number.isInteger(raw.location.column)) {
    entry.location = { line: raw.location.line, column: raw.location.column };
  }
  if (typeof raw.stack === 'string') entry.stack = raw.stack.slice(0, 4_000);
  return entry;
}

function readValue(raw) {
  if (!isObject(raw) || !VALUE_TYPES.has(raw.type) || typeof raw.text !== 'string') return null;
  /** @type {ConsoleValue} */
  const value = { type: raw.type, text: raw.text.slice(0, LIMITS.MAX_TEXT) };
  if (raw.type === 'node' && Number.isInteger(raw.nodeId)) value.nodeId = raw.nodeId;
  return value;
}
