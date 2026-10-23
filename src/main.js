/*
 * ENTRY POINT
 * Wires the pieces together: editors → preview (iframe + agent) → tree and console.
 */
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';

import { createEditors, LANGUAGES } from './editor/editors.js';
import { PreviewBridge } from './preview/PreviewBridge.js';
import { Overlay } from './preview/Overlay.js';
import { FROM_AGENT, TO_AGENT, LIMITS } from './protocol/messages.js';
import { buildModel, applyPatches, isProtected } from './tree/model.js';
import { shortLabel } from './tree/renderRow.js';
import { DomEditor } from './edit/DomEditor.js';
import { NodeMenu } from './edit/NodeMenu.js';
import { TreeView } from './tree/TreeView.js';
import { renderBreadcrumb } from './tree/breadcrumb.js';
import { ConsolePanel } from './console/ConsolePanel.js';
import { ChangesPanel } from './changes/ChangesPanel.js';
import { DetailsPanel } from './details/DetailsPanel.js';
import { initTheme } from './ui/theme.js';
import { initSplitters } from './ui/splitters.js';
import { createSegmented } from './ui/segmented.js';
import { registerShortcut, listShortcuts, formatShortcut, isMac, isTyping, SECONDARY } from './ui/shortcuts.js';
import { readPref, writePref } from './lib/storage.js';
import { debounce } from './lib/debounce.js';
import { h } from './lib/dom.js';
import { STARTER } from './examples/starter.js';

const $ = (selector) => document.querySelector(selector);

const AUTORUN_DELAY = 500;
const STALL_TIMEOUT = 3000;

// ── Layout and theme ────────────────────────────────────────────────
const layout = initSplitters($('#workspace'));
initTheme($('#theme-button'));

// ── Editors ─────────────────────────────────────────────────────────
const editors = createEditors($('#editor-host'), { initial: STARTER, onChange: onEdit });
// A click on a tab also moves the focus to the editor; the arrow keys stay on the tabs
const editorTabs = createSegmented($('#editor-tabs'), { onChange: (id, { user }) => showEditor(id, { focus: user }) });

function showEditor(id, { focus = false } = {}) {
  editors.show(id);
  editorTabs.select(id);
  writePref('editor-tab', id);
  if (focus) editors.focus(id);
}

const savedTab = readPref('editor-tab', 'html');
showEditor(LANGUAGES.some((lang) => lang.id === savedTab) ? savedTab : 'html');

// ── Preview, console and tree ───────────────────────────────────────
const preview = new PreviewBridge($('#preview-host'));
const consolePanel = new ConsolePanel($('#console-host'), {
  locate: (line, column) => preview.locate(line, column),
});
const changesPanel = new ChangesPanel($('#changes-host'));
const tree = new TreeView($('#tree-host'));
let model = null; // the current tree model: replaced by each snapshot, patched by live changes
const status = $('#preview-status');
const autorun = $('#autorun');

// JS only runs when you ask for it (⌘/Ctrl+Enter). Auto-run on HTML or CSS
// edits reuses the last JS you ran: that way a half-typed loop cannot
// freeze the tab.
let executedJs = editors.getValue('js');
let stallTimer = 0;
const autoRun = debounce(() => run({ keepJs: true }), AUTORUN_DELAY);

function run({ keepJs = false } = {}) {
  autoRun.cancel();
  if (!keepJs) {
    executedJs = editors.getValue('js');
    setJsPending(false);
  }
  resetHighlight();
  consolePanel.clear();
  changesPanel.reset();
  domEditor.reset();
  setStatus('running', 'Running…');
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    setStatus('stalled', 'Not responding');
    consolePanel.system('The preview is not responding. Is there an infinite loop in your JavaScript? Fix it and run again.', 'warn');
  }, STALL_TIMEOUT);
  preview.run({ html: editors.getValue('html'), css: editors.getValue('css'), js: executedJs });
}

