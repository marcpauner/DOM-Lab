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
 *
 * What a batch of live changes did to the model.
 * @typedef {Object} ChangeSummary
 * @property {Set<number>} added       Roots of the new subtrees
 * @property {Set<number>} removed     Every node that left the tree
 * @property {Map<number, { attributes: Set<string>, text: boolean, children: boolean }>} changed
 * @property {boolean} structural      Nodes were added, removed or moved
 * @property {boolean} resync          Something did not add up: ask for a full snapshot
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
const isWhitespace = (node) => node.nodeType === Node.TEXT_NODE && WHITESPACE_ONLY.test(node.value);

function sanitizeAttributes(raw) {
  const attributes = [];
  if (!Array.isArray(raw)) return attributes;
  for (const pair of raw.slice(0, 500)) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      attributes.push([pair[0].slice(0, 200), pair[1].slice(0, LIMITS.MAX_ATTR_VALUE)]);
    }
  }
  return attributes;
}

/** Turns a received node into a TreeNode, or null if it is invalid. */
function sanitize(raw, parent) {
  if (!isObject(raw) || !Number.isInteger(raw.id) || !NODE_TYPES.has(raw.nodeType)) return null;
  const node = {
    id: raw.id,
    nodeType: raw.nodeType,
    nodeName: text(raw.nodeName, 200),
    attributes: raw.nodeType === Node.ELEMENT_NODE ? sanitizeAttributes(raw.attributes) : [],
    value: text(raw.value, LIMITS.MAX_TEXT),
    truncated: raw.truncated === true,
    mode: raw.mode === 'open' || raw.mode === 'closed' ? raw.mode : undefined,
    children: [],
    parent,
    depth: parent ? parent.depth + 1 : 0,
    path: '',
    isWhitespace: false,
  };
  node.isWhitespace = isWhitespace(node);
  return node;
}

/** Adds (sign 1) or subtracts (sign -1) a node from the statistics. */
function count(stats, node, sign) {
  stats.total += sign;
  if (node.nodeType === Node.ELEMENT_NODE) stats.elements += sign;
  else if (node.nodeType === Node.TEXT_NODE) {
    stats.texts += sign;
    if (node.isWhitespace) stats.whitespace += sign;
  } else if (node.nodeType === Node.COMMENT_NODE) stats.comments += sign;
}

/**
 * XPath-like path: /HTML[0]/BODY[0]/DIV[2] (the index only counts siblings
 * with the same name). It lets us remember which nodes you had expanded even
 * after re-running, when every id changes.
 */
function pathOf(node) {
  const { parent } = node;
  if (!parent) return '';
  let index = 0;
  for (const sibling of parent.children) {
    if (sibling === node) break;
    if (sibling.nodeName === node.nodeName) index++;
  }
  return `${parent.path}/${node.nodeName}[${index}]`;
}

/** Recomputes depth and path for a node's children and every node below them. */
function repath(model, node) {
  const stack = [...node.children];
  while (stack.length > 0) {
    const current = stack.pop();
    if (model.byPath.get(current.path) === current) model.byPath.delete(current.path);
    current.depth = current.parent.depth + 1;
    current.path = pathOf(current);
    model.byPath.set(current.path, current);
    stack.push(...current.children);
  }
}

/**
 * Turns a received subtree into TreeNodes and registers them in the model.
 * It walks the tree with an explicit stack (no recursion): that way a
 * malicious, extremely deep document cannot overflow the app's call stack.
 */
function adopt(model, rawRoot, parent) {
  let root = null;
  const stack = [[rawRoot, parent]];
  while (stack.length > 0 && model.byId.size < LIMITS.MAX_NODES) {
    const [raw, owner] = stack.pop();
    const node = sanitize(raw, owner);
    if (!node || model.byId.has(node.id)) continue;

    model.byId.set(node.id, node);
    count(model.stats, node, 1);
    if (owner && owner !== parent) owner.children.push(node);
    else root = node;

    // Push the children in reverse so they are processed in their original order.
    if (Array.isArray(raw.children) && node.nodeType !== Node.TEXT_NODE) {
      for (let i = raw.children.length - 1; i >= 0; i--) stack.push([raw.children[i], node]);
    }
  }
  return root;
}

