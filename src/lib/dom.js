/**
 * Creates an element with properties and children:
 *
 *   h('span', { className: 'tag', title: 'Element' }, 'div')
 *
 * String children are added with append(), which turns them into TEXT
 * nodes. They are never parsed as HTML, so this is safe to use with data
 * coming from the iframe (unlike innerHTML).
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('aria-') || key === 'role') element.setAttribute(key, value);
    else element[key] = value; // DOM properties: className, title, type…
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}
