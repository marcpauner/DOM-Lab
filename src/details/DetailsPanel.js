import { h } from '../lib/dom.js';
import { readPref, writePref } from '../lib/storage.js';
import { createSegmented } from '../ui/segmented.js';
import { renderLabel, KINDS, KIND_LABELS, TYPE_NAMES, whitespaceSymbols, explainWhitespace } from '../tree/renderRow.js';
import './details.css';

const TABS = ['node', 'box', 'styles', 'events'];

// The computed styles worth looking at first. The rest are one click away ("All").
const STYLE_GROUPS = [
  {
    title: 'Layout',
    properties: ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'box-sizing',
      'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'overflow'],
  },
  {
    title: 'Flexbox',
    when: (display) => display.includes('flex'),
    properties: ['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap'],
  },
  {
    title: 'Grid',
    when: (display) => display.includes('grid'),
    properties: ['grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'justify-items', 'align-items', 'gap'],
  },
  { title: 'Spacing', properties: ['margin', 'padding', 'border', 'border-radius'] },
  {
    title: 'Typography',
    properties: ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
      'text-align', 'text-decoration-line', 'text-transform', 'white-space'],
  },
  {
    title: 'Appearance',
    properties: ['background-color', 'background-image', 'box-shadow', 'opacity', 'visibility', 'transform',
      'filter', 'transition', 'cursor'],
  },
];

const METRIC_ROWS = [
  ['offsetWidth', 'offsetHeight', 'Border box (content + padding + border)'],
  ['clientWidth', 'clientHeight', 'Padding box (content + padding), no scrollbar'],
  ['scrollWidth', 'scrollHeight', 'All the content, including what overflows'],
  ['offsetLeft', 'offsetTop', 'Position inside the offsetParent'],
  ['scrollLeft', 'scrollTop', 'How far its content is scrolled'],
];

const round = (value) => Number(value.toFixed(2));
const side = (value) => (value === 0 ? '–' : String(round(value)));
const camelCase = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

const section = (title, ...content) => h('section', { className: 'details__section' }, h('h3', {}, title), ...content);
const note = (text) => h('p', { className: 'details__note' }, text);
const props = (rows) =>
  h('dl', { className: 'props' }, ...rows.flatMap(([name, ...value]) => [h('dt', {}, name), h('dd', {}, ...value)]));

/**
 * Details of the selected node: its properties and attributes, its box
 * model, its computed styles and its event listeners. The app asks the agent
 * for them (node:request-details) every time the selection changes.
 */
export class DetailsPanel extends EventTarget {
  #host;
  #tabs;
  #badge;
  #tab;
  #node = null; // TreeNode from the tree model
  #details; // NodeDetails from the agent: undefined while loading, null if the node is gone
  #identity;
  #empty;
  #panels = {};
  #filter;
  #showAll;
  #styleList;
  #stylesView; // toolbar + list: stay in the DOM so the filter keeps its focus during live updates

