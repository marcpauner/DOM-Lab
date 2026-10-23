import { h } from '../lib/dom.js';
import { shortLabel } from './renderRow.js';

/**
 * Breadcrumbs: the chain of parentNode from #document down to the selected
 * node. Each crumb is a button with data-id so it can be selected.
 */
export function renderBreadcrumb(container, node) {
  if (!node) {
    container.replaceChildren(h('span', { className: 'breadcrumb__hint' }, 'Select a node to see its path from the root'));
    return;
  }
  const chain = [];
  for (let current = node; current; current = current.parent) chain.unshift(current);

  const items = [];
  chain.forEach((item, index) => {
    if (index > 0) items.push(h('span', { className: 'breadcrumb__separator', 'aria-hidden': 'true' }, '›'));
    items.push(
      h(
        'button',
        {
          className: 'breadcrumb__item',
          type: 'button',
          'aria-current': item === node ? 'true' : null,
          dataset: { id: item.id },
        },
        shortLabel(item),
      ),
    );
  });
  container.replaceChildren(...items);
  container.scrollLeft = container.scrollWidth;
}