function onEdit(lang) {
  if (lang === 'js') setJsPending(editors.getValue('js') !== executedJs);
  else if (autorun.checked) autoRun();
}

function setJsPending(pending) {
  $('#js-pending-dot').hidden = !pending;
  $('#pending-js').hidden = !pending;
}

function setStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}

function showStats() {
  $('#tree-count').textContent = `${model.stats.total.toLocaleString('en')} nodes`;
  $('#ws-count').textContent = `(${model.stats.whitespace})`;
}

preview.addEventListener(FROM_AGENT.SNAPSHOT, ({ detail }) => {
  clearTimeout(stallTimer);
  const next = buildModel(detail.root);
  if (!next) return;
  model = next;
  modelIsCurrent = true;
  tree.setModel(model);
  if (pendingPick !== null) pick(pendingPick);
  showStats();
  if (detail.truncated) {
    consolePanel.system(`Huge document: the tree only shows the first ${LIMITS.MAX_NODES.toLocaleString('en')} nodes.`, 'warn');
  }
  setStatus('ready', 'Live');
});

preview.addEventListener(FROM_AGENT.CONSOLE, ({ detail }) => consolePanel.add(detail.entries, detail.dropped));

// Live changes: the history gets the records, the tree gets the patches
preview.addEventListener(FROM_AGENT.MUTATIONS, ({ detail }) => {
  if (detail.overflow) {
    changesPanel.system(`${detail.overflow.toLocaleString('en')} changes at once: the tree is read again from scratch.`);
  }
  changesPanel.add(detail.records, detail.dropped);
  if (!model || !modelIsCurrent || detail.patches.length === 0) return;

  const summary = applyPatches(model, detail.patches);
  tree.applyChanges(summary);
  showStats();
  if (pendingSelect !== null && tree.select(pendingSelect, { reveal: true })) {
    pendingSelect = null;
    tree.focus();
  }
  // The agent mentioned a node we do not have: start over with a full tree
  if (summary.resync) preview.send(TO_AGENT.REQUEST_SNAPSHOT);

  // The selected node may have changed too: refresh its breadcrumbs and details
  const selected = tree.selectedNode;
  if (selected) {
    renderBreadcrumb(breadcrumb, selected);
    details.show(selected);
    requestDetails(selected, { restart: false });
  }
});

preview.addEventListener('navigated', () => {
  setStatus('stalled', 'Left your document');
  consolePanel.system('The preview navigated to another page and the tree can no longer be read. Press Run to go back.', 'warn');
});

$('#run-button').addEventListener('click', () => run());
$('#pending-js').addEventListener('click', () => run());

// ── Highlighting and inspect mode ───────────────────────────────────
// Everything in the app that represents a DOM node carries data-node-id:
// tree rows, breadcrumbs, nodes logged in the console and the details
// panel. Hovering any of
// them highlights that node in the preview. The agent measures the node
// and sends its box; the Overlay draws it on top of the iframe.
const overlay = new Overlay($('#preview-host'));
const treeHost = $('#tree-host');
const inspectButton = $('#inspect-button');
let modelIsCurrent = false; // ids change on every run: until the new tree arrives, they mean nothing
let highlighted = null; // id the agent is following
let pointerNodeId = null; // id under the pointer in the app
let inspecting = false;
let inspectHoverId = null; // id under the pointer in the preview, while inspecting
let pendingPick = null; // picked node that is not in the tree yet

/** With nothing under the pointer, the selected node stays highlighted while the tree has focus (keyboard navigation). */
const restingId = () => pointerNodeId ?? (document.activeElement === treeHost ? tree.selectedId : null);

function highlight(id) {
  if (inspecting || !modelIsCurrent || id === highlighted) return;
  highlighted = id;
  if (id === null) overlay.hide();
  preview.send(TO_AGENT.HIGHLIGHT, { id });
}

function resetHighlight() {
  modelIsCurrent = false;
  highlighted = null;
  inspectHoverId = null;
  pendingPick = null;
  overlay.hide();
  tree.setHovered(null);
}

