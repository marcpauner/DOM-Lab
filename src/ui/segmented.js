/**
 * Segmented control (Apple-style tabs): a row of role="tab" buttons with
 * data-value, plus a .segmented__thumb that slides under the active one.
 * Follows the ARIA tabs pattern: arrow keys move between tabs.
 *
 * onChange(value, { user }) runs when the user picks a tab; select() changes
 * it from code without calling onChange.
 */
export function createSegmented(root, { onChange }) {
  const items = [...root.querySelectorAll('[role="tab"]')];
  const thumb = root.querySelector('.segmented__thumb');
  let active = null;

  // The thumb is placed by measuring the active button
  const place = () => {
    if (!active) return;
    thumb.style.setProperty('--thumb-x', `${active.offsetLeft}px`);
    thumb.style.setProperty('--thumb-w', `${active.offsetWidth}px`);
  };

  function select(value) {
    for (const item of items) {
      const selected = item.dataset.value === value;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      if (selected) active = item;
    }
    place();
  }

  root.addEventListener('click', (event) => {
    const item = event.target.closest('[role="tab"]');
    if (!item) return;
    select(item.dataset.value);
    onChange(item.dataset.value, { user: true });
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = items[(items.indexOf(active) + step + items.length) % items.length];
    select(next.dataset.value);
    next.focus();
    onChange(next.dataset.value, { user: false });
  });

  // When the Inter font loads, the buttons change width: measure again.
  // The thumb only animates after that first placement.
  new ResizeObserver(place).observe(root);
  document.fonts.ready.then(() => {
    place();
    requestAnimationFrame(() => thumb.classList.add('is-ready'));
  });

  return {
    select,
    get value() {
      return active?.dataset.value ?? null;
    },
  };
}