  constructor(host, { tabs, eventsBadge }) {
    super();
    this.#host = host;
    this.#badge = eventsBadge;
    const saved = readPref('details-tab', 'node');
    this.#tab = TABS.includes(saved) ? saved : 'node';
    this.#tabs = createSegmented(tabs, { onChange: (tab) => this.#showTab(tab) });

    this.#empty = h('p', { className: 'details__empty' }, 'Select a node in the tree, or use Inspect to pick one in the preview.');
    this.#identity = h('div', { className: 'details__identity' });
    for (const tab of TABS) this.#panels[tab] = h('div', { className: 'details__panel', role: 'tabpanel' });

    // The styles filter is created once, so it keeps what you typed while you change nodes
    this.#filter = h('input', { className: 'details__filter', type: 'search', placeholder: 'Filter properties', 'aria-label': 'Filter properties' });
    this.#showAll = h('input', { className: 'switch', type: 'checkbox', role: 'switch' });
    this.#styleList = h('div');
    this.#filter.addEventListener('input', () => this.#renderStyleList());
    this.#showAll.addEventListener('change', () => this.#renderStyleList());
    this.#stylesView = [
      h(
        'div',
        { className: 'details__toolbar' },
        this.#filter,
        h('label', { className: 'switch-label', title: 'Show every computed property' }, this.#showAll, h('span', {}, 'All')),
      ),
      note('Computed values: the final result after the cascade, inheritance and unit conversion (em → px).'),
      this.#styleList,
    ];

    host.append(this.#empty, this.#identity, ...Object.values(this.#panels));
    // Anything with data-node-id (ancestors with listeners) can be selected with a click
    host.addEventListener('click', (event) => {
      const target = event.target.closest('button[data-node-id]');
      if (target) this.dispatchEvent(new CustomEvent('select-node', { detail: { id: Number(target.dataset.nodeId) } }));
    });

    this.#tabs.select(this.#tab);
    this.#render();
  }

  /** A new selection: the header updates at once, the rest when the details arrive. */
  show(node) {
    if (node?.id !== this.#node?.id) {
      this.#details = undefined;
      this.#host.scrollTop = 0;
    }
    this.#node = node;
    this.#host.classList.toggle('is-loading', Boolean(node));
    this.#render();
  }

  /** @param {import('../protocol/messages.js').NodeDetails|null} details */
  update(details) {
    this.#details = details;
    this.#host.classList.remove('is-loading');
    this.#render();
  }

  #showTab(tab) {
    this.#tab = tab;
    writePref('details-tab', tab);
    this.#host.scrollTop = 0;
    this.#render();
  }