// pointerover bubbles, so a single listener on document covers the whole app
document.addEventListener('pointerover', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-node-id]') : null;
  pointerNodeId = target ? Number(target.dataset.nodeId) : null;
  highlight(restingId());
});
document.documentElement.addEventListener('pointerleave', () => {
  pointerNodeId = null;
  highlight(restingId());
});
// During focusout, activeElement is not updated yet: check on the next tick
treeHost.addEventListener('focusin', () => highlight(restingId()));
treeHost.addEventListener('focusout', () => setTimeout(() => highlight(restingId())));

preview.addEventListener(FROM_AGENT.BOX, ({ detail }) => {
  // A box may arrive late for a node we no longer highlight: ignore it
  if (detail.id !== (inspecting ? inspectHoverId : highlighted)) return;
  if (detail.box) overlay.show(detail.box, detail.label);
  else overlay.hide();
});

function setInspecting(enabled) {
  if (enabled === inspecting) return;
  inspecting = enabled;
  inspectHoverId = null;
  highlighted = null; // the agent stops following when the mode changes
  overlay.hide();
  tree.setHovered(null);
  inspectButton.setAttribute('aria-pressed', String(enabled));
  $('.panel--preview').classList.toggle('is-inspecting', enabled);
  $('#inspect-hint').hidden = !enabled;
  preview.send(TO_AGENT.SET_INSPECT, { enabled });
  if (!enabled) highlight(restingId());
}

/** Selects a node in the tree and gives it focus, so it stays highlighted. */
function pick(id) {
  pendingPick = null;
  if (!tree.select(id, { reveal: true })) return false;
  tree.focus();
  return true;
}

preview.addEventListener(FROM_AGENT.HOVER, ({ detail }) => {
  if (!inspecting) return;
  inspectHoverId = detail.id;
  if (detail.id === null) overlay.hide();
  tree.setHovered(detail.id, { reveal: true });
});

preview.addEventListener(FROM_AGENT.PICK, ({ detail }) => {
  setInspecting(false);
  if (detail.id === null || pick(detail.id)) return;
  // A node created after the last snapshot: read the DOM again and select it then
  pendingPick = detail.id;
  preview.send(TO_AGENT.REQUEST_SNAPSHOT);
});

// A new run starts with a fresh agent: tell it if we were inspecting
preview.addEventListener(FROM_AGENT.READY, () => {
  if (inspecting) preview.send(TO_AGENT.SET_INSPECT, { enabled: true });
});

inspectButton.addEventListener('click', () => setInspecting(!inspecting));
autorun.checked = readPref('autorun', true);
autorun.addEventListener('change', () => writePref('autorun', autorun.checked));

// ── Tree panel ──────────────────────────────────────────────────────
const whitespace = $('#ws-toggle');
whitespace.checked = readPref('hide-whitespace', true);
tree.setHideWhitespace(whitespace.checked);
changesPanel.hideWhitespace = whitespace.checked;
whitespace.addEventListener('change', () => {
  tree.setHideWhitespace(whitespace.checked);
  changesPanel.hideWhitespace = whitespace.checked;
  writePref('hide-whitespace', whitespace.checked);
});

$('#tree-expand').addEventListener('click', () => tree.expandAll());
$('#tree-collapse').addEventListener('click', () => tree.collapseAll());
$('#tree-refresh').addEventListener('click', () => preview.send(TO_AGENT.REQUEST_SNAPSHOT));

// The tree header floats above the rows: the tree needs to know its height
const treeHeader = $('#tree-header');
new ResizeObserver(() => {
  $('#tree-host').style.setProperty('--tree-header-h', `${treeHeader.offsetHeight}px`);
}).observe(treeHeader);

