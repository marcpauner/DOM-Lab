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
import { buildModel } from './tree/model.js';
import { TreeView } from './tree/TreeView.js';
import { renderBreadcrumb } from './tree/breadcrumb.js';
import { ConsolePanel } from './console/ConsolePanel.js';
import { DetailsPanel } from './details/DetailsPanel.js';
import { initTheme } from './ui/theme.js';
import { initSplitters } from './ui/splitters.js';
import { createSegmented } from './ui/segmented.js';
import { registerShortcut, listShortcuts, formatShortcut, isMac, SECONDARY } from './ui/shortcuts.js';
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
const tree = new TreeView($('#tree-host'));
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

preview.addEventListener(FROM_AGENT.SNAPSHOT, ({ detail }) => {
  clearTimeout(stallTimer);
  const model = buildModel(detail.root);
  if (!model) return;
  modelIsCurrent = true;
  tree.setModel(model);
  if (pendingPick !== null) pick(pendingPick);
  $('#tree-count').textContent = `${model.stats.total.toLocaleString('en')} nodes`;
  $('#ws-count').textContent = `(${model.stats.whitespace})`;
  if (detail.truncated) {
    consolePanel.system(`Huge document: the tree only shows the first ${LIMITS.MAX_NODES.toLocaleString('en')} nodes.`, 'warn');
  }
  setStatus('ready', 'Ready');
});

preview.addEventListener(FROM_AGENT.CONSOLE, ({ detail }) => consolePanel.add(detail.entries, detail.dropped));

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
whitespace.addEventListener('change', () => {
  tree.setHideWhitespace(whitespace.checked);
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

tree.addEventListener('select', ({ detail: node }) => {
  details.show(node);
  clearTimeout(detailsTimer);
  // Moving fast with the arrow keys sends one request, not one per row
  if (node && modelIsCurrent) detailsTimer = setTimeout(() => preview.send(TO_AGENT.REQUEST_DETAILS, { id: node.id }), 80);
});

preview.addEventListener(FROM_AGENT.DETAILS, ({ detail }) => {
  // Only the answer for the node that is still selected matters
  if (detail.id === tree.selectedId) details.update(detail.details);
});

// Ancestors with listeners can be selected from the Events tab
details.addEventListener('select-node', ({ detail }) => {
  if (tree.select(detail.id, { reveal: true })) tree.focus();
});

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

$('#console-clear').addEventListener('click', () => consolePanel.clear());

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
registerShortcut(`${SECONDARY}+L`, 'Clear the console', () => consolePanel.clear());
registerShortcut(`${SECONDARY}+J`, 'Show or hide the console', toggleConsole);
registerShortcut(`${SECONDARY}+I`, 'Inspect an element in the preview', () => setInspecting(!inspecting));
registerShortcut('Escape', 'Cancel inspect mode', () => setInspecting(false), { when: () => inspecting });
registerShortcut('?', 'Show keyboard shortcuts', () => dialog.showModal());

const TREE_KEYS = [
  ['↑ ↓', 'Tree: move between nodes'],
  ['← →', 'Tree: collapse / expand'],
  [isMac ? '⌥ + click' : 'Alt + click', 'Tree: expand with all descendants'],
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
