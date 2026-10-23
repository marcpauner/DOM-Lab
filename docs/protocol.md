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

### App → agent (`TO_AGENT`)

| Type | Payload | Effect |
| --- | --- | --- |
| `dom:request-snapshot` | `{}` | The agent walks the DOM again and sends `dom:snapshot`. |

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
```

## Planned messages for the next phases

They will use the same envelope; names may change when they are implemented.

| Phase | Direction | Type | Payload |
| --- | --- | --- | --- |
| 2 | app → agent | `overlay:highlight` | `{ id \| null }` — track a node's box |
| 2 | app → agent | `inspect:set` | `{ enabled }` — turns "inspect" mode on or off |
| 2 | agent → app | `overlay:box` | `{ id, box, label }` — the tracked node's box model |
| 2 | agent → app | `inspect:hover` | `{ id \| null }` — the pointer is over a node in the preview |
| 2 | agent → app | `inspect:pick` | `{ id }` — click while inspecting |
| 3 | app → agent | `node:request-details` | `{ id }` |
| 3 | agent → app | `node:details` | `{ id, computedStyle, box, listeners? }` |
| 4 | agent → app | `dom:mutations` | `{ records: Patch[] }` — incremental changes from a `MutationObserver` |
| 5 | app → agent | `attr:set`, `attr:remove`, `text:set`, `node:remove`, `node:move`, `node:insert` | `{ requestId, id, … }` |
| 5 | agent → app | `command:result` | `{ requestId, ok, error? }` |

From phase 2 on, the agent needs the reverse lookup (id → node). It uses a `Map<id, WeakRef<Node>>`, so it still does not stop the garbage collector from freeing removed nodes.