  #render() {
    const node = this.#node;
    this.#empty.hidden = Boolean(node);
    this.#identity.hidden = !node;
    for (const tab of TABS) this.#panels[tab].hidden = !node || tab !== this.#tab;
    if (!node) {
      this.#badge.hidden = true;
      return;
    }
    this.#renderIdentity(node);
    // While loading, the previous content stays (dimmed): no flash when moving with the arrow keys
    if (this.#details === undefined) return;

    const details = this.#details;
    if (details === null) {
      const gone = note('This node is no longer in the document. Read the DOM again (↻) to refresh the tree.');
      for (const tab of TABS) this.#panels[tab].replaceChildren(gone.cloneNode(true));
      this.#badge.hidden = true;
      return;
    }
    this.#panels.node.replaceChildren(...this.#nodeTab(details));
    this.#panels.box.replaceChildren(...this.#boxTab(details));
    const styles = this.#stylesTab(details);
    // Moving an element (even to the same place) would blur the filter: only do it if needed
    if (styles !== this.#stylesView || this.#panels.styles.firstChild !== styles[0]) this.#panels.styles.replaceChildren(...styles);
    this.#panels.events.replaceChildren(...this.#eventsTab(details));
  }

  #renderIdentity(node) {
    const kind = KINDS[node.nodeType];
    this.#identity.replaceChildren(
      h(
        'div',
        { className: `details__label tree-row--${kind}`, dataset: { nodeId: node.id } },
        h('span', { className: 'tree-row__dot', 'aria-hidden': 'true' }),
        h('span', {}, ...renderLabel(node)),
      ),
      h('p', { className: 'details__type' }, `${KIND_LABELS[kind]} · nodeType ${node.nodeType} (${TYPE_NAMES[node.nodeType]})`),
    );
  }

  // ── Node: properties, attributes and text ───────────────────────

  #nodeTab(details) {
    const isElement = details.nodeType === Node.ELEMENT_NODE;
    // The same names you would use in JavaScript: element.nodeName, element.childNodes.length…
    const rows = [
      ['nodeName', `"${details.nodeName}"`],
      ['nodeType', String(details.nodeType)],
      ['childNodes.length', String(details.childNodes)],
    ];
    if (details.text === undefined) rows.push(['children.length', String(details.children)]);
    else rows.push(['data.length', String(details.length)]);
    const parts = [section('Properties', props(rows))];

    if (isElement) {
      const { attributes } = details;
      parts.push(
        section(
          `Attributes (${attributes.length})`,
          attributes.length ? props(attributes.map(([name, value]) => [name, ...attributeValue(name, value)])) : note('No attributes.'),
        ),
      );
    }

    if (details.text !== undefined) {
      const whitespaceOnly = /^[ \t\n\f\r]*$/.test(details.text);
      parts.push(
        section(
          'Text (data)',
          h('pre', { className: 'details__text' }, whitespaceOnly ? whitespaceSymbols(details.text) : details.text),
          whitespaceOnly ? note(`Only whitespace: ${explainWhitespace(details.text)}.`) : null,
          details.length > details.text.length ? note(`Showing the first ${details.text.length} of ${details.length} characters.`) : null,
        ),
      );
    }
    return parts;
  }

  // ── Box: box model diagram and measurements ─────────────────────

  #boxTab(details) {
    const { box, metrics } = details;
    if (!box) {
      return [
        note(
          details.nodeType === Node.ELEMENT_NODE
            ? 'This element is not rendered (display: none, or it lives in <head>), so it has no box.'
            : 'Only elements and text take up space on the page: this node has no box.',
        ),
      ];
    }
    const rect = section(
      'getBoundingClientRect()',
      props([
        ['x', String(round(box.x))],
        ['y', String(round(box.y))],
        ['width', String(round(box.width))],
        ['height', String(round(box.height))],
      ]),
      note('Relative to the top-left corner of the preview, in CSS pixels.'),
    );
    if (details.nodeType === Node.TEXT_NODE) {
      return [rect, note('Text nodes have no box model of their own: this is the rectangle their text occupies, measured with a Range.')];
    }

    const parts = [section('Box model', boxModel(box)), rect];
    if (metrics) {
      const rows = METRIC_ROWS.filter(([a, b]) => a in metrics && b in metrics).map(([a, b, help]) => [
        `${a} × ${b}`,
        `${round(metrics[a])} × ${round(metrics[b])}`,
        h('span', { className: 'details__hint' }, help),
      ]);
      if (metrics.offsetParent) rows.push(['offsetParent', metrics.offsetParent]);
      parts.push(section('Measurements', props(rows)));
    }
    return parts;
  }

  // ── Styles: computed styles ─────────────────────────────────────

  #stylesTab(details) {
    if (details.nodeType !== Node.ELEMENT_NODE) {
      return [note('Only elements have styles. Text nodes inherit theirs from their parent element.')];
    }
    if (details.styles.length === 0) return [note('No computed styles: the element is not in the document.')];
    this.#renderStyleList();
    return this.#stylesView;
  }

  #renderStyleList() {
    const styles = new Map(this.#details?.styles ?? []);
    const query = this.#filter.value.trim().toLowerCase();
    let groups;
    if (query || this.#showAll.checked) {
      const names = [...styles.keys()]
        .sort()
        .filter((name) => !query || name.includes(query) || styles.get(name).toLowerCase().includes(query));
      groups = [{ title: query ? `Matching "${query}" (${names.length})` : `All properties (${names.length})`, properties: names }];
    } else {
      const display = styles.get('display') ?? '';
      groups = STYLE_GROUPS.filter((group) => !group.when || group.when(display));
    }
    this.#styleList.replaceChildren(
      ...groups.map((group) => {
        const names = group.properties.filter((name) => styles.has(name));
        return section(
          group.title,
          names.length ? props(names.map((name) => [name, ...styleValue(styles.get(name))])) : note('Nothing matches.'),
        );
      }),
    );
  }

  // ── Events: listeners on the node and its ancestors ─────────────

  #eventsTab(details) {
    const own = details.listeners.filter((listener) => listener.own);
    const inherited = details.listeners.filter((listener) => !listener.own);
    this.#badge.textContent = String(own.length);
    this.#badge.hidden = own.length === 0;

    const parts = [
      section(
        `On this node (${own.length})`,
        own.length ? h('div', {}, ...own.map((listener) => renderListener(listener, false))) : note('No listeners on this node.'),
      ),
    ];
    if (inherited.length) {
      parts.push(
        section(
          `On its ancestors (${inherited.length})`,
          note('Most events bubble up the tree, so these listeners also run for events that start on this node. That is how event delegation works.'),
          h('div', {}, ...inherited.map((listener) => renderListener(listener, true))),
        ),
      );
    }
    parts.push(
      note('Listeners added with addEventListener(), el.onclick = … and onclick="…". There is no standard API to list them: the preview wraps addEventListener before your code runs.'),
    );
    return parts;
  }
}

