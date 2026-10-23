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
| `dom:snapshot` | `{ root: SerializedNode, truncated }` | After `DOMContentLoaded`, after `load` and whenever the app asks. |
| `console:entries` | `{ entries: ConsoleEntry[], dropped }` | Batches of `console.*` calls, errors and sandbox warnings. |
| `overlay:box` | `{ id, box: Box \| null, label }` | The followed node's box model: right away, then whenever it changes. |
| `inspect:hover` | `{ id \| null }` | Inspect mode: the pointer moved onto another node. Always sent *before* its box. |
| `inspect:pick` | `{ id \| null }` | Inspect mode: the user clicked a node. Inspect mode ends. |
| `node:details` | `{ id, details: NodeDetails \| null }` | Answer to `node:request-details` (`null`: the node no longer exists). |

### App → agent (`TO_AGENT`)

| Type | Payload | Effect |
| --- | --- | --- |
| `dom:request-snapshot` | `{}` | The agent walks the DOM again and sends `dom:snapshot`. |
| `overlay:highlight` | `{ id \| null }` | The agent starts following that node's box (`null` stops). Ignored while inspecting. |
| `inspect:set` | `{ enabled }` | Turns inspect mode on or off. |
| `node:request-details` | `{ id }` | Asks for everything the details panel shows about a node. |

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

## Planned messages for the next phases

They will use the same envelope; names may change when they are implemented.

| Phase | Direction | Type | Payload |
| --- | --- | --- | --- |
| 4 | agent → app | `dom:mutations` | `{ records: Patch[] }` — incremental changes from a `MutationObserver` |
| 5 | app → agent | `attr:set`, `attr:remove`, `text:set`, `node:remove`, `node:move`, `node:insert` | `{ requestId, id, … }` |
| 5 | agent → app | `command:result` | `{ requestId, ok, error? }` |

Commands that name a node need the reverse lookup (id → node). The agent keeps a `Map<id, WeakRef<Node>>` plus a `FinalizationRegistry` that removes the entry once the node is collected, so it still never keeps removed nodes alive.
