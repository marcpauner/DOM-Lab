import { h } from '../lib/dom.js';
import './toast.css';

let region = null;

/**
 * A short notification at the bottom of the window, with an optional action
 * ("Undo", "Run"…). The container is a live region (role="status"), so
 * screen readers announce the message.
 */
export function toast(message, { action, duration = 6000 } = {}) {
  if (!region) {
    region = h('div', { className: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const close = () => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 200);
  };
  const button = action
    ? h('button', { className: 'toast__action', type: 'button', onclick: () => (close(), action.run()) }, action.label)
    : null;
  const element = h('div', { className: 'toast' }, h('span', {}, message), button);
  region.append(element);
  setTimeout(close, duration);
}
