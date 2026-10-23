import { h } from '../lib/dom.js';

/*
 * Visual content of each tree row. Everything is built with createElement
 * and text nodes (through h()), never with innerHTML: names, attributes and
 * text come from the iframe and could contain malicious HTML.
 */

export const KINDS = {
  [Node.ELEMENT_NODE]: 'element',
  [Node.TEXT_NODE]: 'text',
  [Node.CDATA_SECTION_NODE]: 'text',
  [Node.COMMENT_NODE]: 'comment',
  [Node.PROCESSING_INSTRUCTION_NODE]: 'comment',
  [Node.DOCUMENT_NODE]: 'document',
  [Node.DOCUMENT_TYPE_NODE]: 'document',
  [Node.DOCUMENT_FRAGMENT_NODE]: 'document',
};

export const TYPE_NAMES = {
  [Node.ELEMENT_NODE]: 'ELEMENT_NODE',
  [Node.TEXT_NODE]: 'TEXT_NODE',
  [Node.CDATA_SECTION_NODE]: 'CDATA_SECTION_NODE',
  [Node.PROCESSING_INSTRUCTION_NODE]: 'PROCESSING_INSTRUCTION_NODE',
  [Node.COMMENT_NODE]: 'COMMENT_NODE',
  [Node.DOCUMENT_NODE]: 'DOCUMENT_NODE',
  [Node.DOCUMENT_TYPE_NODE]: 'DOCUMENT_TYPE_NODE',
  [Node.DOCUMENT_FRAGMENT_NODE]: 'DOCUMENT_FRAGMENT_NODE',
};

export const KIND_LABELS = { element: 'Element', text: 'Text', comment: 'Comment', document: 'Document' };

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Name as you would type it: DIV → div. SVG tags (linearGradient) are kept as they are. */
export function displayName(node) {
  const name = node.nodeName;
  return name === name.toUpperCase() ? name.toLowerCase() : name;
}

/** Short label for breadcrumbs: div#app.card */
export function shortLabel(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return renderLabel(node).map((part) => part.textContent).join('');
  let text = displayName(node);
  const id = node.attributes.find(([name]) => name === 'id')?.[1];
  const className = node.attributes.find(([name]) => name === 'class')?.[1].trim().split(/\s+/)[0];
  if (id) text += `#${id}`;
  if (className) text += `.${className}`;
  return text;
}

export function renderRow(node, { childCount }) {
  const kind = KINDS[node.nodeType];
  const row = h(
    'div',
    {
      className: `tree-row tree-row--${kind}`,
      id: `tree-row-${node.id}`,
      role: 'treeitem',
      'aria-level': node.depth + 1,
      title: describe(node, kind, childCount),
      // Anything that represents a DOM node carries data-node-id (see main.js: hover → highlight)
      dataset: { nodeId: node.id },
    },
    h('span', { className: 'tree-row__twisty', 'aria-hidden': 'true' }),
    h('span', { className: 'tree-row__dot', 'aria-hidden': 'true' }),
    h('span', { className: 'tree-row__label' }, ...renderLabel(node)),
  );
  row.style.setProperty('--depth', node.depth);
  if (node.isWhitespace) row.classList.add('tree-row--whitespace');
  if (childCount > 0) {
    row.classList.add('has-children');
    row.append(h('span', { className: 'tree-row__count', 'aria-hidden': 'true' }, String(childCount)));
  }
  return row;
}

const tok = (kind, text) => h('span', { className: `tok tok--${kind}` }, text);
const preview = (text, max = 120) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The node written as tokens: <div id="app">, "text", <!--comment-->… */
export function renderLabel(node) {
  switch (node.nodeType) {
    case Node.ELEMENT_NODE:
      return elementLabel(node);
    case Node.TEXT_NODE:
    case Node.CDATA_SECTION_NODE:
      return node.isWhitespace ? [tok('ws', whitespaceSymbols(node.value))] : textLabel(node.value);
    case Node.COMMENT_NODE:
      return [tok('comment', `<!--${preview(node.value)}-->`)];
    case Node.DOCUMENT_TYPE_NODE:
      return [tok('doctype', `<!DOCTYPE ${node.nodeName}>`)];
    case Node.DOCUMENT_NODE:
      return [tok('document', '#document')];
    case Node.DOCUMENT_FRAGMENT_NODE:
      return [tok('document', node.mode ? `#shadow-root (${node.mode})` : '#document-fragment')];
    default:
      return [tok('comment', `<?${node.nodeName} ${preview(node.value)}?>`)];
  }
}

function elementLabel(node) {
  const parts = [tok('punct', '<'), tok('tag', displayName(node))];
  for (const [name, value] of node.attributes) {
    const attr = h('span', { className: 'tok-attr' }, tok('attr-name', name));
    // Boolean attributes (hidden, disabled…): their value is "" and the name is enough
    if (value !== '') attr.append(tok('punct', '="'), tok('attr-value', preview(value, 80)), tok('punct', '"'));
    parts.push(attr);
  }
  parts.push(tok('punct', '>'));
  return parts;
}

/** "\n    Hello\n  " → "↵Hello↵": every line break (with its indentation) shows up as ↵ */
function textLabel(value) {
  const parts = [tok('punct', '"')];
  preview(value, 160)
    .split(/([\n\r][ \t\n\f\r]*)/)
    .forEach((piece, index) => {
      if (index % 2 === 1) parts.push(tok('ws', '↵'));
      else if (piece) parts.push(tok('text', piece));
    });
  parts.push(tok('punct', '"'));
  return parts;
}

/** Makes invisible characters visible: ↵ line break, · space, → tab */
export function whitespaceSymbols(value) {
  if (value === '') return '""';
  const symbols = [...value.slice(0, 24)].map((char) => (char === '\n' ? '↵' : char === '\t' ? '→' : '·')).join('');
  return value.length > 24 ? `${symbols}…` : symbols;
}

export function explainWhitespace(value) {
  const count = (char) => value.split(char).length - 1;
  const parts = [];
  const lines = count('\n');
  const spaces = count(' ');
  const tabs = count('\t');
  if (lines) parts.push(plural(lines, 'line break'));
  if (spaces) parts.push(plural(spaces, 'space'));
  if (tabs) parts.push(plural(tabs, 'tab'));
  return parts.join(', ') || 'empty';
}

/** Row tooltip: node kind and its nodeType */
function describe(node, kind, childCount) {
  const lines = [`${KIND_LABELS[kind]} · nodeType ${node.nodeType} (${TYPE_NAMES[node.nodeType]})`];
  if (node.isWhitespace) lines.push(`Whitespace only: ${explainWhitespace(node.value)}`);
  if (childCount > 0) lines.push(`${childCount} ${childCount === 1 ? 'child' : 'children'}`);
  if (node.truncated) lines.push('Text truncated (too long)');
  return lines.join('\n');
}
