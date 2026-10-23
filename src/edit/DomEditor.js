import { FROM_AGENT, TO_AGENT } from '../protocol/messages.js';

const TIMEOUT = 3000;

/**
 * Sends edits to the agent (dom:edit) and waits for each answer
 * (dom:edit-result). The changes themselves come back through the
 * MutationObserver, like any other change, so the tree updates by itself.
 *
 * Events it emits:
 *   - "history"  { undo, redo }   how many edits can be undone / redone
 *   - "error"    { message }      an edit the DOM refused (invalid tag name, impossible move…)
 */
export class DomEditor extends EventTarget {
  #preview;
  #nextId = 1;
  #pending = new Map(); // requestId → resolve

  constructor(preview) {
    super();
    this.#preview = preview;
    preview.addEventListener(FROM_AGENT.EDIT_RESULT, ({ detail }) => {
      const resolve = this.#pending.get(detail.requestId);
      if (!resolve) return;
      this.#pending.delete(detail.requestId);
      this.dispatchEvent(new CustomEvent('history', { detail: { undo: detail.undo, redo: detail.redo } }));
      if (!detail.ok) this.dispatchEvent(new CustomEvent('error', { detail: { message: detail.error ?? 'The edit failed.' } }));
      resolve(detail);
    });
  }

  /**
   * @param {import('../protocol/messages.js').Edit} edit
   * @returns {Promise<import('../protocol/messages.js').EditResult>}
   */
  edit(edit) {
    const requestId = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(requestId, resolve);
      this.#preview.send(TO_AGENT.EDIT, { requestId, edit });
      // If the preview does not answer (stuck in a loop, or it was re-run), give up quietly
      setTimeout(() => {
        if (this.#pending.delete(requestId)) resolve({ requestId, ok: false, undo: 0, redo: 0 });
      }, TIMEOUT);
    });
  }

  undo() {
    return this.edit({ op: 'undo' });
  }

  redo() {
    return this.edit({ op: 'redo' });
  }

  /** A new run: the old agent (and its undo history) is gone. */
  reset() {
    this.#pending.clear();
    this.dispatchEvent(new CustomEvent('history', { detail: { undo: 0, redo: 0 } }));
  }
}
