# App ⇄ agent message protocol

The app (your page) and the preview (an `<iframe sandbox="allow-scripts allow-forms">`) live in **different origins**: the iframe has no `allow-same-origin`, so the browser gives it an opaque origin (`"null"`). Neither side can touch the other's DOM. The only way to communicate is `postMessage`.

The protocol's source code is in [`src/protocol/messages.js`](../src/protocol/messages.js). It is the single source of truth: the agent receives the same constants injected as JSON when the `srcdoc` is built.

## The envelope

Every message, in both directions, has the same shape:

```js
{
  channel: 'dom-lab',      // filters out foreign messages (extensions, other sites…)
  version: 1,              // lets the protocol evolve
  runId:   'lx3k9-a8f2',   // every run gets a new one
  type:    'dom:snapshot', // "domain:action"
  payload: { … }           // plain data only
}
```

- **`runId`** discards messages from a previous run. It is needed because, for a moment, the old and the new iframe coexist (double buffering to avoid flashes).
- **`payload`** travels through the *structured clone algorithm*: it supports objects, arrays, strings, numbers… but **not** functions or DOM nodes. That is why the agent serializes the tree.

## Validation (on both sides)

**In the app** (`PreviewBridge.#receive`), every message goes through four filters:

1. `event.source === iframe.contentWindow`: it comes from *our* current iframe.
2. `event.origin === 'null'`: the iframe is still sandboxed.
3. `isMessage()`: it has the right envelope and the current `runId`.
4. `readPayload()`: the content has the expected shape for its type.

> ⚠️ The user's code runs in the same document as the agent and **can send any message** with `parent.postMessage()`. The filters do not prevent that, so the app treats everything as untrusted data: it never uses `eval`, never uses `innerHTML` with it (everything is rendered with `textContent` / text nodes) and enforces size limits (`LIMITS`).

**In the agent**, only messages with `event.source === window.parent` are obeyed. If the user's code sends itself a message with `window.postMessage()`, `event.source` is the iframe itself and the message is ignored.

**`targetOrigin`**: the agent sends with the app's exact origin (`parent.postMessage(msg, 'https://user.github.io')`). The app sends with `'*'` because an opaque origin cannot be named; this is safe because the target is one specific window (`iframe.contentWindow`) and no sensitive data is ever sent.

## Messages

### Agent → app (`FROM_AGENT`)

| Type | Payload | When |
| --- | --- | --- |
| `agent:ready` | `{}` | The agent has loaded (before your code). |
| `dom:snapshot` | `{ root: SerializedNode, truncated }` | Once after `DOMContentLoaded`, then only when the app asks or a batch of changes is too big. |
| `console:entries` | `{ entries: ConsoleEntry[], dropped }` | Batches of `console.*` calls, errors and sandbox warnings. |
| `overlay:box` | `{ id, box: Box \| null, label }` | The followed node's box model: right away, then whenever it changes. |
| `inspect:hover` | `{ id \| null }` | Inspect mode: the pointer moved onto another node. Always sent *before* its box. |
| `inspect:pick` | `{ id \| null }` | Inspect mode: the user clicked a node. Inspect mode ends. |
| `node:details` | `{ id, details: NodeDetails \| null }` | Answer to `node:request-details` (`null`: the node no longer exists). |
| `dom:mutations` | `{ patches: Patch[], records: ChangeRecord[], dropped, overflow }` | Live changes, in batches every 50 ms at most. |
| `dom:edit-result` | `{ requestId, ok, error?, id?, undo, redo }` | Answer to `dom:edit`. |
| `dom:html` | `{ html }` | The live DOM as HTML: the doctype plus `document.documentElement.outerHTML`. |

### App → agent (`TO_AGENT`)

