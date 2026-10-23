import { LIMITS } from '../protocol/messages.js';

/**
 * A validated tree node, ready to be rendered.
 * @typedef {Object} TreeNode
 * @property {number} id
 * @property {number} nodeType
 * @property {string} nodeName
 * @property {Array<[string, string]>} attributes
 * @property {string} value
 * @property {boolean} truncated
 * @property {'open'|'closed'|undefined} mode
 * @property {TreeNode[]} children
 * @property {TreeNode|null} parent
 * @property {number} depth
 * @property {string} path      Path that is stable across runs: /HTML[0]/BODY[0]/UL[0]
 * @property {boolean} isWhitespace
 *
 * @typedef {Object} TreeModel
 * @property {TreeNode} root
 * @property {Map<number, TreeNode>} byId
 * @property {Map<string, TreeNode>} byPath
 * @property {{ total: number, elements: number, texts: number, whitespace: number, comments: number }} stats
 */

const NODE_TYPES = new Set([
  Node.ELEMENT_NODE,
  Node.TEXT_NODE,
  Node.CDATA_SECTION_NODE,
  Node.PROCESSING_INSTRUCTION_NODE,
  Node.COMMENT_NODE,
  Node.DOCUMENT_NODE,
  Node.DOCUMENT_TYPE_NODE,
  Node.DOCUMENT_FRAGMENT_NODE,
]);

// "HTML" whitespace: space, tab, line feed, form feed and carriage return.
// CAREFUL: \s in regexes also matches &nbsp; (U+00A0), which IS visible on
// screen, so it is not what we want here.
const WHITESPACE_ONLY = /^[ \t\n\f\r]*$/;

const isObject = (value) => value !== null && typeof value === 'object';
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Turns a received node into a TreeNode, or null if it is invalid. */
function sanitize(raw, parent) {
  if (!isObject(raw) || !Number.isInteger(raw.id) || !NODE_TYPES.has(raw.nodeType)) return null;
  const node = {
    id: raw.id,
    nodeType: raw.nodeType,
    nodeName: text(raw.nodeName, 200),
    attributes: [],
    value: text(raw.value, LIMITS.MAX_TEXT),
    truncated: raw.truncated === true,
    mode: raw.mode === 'open' || raw.mode === 'closed' ? raw.mode : undefined,
    children: [],
    parent,
    depth: parent ? parent.depth + 1 : 0,
    path: '',
    isWhitespace: false,
  };
  if (node.nodeType === Node.ELEMENT_NODE && Array.isArray(raw.attributes)) {
    for (const pair of raw.attributes.slice(0, 500)) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
        node.attributes.push([pair[0].slice(0, 200), pair[1].slice(0, LIMITS.MAX_ATTR_VALUE)]);
      }
    }
  }
  node.isWhitespace = node.nodeType === Node.TEXT_NODE && WHITESPACE_ONLY.test(node.value);
  return node;
}

/**
 * Builds the tree model from the agent's snapshot.
 * It walks the tree with an explicit stack (no recursion): that way a
 * malicious, extremely deep document cannot overflow the app's call stack.
 * @returns {TreeModel|null}
 */
export function buildModel(rawRoot) {
  const byId = new Map();
  const byPath = new Map();
  const stats = { total: 0, elements: 0, texts: 0, whitespace: 0, comments: 0 };
  const siblingCounts = new Map(); // parent → { name: how many so far }
  let root = null;

  const stack = [[rawRoot, null]];
  while (stack.length > 0 && byId.size < LIMITS.MAX_NODES) {
    const [raw, parent] = stack.pop();
    const node = sanitize(raw, parent);
    if (!node || byId.has(node.id)) continue;

    // XPath-like path: /HTML[0]/BODY[0]/DIV[2] (the index only counts
    // siblings with the same name). It lets us remember which nodes you had
    // expanded even after re-running, when every id changes.
    const counts = siblingCounts.get(parent) ?? {};
    siblingCounts.set(parent, counts);
    const index = counts[node.nodeName] ?? 0;
    counts[node.nodeName] = index + 1;
    node.path = parent ? `${parent.path}/${node.nodeName}[${index}]` : '';

    byId.set(node.id, node);
    byPath.set(node.path, node);
    if (parent) parent.children.push(node);
    else root = node;

    stats.total++;
    if (node.nodeType === Node.ELEMENT_NODE) stats.elements++;
    else if (node.nodeType === Node.TEXT_NODE) {
      stats.texts++;
      if (node.isWhitespace) stats.whitespace++;
    } else if (node.nodeType === Node.COMMENT_NODE) stats.comments++;

    // Push the children in reverse so they are processed in their original order.
    if (Array.isArray(raw.children) && node.nodeType !== Node.TEXT_NODE) {
      for (let i = raw.children.length - 1; i >= 0; i--) stack.push([raw.children[i], node]);
    }
  }

  return root ? { root, byId, byPath, stats } : null;
}
