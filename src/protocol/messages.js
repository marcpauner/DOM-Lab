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
});

/** app → iframe */
export const TO_AGENT = Object.freeze({
  /** Asks for a fresh full tree. payload: {} */
  REQUEST_SNAPSHOT: 'dom:request-snapshot',
  /** Starts following a node's box (null stops). payload: { id: number|null } */
  HIGHLIGHT: 'overlay:highlight',
  /** Turns inspect mode on or off. payload: { enabled: boolean } */
  SET_INSPECT: 'inspect:set',
});

/** Shared limits: they protect the app from huge or malicious documents. */
export const LIMITS = Object.freeze({
  MAX_NODES: 50_000,
  MAX_DEPTH: 256,
  MAX_TEXT: 10_000,
  MAX_ATTR_VALUE: 2_000,
  MAX_CONSOLE_BATCH: 300,
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
    default:
      return null;
  }
}

const isIdOrNull = (value) => value === null || (Number.isInteger(value) && value > 0);
const isCoordinate = (value) => Number.isFinite(value) && Math.abs(value) < 1e6;
const isSides = (value) => Array.isArray(value) && value.length === 4 && value.every(isCoordinate);

function readBox(payload) {
  const { id, box, label } = payload;
  if (!isIdOrNull(id)) return null;
  if (box === null) return { id, box: null, label: '' };
  const valid =
    isObject(box) &&
    ['x', 'y', 'width', 'height'].every((key) => isCoordinate(box[key])) &&
    isSides(box.margin) &&
    isSides(box.border) &&
    isSides(box.padding);
  if (!valid) return null;
  // Copy only the expected fields: anything else the iframe sent is dropped
  return {
    id,
    box: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      margin: [...box.margin],
      border: [...box.border],
      padding: [...box.padding],
    },
    label: typeof label === 'string' ? label.slice(0, 200) : '',
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