const breadcrumb = $('#tree-breadcrumb');
renderBreadcrumb(breadcrumb, null);
tree.addEventListener('select', ({ detail }) => renderBreadcrumb(breadcrumb, detail));
tree.addEventListener('select', () => highlight(restingId()));
breadcrumb.addEventListener('click', (event) => {
  const item = event.target.closest('[data-node-id]');
  if (!item) return;
  tree.select(Number(item.dataset.nodeId));
  tree.focus();
});

// ── Details panel ───────────────────────────────────────────────────
// Every new selection asks the agent for that node's details.
const details = new DetailsPanel($('#details-host'), { tabs: $('#details-tabs'), eventsBadge: $('#events-count') });
let detailsTimer = 0;

/**
 * Asks for a node's details a moment later. A new selection restarts the wait
 * (moving fast with the arrow keys sends one request, not one per row); live
 * changes do not, so an animation cannot keep postponing the refresh forever.
 */
function requestDetails(node, { restart = true } = {}) {
  if (!restart && detailsTimer) return;
  clearTimeout(detailsTimer);
  detailsTimer = 0;
  if (!node || !modelIsCurrent) return;
  detailsTimer = setTimeout(() => {
    detailsTimer = 0;
    preview.send(TO_AGENT.REQUEST_DETAILS, { id: node.id });
  }, 80);
}

tree.addEventListener('select', ({ detail: node }) => {
  details.show(node);
  requestDetails(node);
});

preview.addEventListener(FROM_AGENT.DETAILS, ({ detail }) => {
  // Only the answer for the node that is still selected matters
  if (detail.id === tree.selectedId) details.update(detail.details);
});

// Ancestors with listeners can be selected from the Events tab
details.addEventListener('select-node', ({ detail }) => {
  if (tree.select(detail.id, { reveal: true })) tree.focus();
});

// ── Editing the live DOM ────────────────────────────────────────────
// Every edit is a dom:edit command for the agent, which applies it with the
// usual DOM methods. The result comes back through the MutationObserver
// like any other change: the tree updates and the history records it.
const domEditor = new DomEditor(preview);
const menu = new NodeMenu();
const undoButton = $('#tree-undo');
const redoButton = $('#tree-redo');
let pendingSelect = null; // a node just created: select it as soon as it reaches the tree

domEditor.addEventListener('history', ({ detail }) => {
  undoButton.disabled = detail.undo === 0;
  redoButton.disabled = detail.redo === 0;
});

domEditor.addEventListener('error', ({ detail }) => {
  consolePanel.system(`The edit was not applied. ${detail.message}`, 'error');
  showLog('console');
});

/** New nodes arrive with the next batch of changes: select them when they do. */
function selectWhenReady(result) {
  if (!result.ok || !result.id) return;
  if (tree.select(result.id, { reveal: true })) tree.focus();
  else pendingSelect = result.id;
}

const edit = (change) => domEditor.edit(change);

/** Alt+↑ / Alt+↓: swap places with the previous or next (visible) sibling. */
function reorder(node, direction) {
  if (isProtected(node)) return;
  const siblings = node.parent.children;
  const visible = (sibling) => !(sibling.isWhitespace && whitespace.checked);
  let index = siblings.indexOf(node);
  let target;
  do {
    index += direction;
    target = siblings[index];
  } while (target && !visible(target));
  if (!target) return; // already the first or the last one
  const before = direction < 0 ? target : (siblings[index + 1] ?? null);
  edit({ op: 'move', id: node.id, parentId: node.parent.id, beforeId: before?.id ?? null });
}

function remove(node) {
  if (!isProtected(node)) edit({ op: 'remove', id: node.id });
}

async function insertChild(parent, kind, at) {
  const questions = {
    element: { title: `New element inside ${shortLabel(parent)}`, placeholder: 'Tag name, e.g. li' },
    text: { title: `New text inside ${shortLabel(parent)}`, placeholder: 'Text' },
    comment: { title: `New comment inside ${shortLabel(parent)}`, placeholder: 'Comment' },
  };
  const value = await menu.ask(at, { ...questions[kind], action: 'Add' });
  if (value === null) return;
  selectWhenReady(await edit({ op: 'insert', parentId: parent.id, beforeId: null, kind, value }));
}

