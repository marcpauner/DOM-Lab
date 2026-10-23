import { buildSrcdoc } from './srcdoc.js';
import { createMessage, isMessage, readPayload } from '../protocol/messages.js';

/*
 * allow-scripts → the user's JS runs.
 * allow-forms   → forms fire "submit" (without it the event never even
 *                 fires and you could not practise form validation).
 * NO allow-same-origin → the iframe gets an opaque origin ("null"): it cannot
 * read the app's DOM, cookies or localStorage, and the app cannot reach into
 * its DOM either. All communication goes through postMessage.
 */
const SANDBOX = 'allow-scripts allow-forms';

/** Maximum time to wait for the iframe to load before showing it anyway. */
const REVEAL_TIMEOUT = 1500;

const createRunId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Creates the preview iframe and acts as a "bridge" to its agent.
 * It is an EventTarget: every valid message from the agent is re-emitted
 * as a CustomEvent named after the message type (e.g. "dom:snapshot").
 */
export class PreviewBridge extends EventTarget {
  #host;
  #frame = null;
  #runId = null;
  #locate = () => null;

  constructor(host) {
    super();
    this.#host = host;
    window.addEventListener('message', (event) => this.#receive(event));
  }

  run({ html, css, js }) {
    const runId = createRunId();
    const { srcdoc, locate } = buildSrcdoc({ html, css, js, runId, appOrigin: location.origin });

    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.title = 'Preview of your code';
    frame.setAttribute('sandbox', SANDBOX);
    frame.srcdoc = srcdoc;

    let loads = 0;
    frame.addEventListener('load', () => {
      loads++;
      if (loads === 1) this.#reveal(frame);
      // A second "load" means the document navigated to another page
      // (e.g. location.href = …) and the agent is gone.
      else if (frame === this.#frame) this.dispatchEvent(new CustomEvent('navigated'));
    });

    // An iframe that was still getting ready is no longer needed.
    for (const pending of this.#host.querySelectorAll('.preview-frame:not(.is-visible)')) pending.remove();

    // The previous iframe stays visible until the new one loads, so there
    // is no white flash on every run (double buffering).
    this.#frame = frame;
    this.#runId = runId;
    this.#locate = locate;
    this.#host.append(frame);
    setTimeout(() => this.#reveal(frame), REVEAL_TIMEOUT);
  }

  /** Sends a command to the agent of the current run. */
  send(type, payload = {}) {
    // targetOrigin '*': an opaque origin cannot be named. This is safe
    // because we target one specific window and never send sensitive data.
    this.#frame?.contentWindow?.postMessage(createMessage(this.#runId, type, payload), '*');
  }

  /** Maps a line of the iframe document to your code. */
  locate(line, column) {
    return this.#locate(line, column);
  }

  #reveal(frame) {
    if (frame !== this.#frame || frame.classList.contains('is-visible')) return;
    frame.classList.add('is-visible');
    const previous = [...this.#host.querySelectorAll('.preview-frame')].filter((other) => other !== frame);
    // Wait for the fade before destroying the previous iframes.
    setTimeout(() => previous.forEach((old) => old.remove()), 250);
  }

  #receive(event) {
    // 1. Does it come from OUR current iframe? event.source is the window
    //    that sent the message; old iframes and other windows are ignored.
    if (!this.#frame || event.source !== this.#frame.contentWindow) return;
    // 2. A sandboxed iframe without allow-same-origin always has origin "null".
    if (event.origin !== 'null') return;
    // 3. Does it have our protocol's shape, and is it from this run?
    if (!isMessage(event.data, this.#runId)) return;
    // 4. Is the content valid for its type?
    const payload = readPayload(event.data.type, event.data.payload);
    if (payload === null) return;

    this.dispatchEvent(new CustomEvent(event.data.type, { detail: payload }));
  }
}
