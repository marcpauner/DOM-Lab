# DOM Lab

**Write HTML, CSS and JavaScript and see the DOM tree the browser builds, visually.**

**[Try it live →](https://marcpauner.github.io/DOM-Lab/)** · [MIT](LICENSE) license

DOM Lab is a playground for learning how the DOM works. Paste your code, it runs in an isolated preview, and the resulting node tree appears next to it: elements, text, comments and attributes, each with its own color. Browser DevTools (F12) are powerful but rough for learning, and tools like Live DOM Viewer or CodePen are visually limited; DOM Lab aims to be friendlier.

It is built with **plain JavaScript** (no React, no Vue): the app's own source is meant to be study material about the DOM.

## Screenshots

> Coming soon: light mode, dark mode and the tree in action (e.g. in `docs/screenshots/`).

## Features

- **Editor** for HTML, CSS and JavaScript powered by [CodeMirror 6](https://codemirror.net/): syntax highlighting, autocompletion, tag closing and `Tab` to indent.
- **Run** with the button or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on Mac).
- **Auto-run** when editing HTML or CSS. JavaScript only runs when you ask for it, so a half-typed loop (`while (true) {}`) cannot freeze the tab.
- **Isolated preview** in a sandboxed `iframe` with no access to the app.
- **DOM tree** of the resulting document:
  - colors per node type (element, text, comment, document) and attributes as "pills";
  - animated expand and collapse (<kbd>Alt</kbd>+click for the whole branch);
  - keyboard navigation (arrows, Home, End, Page Up / Page Down);
  - breadcrumbs with the `parentNode` chain up to `#document`;
  - option to **hide text nodes that only contain whitespace** (on by default, with an explanation);
  - virtualized: stays smooth with tens of thousands of nodes.
- **DevTools-style highlighting**: hover a node in the tree, the breadcrumbs or the console and the preview shows its box model (margin, border, padding and content) with its size.
- **Inspect mode** (<kbd>Alt</kbd>+<kbd>I</kbd>, <kbd>⌃</kbd>+<kbd>I</kbd> on Mac): hover the preview to find elements in the tree, click to select one. Your page's own click handlers do not fire while inspecting.
- **Details panel** for the selected node:
  - **Node**: `nodeName`, `nodeType`, `childNodes` / `children` and attributes, with the JavaScript property that reflects them (`data-user-id` → `element.dataset.userId`, `class` → `element.classList`);
  - **Box**: a visual box model (margin, border, padding, content) plus `getBoundingClientRect()`, `offset*`, `client*` and `scroll*`;
  - **Styles**: computed styles grouped by topic (layout, flexbox, grid, spacing, typography, appearance), with a filter, color swatches and the full list;
  - **Events**: listeners added with `addEventListener`, `el.onclick = …` or `onclick="…"`, on the node and on its ancestors (event delegation).
- **Built-in console** with `console.log/info/warn/error/debug/table/assert/clear`, uncaught errors and rejected promises:
  - errors link to the line in your code (`script.js:12:5`);
  - if you log a node (`console.log(element)`), one click shows it in the tree;
  - repeated messages are grouped with a counter.
- **Light and dark mode** (follows the system) with a manual toggle.
- **Resizable panels** (keyboard accessible too) and **keyboard shortcuts** (press <kbd>?</kbd>).

## Keyboard shortcuts

| Action | Windows / Linux | Mac |
| --- | --- | --- |
| Run | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>Ctrl</kbd>+<kbd>S</kbd> | <kbd>⌘</kbd>+<kbd>↵</kbd> or <kbd>⌘</kbd>+<kbd>S</kbd> |
| Edit HTML / CSS / JS | <kbd>Alt</kbd>+<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | <kbd>⌃</kbd>+<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> |
| Show or hide whitespace nodes | <kbd>Alt</kbd>+<kbd>W</kbd> | <kbd>⌃</kbd>+<kbd>W</kbd> |
| Clear the console | <kbd>Alt</kbd>+<kbd>L</kbd> | <kbd>⌃</kbd>+<kbd>L</kbd> |
| Show or hide the console | <kbd>Alt</kbd>+<kbd>J</kbd> | <kbd>⌃</kbd>+<kbd>J</kbd> |
| Inspect an element / cancel | <kbd>Alt</kbd>+<kbd>I</kbd> / <kbd>Esc</kbd> | <kbd>⌃</kbd>+<kbd>I</kbd> / <kbd>Esc</kbd> |
| Show all shortcuts | <kbd>?</kbd> | <kbd>?</kbd> |

On Mac, secondary shortcuts use <kbd>⌃</kbd> rather than <kbd>⌥</kbd> because on many keyboard layouts (Spanish, for example) <kbd>⌥</kbd>+digit types symbols such as `@`, `#` or `|`.

## How it works

```
┌──────────────── App (your origin) ───────────────┐      ┌──── sandboxed iframe (origin "null") ───┐
│                                                  │      │                                         │
│  Editors ──▶ srcdoc.js ──▶ PreviewBridge ────────┼─────▶│  <script>AGENT</script>  ← first        │
│                                   ▲              │      │  <style>your CSS</style>                │
│  TreeView ◀── model.js ◀──────────┤ postMessage  │◀─────┤  your HTML                              │
│  ConsolePanel ◀───────────────────┘              │      │  <script>your JS</script>               │
└──────────────────────────────────────────────────┘      └─────────────────────────────────────────┘
```

1. `preview/srcdoc.js` builds a full document with your code and, before anything else, the **agent** (`agent/agent.js`).
2. The agent captures `console.*` and errors, and once the document has loaded it **walks the DOM** and turns it into plain objects.
3. It sends them to the app with `postMessage`. `PreviewBridge` validates every message and re-emits it as a `CustomEvent`.
4. `tree/model.js` validates the tree again, node by node, and `TreeView` renders it.

The full protocol is documented in [`docs/protocol.md`](docs/protocol.md).

### Project structure

```
├── index.html               UI structure
├── src/
│   ├── main.js              Entry point: wires the modules together
│   ├── protocol/messages.js App ⇄ agent protocol: types, limits and validation
│   ├── agent/agent.js       Runs INSIDE the iframe (injected as text)
│   ├── preview/
│   │   ├── srcdoc.js        Builds the preview document
│   │   ├── PreviewBridge.js Creates the iframe and handles postMessage
│   │   └── Overlay.js       Box model overlay drawn on top of the iframe
│   ├── editor/              CodeMirror editors and their theme
│   ├── tree/                Tree model, virtualized view, breadcrumbs
│   ├── details/             Details panel: node, box model, styles, listeners
│   ├── console/             Console panel
│   ├── ui/                  Theme, resizable panels and shortcuts
│   ├── lib/                 Helpers: h() to create elements, debounce, preferences
│   ├── examples/            Starter code
│   └── styles/              Design system (custom properties) and layout
└── docs/protocol.md         Message protocol documentation
```

### DOM concepts you will find in the code

- **`nodeType` and `childNodes`** (`agent/agent.js`): walking the tree, and why `childNodes` includes text and comments while `children` only has elements.
- **Whitespace text nodes** (`tree/model.js`): why the `\s` regex does not work (it matches `&nbsp;`).
- **`WeakMap`, `WeakRef` and `FinalizationRegistry`** (`agent/agent.js`): stable ids per node, and the way back from an id to its node, without keeping removed nodes from being garbage collected.
- **Box model** (`agent/agent.js`, `preview/Overlay.js`): `getBoundingClientRect`, `getComputedStyle`, a `Range` to measure text nodes, and drawing margin / border / padding / content.
- **Event phases** (`agent/agent.js`): capture-phase listeners on `window` that run before the user's own, plus `stopImmediatePropagation` and `preventDefault`.
- **Listing event listeners** (`agent/agent.js`): there is no standard API for it, so the agent wraps `EventTarget.prototype.addEventListener` before your code runs.
- **Computed styles and measurements** (`agent/agent.js`, `details/DetailsPanel.js`): `getComputedStyle`, and the difference between `offsetWidth`, `clientWidth` and `scrollWidth`.
- **`postMessage` and origins** (`preview/PreviewBridge.js`): `event.source`, `event.origin` and `targetOrigin`.
- **Virtualization** (`tree/TreeView.js`): render only what is visible and animate with `transform`.
- **Creating nodes safely** (`lib/dom.js`): `createElement` + `append` versus `innerHTML`.
- **Modern native APIs**: `<dialog>`, the `popover` attribute, `ResizeObserver`, View Transitions, `light-dark()`.

## Security

DOM Lab is public and anyone can paste code, so the preview is truly isolated:

- `iframe` with `sandbox="allow-scripts allow-forms"` and **no `allow-same-origin`**: the iframe gets an opaque origin and cannot read the app's DOM, cookies or `localStorage`.
- The app **never touches the iframe's DOM**: it only exchanges messages with the agent.
- Everything coming from the iframe is validated and rendered as text: **no `eval`, no `innerHTML`** with that data.
- Size limits (number of nodes, text length, console messages per batch).

`allow-forms` is there on purpose: without it, the `submit` event never even fires and you could not practise form validation. It gives the code no extra power (with `allow-scripts` it can already navigate with `location.href`); the agent cancels the submission if your code does not, so the preview is not lost. To remove it, change the `SANDBOX` constant in `src/preview/PreviewBridge.js`.

## Local development

Requires [Node.js](https://nodejs.org/) 20 or later.

```bash
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # production build in dist/
npm run preview   # serve dist/ to try it
```

## Deploying to GitHub Pages

The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds and publishes the app on every push to `main`.

1. Push the code to a GitHub repository.
2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Wait for the workflow in the **Actions** tab. The app will be live at `https://<your-user>.github.io/<repository>/`.

No repository name needs to be configured: `vite.config.js` uses `base: './'` (relative paths), so it works under any subfolder.

## Roadmap

- [x] **Phase 1**: project structure, editors, isolated run with agent, read-only DOM tree and console.
- [x] **Phase 2**: highlight in the preview the node under the pointer (DevTools-style overlay) and "inspect" mode.
- [x] **Phase 3**: details panel: attributes, computed styles, visual box model and event listeners.
- [ ] **Phase 4**: live tree with `MutationObserver`, mutation history and change animations.
- [ ] **Phase 5**: editing from the UI: attributes, text, add, remove and move nodes.
- [ ] **Phase 6**: `localStorage` persistence, templates, code export and sharing via URL.

## Known limitations

- The tree is read when the page loads (`DOMContentLoaded` and `load`). Later changes (for example in a `setTimeout` or after clicking a button) show up with **Read the DOM again** (↻). The live tree comes in phase 4.
- The details panel shows the node as it was when you selected it. After changes, select it again or press ↻.
- Only listeners added by your code are listed: the preview starts recording them right before your code runs.
- The HTML panel represents the content of `<body>`. If you paste a full document, the browser ignores the repeated `<html>`, `<head>` and `<body>` tags.
- `alert()`, `confirm()` and `prompt()` are disabled in the sandbox: a warning shows up in the console.
- If your JS enters an infinite loop, depending on the browser the app's tab may freeze too.
- Shortcuts do not work while focus is inside the preview (it is a different document).

## License

[MIT](LICENSE) © 2026 marcpauner