function openMenu(node, at) {
  const items = [];
  const canHaveChildren = node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
  const hasText = node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE;
  const altKeys = (arrow) => (isMac ? `⌥${arrow}` : `Alt+${arrow}`);
  if (canHaveChildren) {
    items.push(
      { label: 'Add child element…', run: () => insertChild(node, 'element', at) },
      { label: 'Add text…', run: () => insertChild(node, 'text', at) },
      { label: 'Add comment…', run: () => insertChild(node, 'comment', at) },
    );
  }
  if (hasText) items.push({ label: 'Edit text', keys: 'Double-click', run: () => details.editText() });
  if (!isProtected(node)) {
    if (items.length) items.push('separator');
    items.push(
      { label: 'Duplicate', run: async () => selectWhenReady(await edit({ op: 'duplicate', id: node.id })) },
      { label: 'Move up', keys: altKeys('↑'), run: () => reorder(node, -1) },
      { label: 'Move down', keys: altKeys('↓'), run: () => reorder(node, 1) },
      'separator',
      { label: 'Delete', keys: isMac ? '⌫' : 'Del', danger: true, run: () => remove(node) },
    );
  }
  if (items.length) menu.open(at, items, { title: shortLabel(node) });
}

tree.addEventListener('menu', ({ detail }) => openMenu(detail.node, detail));
tree.addEventListener('remove', ({ detail }) => remove(detail.node));
tree.addEventListener('reorder', ({ detail }) => reorder(detail.node, detail.direction));
tree.addEventListener('move', ({ detail }) => edit({ op: 'move', ...detail }));
tree.addEventListener('edit-text', () => details.editText());
details.addEventListener('edit', ({ detail }) => edit(detail));

undoButton.addEventListener('click', () => domEditor.undo());
redoButton.addEventListener('click', () => domEditor.redo());

// Help popover: placed under its button (getBoundingClientRect)
const help = $('#tree-help');
help.addEventListener('beforetoggle', (event) => {
  if (event.newState !== 'open') return;
  const anchor = $('[popovertarget="tree-help"]').getBoundingClientRect();
  const width = Math.min(340, innerWidth - 32);
  help.style.top = `${anchor.bottom + 8}px`;
  help.style.left = `${Math.max(16, Math.min(anchor.right - width, innerWidth - width - 16))}px`;
});

// ── Console ─────────────────────────────────────────────────────────
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

consolePanel.addEventListener('counts', ({ detail }) => {
  const errors = $('#console-errors');
  const warnings = $('#console-warnings');
  errors.hidden = detail.error === 0;
  warnings.hidden = detail.warn === 0;
  errors.textContent = plural(detail.error, 'error');
  warnings.textContent = plural(detail.warn, 'warning');
});

// Click on a node logged with console.log(element) → show it in the tree
consolePanel.addEventListener('reveal-node', ({ detail }) => {
  if (tree.select(detail.id, { reveal: true })) tree.focus();
  else consolePanel.system('That node is not in the tree: it may no longer be part of the document, or it is a hidden whitespace node.');
});

// Click on "script.js:12:5" → jump to that line in the editor
consolePanel.addEventListener('goto', ({ detail }) => {
  showEditor(detail.file);
  editors.goTo(detail.file, detail.line, detail.column);
});

// ── Changes (history of DOM mutations) ──────────────────────────────
// The console panel has two tabs: Console and Changes
const logTabs = createSegmented($('#log-tabs'), { onChange: showLog });

function showLog(tab) {
  $('#console-host').hidden = tab !== 'console';
  $('#changes-host').hidden = tab !== 'changes';
  logTabs.select(tab);
  writePref('log-tab', tab);
}
showLog(readPref('log-tab', 'console') === 'changes' ? 'changes' : 'console');