| Type | Payload | Effect |
| --- | --- | --- |
| `dom:request-snapshot` | `{}` | The agent walks the DOM again and sends `dom:snapshot`. |
| `overlay:highlight` | `{ id \| null }` | The agent starts following that node's box (`null` stops). Ignored while inspecting. |
| `inspect:set` | `{ enabled }` | Turns inspect mode on or off. |
| `node:request-details` | `{ id }` | Asks for everything the details panel shows about a node. |
| `dom:edit` | `{ requestId, edit: Edit }` | Changes the live DOM (see [Editing](#editing)). |
| `dom:request-html` | `{}` | Asks for the live DOM as HTML, for the "Download the live DOM" export. |

### Data types

```js
// SerializedNode
{
  id: 42,                         // stable while the node exists (WeakMap in the agent)
  nodeType: 1,                    // 1 element, 3 text, 8 comment, 9 document, 10 doctype, 11 fragment
  nodeName: 'UL',
  attributes: [['id', 'list']],   // elements only; pairs to keep the order
  value: '…',                     // text and comments only
  truncated: true,                // the text was cut
  mode: 'open',                   // shadow roots only
  children: [ /* SerializedNode */ ]
}

// ConsoleEntry
{
  kind: 'console' | 'exception' | 'rejection' | 'resource' | 'sandbox' | 'clear',
  level: 'log' | 'info' | 'warn' | 'error' | 'debug',
  args: [{ type: 'string', text: 'hello' }, { type: 'node', text: 'ul#list', nodeId: 42 }],
  time: 1793000000000,
  location: { line: 57, column: 3 }, // document line; the app maps it to script.js:12:3
  stack: '…'
}

// Box: CSS pixels relative to the preview's viewport
{
  x: 40, y: 131, width: 478, height: 268,   // border box (getBoundingClientRect)
  margin:  [0, 0, 0, 0],                     // [top, right, bottom, left]
  border:  [0, 0, 0, 0],
  padding: [32, 40, 32, 40]
}

// NodeDetails
{
  nodeType: 1, nodeName: 'UL',
  childNodes: 5, children: 3,             // childNodes.length and children.length
  attributes: [['id', 'list']],
  text: '…', length: 13,                  // text and comments only (data and data.length)
  box: Box | null,                        // null if it is not rendered
  metrics: {                              // elements only
    offsetWidth: 398, offsetHeight: 22, offsetTop: 308, offsetLeft: 78, offsetParent: 'body',
    clientWidth: 398, clientHeight: 22, scrollWidth: 398, scrollHeight: 22, scrollTop: 0, scrollLeft: 0
  },
  styles: [['display', 'flex'], ['margin', '16px 0px'], …],   // getComputedStyle + a few shorthands
  listeners: [{                                              // Listener[]
    own: true, target: 'ul#list', targetId: 42,
    type: 'click', kind: 'listener',                         // 'listener' | 'property' | 'attribute'
    capture: false, once: false, passive: false,
    handler: "(e) => console.log('clicked', e.target)"
  }]
}
```

## Node details and event listeners

`node:request-details` answers with everything the details panel shows. Most of it comes from standard APIs (`getComputedStyle`, `getBoundingClientRect`, `offsetWidth`…), but **there is no standard way to list an element's event listeners**: `getEventListeners()` only exists inside DevTools. So the agent keeps its own record:

1. At the very end of its startup (after registering its own listeners) it replaces `EventTarget.prototype.addEventListener` and `removeEventListener` with wrappers that call the original and note the listener in a `WeakMap` (target → listeners).
2. Listeners added with `{ once: true }` or an `AbortSignal` are removed from the record when they remove themselves.
3. Event handler properties (`el.onclick = fn`) and attributes (`onclick="…"`) are read directly from each node.

The details include the listeners of the node **and of its ancestors up to `window`**: most events bubble, so those also run for events that start on the node (event delegation).

## Highlighting and inspect mode

The overlay is **drawn by the app**, on top of the iframe, never inside it: adding elements to the preview would change the user's DOM (they would show up in the tree and in `querySelectorAll`). The agent only measures:

1. `overlay:highlight` arrives → the agent measures the node (`getBoundingClientRect` + `getComputedStyle`; a `Range` for text nodes) and sends `overlay:box` right away.
2. Then it measures again on every `requestAnimationFrame` and only sends a new box when it changes, so scrolling, animations and layout changes are followed.
3. Inspect mode adds capture-phase listeners on `window`, registered before the user's code: hovering sends `inspect:hover`, and every event a click is made of (`pointerdown`, `mousedown`, `click`…) is cancelled, so the user's handlers never see it. The crosshair cursor comes from a constructed stylesheet (`document.adoptedStyleSheets`), which adds no node to the document either.

The app ignores boxes that arrive late for a node it no longer highlights, and since ids change on every run, it sends no highlight until the new tree has arrived.

## Live updates

Right after the first snapshot, the agent starts a `MutationObserver` on the whole document (`childList`, `attributes`, `characterData`, `subtree`, plus the old values). Its records are collected for up to 50 ms and sent as one `dom:mutations` message with two parts:

- **`patches`** update the tree. They describe the **current state** of whatever changed, not each step: replaying MutationRecords one by one is fragile, because by the time the observer's callback runs the DOM may already have changed again.

  ```js
  { op: 'children', id: 12, children: [13, 14, { id: 40, nodeType: 1, nodeName: 'LI', … }] }
  // ul (12) now has these children: 13 and 14 it already knew, 40 is new (sent in full)
  { op: 'attributes', id: 9, attributes: [['class', 'a b']] }
  { op: 'text', id: 15, value: 'Changed!', truncated: false }
  ```

  Applying a patch twice gives the same result. The agent keeps a `WeakSet` of the nodes the app already has, so only new nodes travel in full. A node that leaves the document is forgotten; if it comes back it is sent in full again, with the same id (the `WeakMap` remembers it).

- **`records`** feed the history of changes: one `ChangeRecord` per MutationRecord, with the nodes added and removed, or the attribute / text before and after. The value *after* each change is the `oldValue` of the next change to the same attribute, or the live value for the last one (the batch is walked backwards).

```js
// ChangeRecord
{ type: 'attributes', time: 1793000000000, targetId: 9, target: 'h1', name: 'class', oldValue: 'a', value: 'a b' }
{ type: 'childList', time: 1793000000000, targetId: 12, target: 'ul#list',
  added: [{ id: 40, label: 'li.new', whitespace: false }], removed: [] }
```

In the app, `applyPatches()` (`tree/model.js`) applies every `children` patch first (a node dropped by one parent may have been picked up by another one in the same batch), then deletes what nobody picked up, then applies attributes and text. If a patch names a node the app does not have, it asks for a full snapshot. With more than `LIMITS.MAX_MUTATIONS` records in one batch the agent skips the patches and sends a full snapshot instead.

## Editing

Edits from the interface travel as one message type, `dom:edit`, with an `edit` object:

```js
{ op: 'set-attribute', id, name, value }       // element.setAttribute(name, value)
{ op: 'remove-attribute', id, name }           // element.removeAttribute(name)
{ op: 'set-text', id, value }                  // textOrComment.data = value
{ op: 'insert', parentId, beforeId, kind, value } // createElement / createTextNode / createComment + insertBefore
{ op: 'move', id, parentId, beforeId }         // parent.insertBefore(node, before): an existing node MOVES
{ op: 'duplicate', id }                        // node.after(node.cloneNode(true))
{ op: 'remove', id }                           // node.remove()
{ op: 'undo' } / { op: 'redo' }
```

`beforeId: null` means "at the end", like the second argument of `insertBefore`.

1. The agent applies the edit to the **live DOM**. The user's code is never touched: running again starts over.
2. It stores the edit as a pair of functions, `apply` and `revert`, on an undo stack (100 steps). `undo` and `redo` move steps between the two stacks.
3. The changes reach the app like any other: through the `MutationObserver`. Right before applying the edit the agent takes the pending records as `source: 'page'`; right after, the new ones as `source: 'app'`, so the history can tell your edits from what the page's code did. It sends them at once instead of waiting for the 50 ms batch.
4. It answers with `dom:edit-result`. When the DOM refuses an edit (an invalid tag name, a node moved inside itself…) `ok` is `false` and `error` carries the DOM exception, e.g. `InvalidCharacterError: … is not a valid name`.

Commands that name a node need the reverse lookup (id → node). The agent keeps a `Map<id, WeakRef<Node>>` plus a `FinalizationRegistry` that removes the entry once the node is collected, so it still never keeps removed nodes alive. The undo stack, on the other hand, does hold strong references: a removed node has to stay alive to be put back.