/** DevTools-style box model: margin › border › padding › content, with each side's size. */
function boxModel(box) {
  const [bt, br, bb, bl] = box.border;
  const [pt, pr, pb, pl] = box.padding;
  const width = Math.max(0, box.width - bl - br - pl - pr);
  const height = Math.max(0, box.height - bt - bb - pt - pb);

  const layer = (name, [top, right, bottom, left], inner) => {
    inner.classList.add('bm__inner');
    return h(
      'div',
      { className: `bm bm--${name}` },
      h('span', { className: 'bm__name' }, name),
      h('span', { className: 'bm__top' }, side(top)),
      h('span', { className: 'bm__left' }, side(left)),
      inner,
      h('span', { className: 'bm__right' }, side(right)),
      h('span', { className: 'bm__bottom' }, side(bottom)),
    );
  };
  const content = h('div', { className: 'bm__content' }, `${round(width)} × ${round(height)}`);
  return h(
    'div',
    { className: 'boxmodel', role: 'img', 'aria-label': `Content ${round(width)} by ${round(height)} pixels` },
    layer('margin', box.margin, layer('border', box.border, layer('padding', box.padding, content))),
  );
}

/** An attribute's value, plus a hint about the JavaScript property that reflects it. */
function attributeValue(name, value) {
  const parts = [];
  if (name === 'class' && value.trim()) {
    parts.push(...value.trim().split(/\s+/).map((token) => h('span', { className: 'details__pill' }, token)));
    parts.push(h('span', { className: 'details__hint' }, 'element.classList'));
  } else {
    parts.push(h('span', { className: 'details__value' }, value === '' ? '""' : value));
  }
  if (name.startsWith('data-')) parts.push(h('span', { className: 'details__hint' }, `element.dataset.${camelCase(name.slice(5))}`));
  else if (name === 'style') parts.push(h('span', { className: 'details__hint' }, 'Inline styles: element.style'));
  else if (name.startsWith('on')) parts.push(h('span', { className: 'details__hint' }, 'Inline event handler'));
  return parts;
}

// rgb()/rgba() colors get a swatch. Only a strict rgb() pattern reaches style,
// never the raw string from the iframe.
const COLOR = /rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:\s*[,/]\s*[\d.]+%?)?\s*\)/;

function styleValue(value) {
  const color = value.match(COLOR)?.[0];
  if (!color) return [value];
  const swatch = h('span', { className: 'swatch', 'aria-hidden': 'true' });
  swatch.style.backgroundColor = color;
  return [swatch, value];
}

const KIND_TEXT = {
  listener: () => 'addEventListener',
  property: (type) => `on${type} property`,
  attribute: (type) => `on${type}="…" attribute`,
};

function renderListener(listener, showTarget) {
  const flags = ['capture', 'once', 'passive'].filter((flag) => listener[flag]);
  const target = !showTarget
    ? null
    : listener.targetId === null
      ? h('span', { className: 'listener__target' }, listener.target)
      : h(
          'button',
          { className: 'listener__target', type: 'button', title: 'Select in the tree', dataset: { nodeId: listener.targetId } },
          listener.target,
        );
  return h(
    'div',
    { className: 'listener' },
    h(
      'div',
      { className: 'listener__head' },
      h('span', { className: 'listener__type' }, listener.type),
      target,
      h('span', { className: 'listener__kind' }, KIND_TEXT[listener.kind](listener.type)),
      ...flags.map((flag) => h('span', { className: 'listener__flag' }, flag)),
    ),
    listener.handler ? h('pre', { className: 'listener__code' }, listener.handler) : null,
  );
}