/** Builds the tree model from the agent's snapshot. @returns {TreeModel|null} */
export function buildModel(rawRoot) {
  const model = {
    root: null,
    byId: new Map(),
    byPath: new Map(),
    stats: { total: 0, elements: 0, texts: 0, whitespace: 0, comments: 0 },
  };
  model.root = adopt(model, rawRoot, null);
  if (!model.root) return null;
  model.byPath.set('', model.root);
  repath(model, model.root);
  return model;
}

/** Takes a node and everything below it out of the model. */
function removeSubtree(model, node, removed) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    model.byId.delete(current.id);
    if (model.byPath.get(current.path) === current) model.byPath.delete(current.path);
    count(model.stats, current, -1);
    removed.add(current.id);
    stack.push(...current.children);
  }
}

/**
 * Applies a batch of live changes (see Patch in protocol/messages.js).
 * The model is changed in place, so the tree view keeps working with it.
 * @returns {ChangeSummary}
 */
export function applyPatches(model, patches) {
  /** @type {ChangeSummary} */
  const summary = { added: new Set(), removed: new Set(), changed: new Map(), structural: false, resync: false };
  const changeOf = (id) => {
    if (!summary.changed.has(id)) summary.changed.set(id, { attributes: new Set(), text: false, children: false });
    return summary.changed.get(id);
  };

  // 1. New child lists. A node dropped by its parent is not deleted yet:
  //    it may have moved to another parent in this same batch.
  const dropped = new Set();
  for (const patch of patches) {
    if (patch.op !== 'children') continue;
    const parent = model.byId.get(patch.id);
    if (!parent) continue;
    const next = [];
    for (const child of patch.children) {
      if (typeof child === 'number') {
        const node = model.byId.get(child);
        if (!node) {
          summary.resync = true; // the agent thinks we have a node we do not have
          continue;
        }
        if (node.parent !== parent) {
          // Moved here from another parent
          const siblings = node.parent?.children;
          if (siblings?.includes(node)) siblings.splice(siblings.indexOf(node), 1);
          node.parent = parent;
        }
        dropped.delete(node);
        next.push(node);
      } else {
        // A new node: if the id already exists (it left and came back), replace the old copy
        const existing = model.byId.get(child.id);
        if (existing) {
          const siblings = existing.parent?.children;
          if (siblings?.includes(existing)) siblings.splice(siblings.indexOf(existing), 1);
          removeSubtree(model, existing, new Set());
        }
        const node = adopt(model, child, parent);
        if (!node) continue;
        node.parent = parent;
        summary.added.add(node.id);
        next.push(node);
      }
    }
    const kept = new Set(next);
    for (const old of parent.children) if (!kept.has(old)) dropped.add(old);
    parent.children = next;
    repath(model, parent);
    changeOf(parent.id).children = true;
    summary.structural = true;
  }

  // 2. Whatever was dropped and not picked up by another parent is gone
  for (const node of dropped) {
    if (!node.parent?.children.includes(node) && model.byId.get(node.id) === node) {
      removeSubtree(model, node, summary.removed);
    }
  }

  // 3. Attributes and text
  for (const patch of patches) {
    const node = model.byId.get(patch.id);
    if (!node) continue;
    if (patch.op === 'attributes' && node.nodeType === Node.ELEMENT_NODE) {
      const before = new Map(node.attributes);
      node.attributes = sanitizeAttributes(patch.attributes);
      const after = new Map(node.attributes);
      const names = changeOf(node.id).attributes;
      for (const [name, value] of after) if (before.get(name) !== value) names.add(name);
      for (const name of before.keys()) if (!after.has(name)) names.add(name);
    } else if (patch.op === 'text' && node.nodeType !== Node.ELEMENT_NODE) {
      count(model.stats, node, -1);
      node.value = patch.value;
      node.truncated = patch.truncated;
      node.isWhitespace = isWhitespace(node);
      count(model.stats, node, 1);
      changeOf(node.id).text = true;
    }
  }

  return summary;
}