changesPanel.addEventListener('count', ({ detail }) => {
  const badge = $('#changes-count');
  badge.hidden = detail.count === 0;
  badge.textContent = detail.count > 999 ? '999+' : String(detail.count);
});

changesPanel.addEventListener('select-node', ({ detail }) => {
  if (tree.select(detail.id, { reveal: true })) tree.focus();
});

/** The clear button (and its shortcut) clears whichever tab is showing. */
function clearLog() {
  if (logTabs.value === 'changes') changesPanel.clear();
  else consolePanel.clear();
}
$('#console-clear').addEventListener('click', clearLog);

// ── Collapsible panels ──────────────────────────────────────────────
/** Wires a collapse button to a bottom panel. Returns the toggle function. */
function collapsible(key, button, name) {
  const sync = (collapsed) => {
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} the ${name}`);
  };
  const toggle = () => sync(layout.toggle(key));
  sync(layout.isCollapsed(key));
  button.addEventListener('click', toggle);
  return toggle;
}

const toggleConsole = collapsible('console', $('#console-toggle'), 'console');
collapsible('details', $('#details-toggle'), 'details');

// ── Keyboard shortcuts ──────────────────────────────────────────────
registerShortcut('Mod+Enter', 'Run the code', () => run());
registerShortcut('Mod+S', 'Run (instead of "Save page")', () => run());
LANGUAGES.forEach((lang, index) => {
  registerShortcut(`${SECONDARY}+${index + 1}`, `Edit ${lang.label}`, () => showEditor(lang.id, { focus: true }));
});
registerShortcut(`${SECONDARY}+W`, 'Show or hide whitespace nodes', () => whitespace.click());
registerShortcut(`${SECONDARY}+L`, 'Clear the console (or the changes)', clearLog);
registerShortcut(`${SECONDARY}+J`, 'Show or hide the console', toggleConsole);
registerShortcut(`${SECONDARY}+I`, 'Inspect an element in the preview', () => setInspecting(!inspecting));
registerShortcut('Escape', 'Cancel inspect mode', () => setInspecting(false), { when: () => inspecting });
// Outside the editors and text fields (they have their own undo)
const notTyping = () => modelIsCurrent && !isTyping(document.activeElement);
registerShortcut('Mod+Z', 'Undo the last DOM edit', () => domEditor.undo(), { when: notTyping });
registerShortcut('Mod+Shift+Z', 'Redo the DOM edit', () => domEditor.redo(), { when: notTyping });
registerShortcut('?', 'Show keyboard shortcuts', () => dialog.showModal());

const TREE_KEYS = [
  ['↑ ↓', 'Tree: move between nodes'],
  ['← →', 'Tree: collapse / expand'],
  [isMac ? '⌥ + click' : 'Alt + click', 'Tree: expand with all descendants'],
  [isMac ? '⌥↑ ⌥↓' : 'Alt+↑ Alt+↓', 'Tree: move the node up / down'],
  [isMac ? '⌫' : 'Delete', 'Tree: delete the node'],
  ['Right-click', 'Tree: add, duplicate, move or delete'],
];

const dialog = $('#shortcuts-dialog');
const shortcutList = $('#shortcut-list');
for (const { combo, label } of listShortcuts()) {
  shortcutList.append(h('dt', {}, label), h('dd', {}, h('kbd', {}, formatShortcut(combo))));
}
for (const [keys, label] of TREE_KEYS) shortcutList.append(h('dt', {}, label), h('dd', {}, h('kbd', {}, keys)));

$('#shortcuts-button').addEventListener('click', () => dialog.showModal());
// Click outside the dialog (on the backdrop) → close, for browsers without closedby="any"
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

const runKeys = formatShortcut('Mod+Enter');
$('#run-kbd').textContent = runKeys;
$('#pending-js kbd').textContent = runKeys;
$('#run-button').title = `Run HTML, CSS and JavaScript (${runKeys})`;
inspectButton.title = `Inspect an element (${formatShortcut(`${SECONDARY}+I`)})`;

// First run!
run();
