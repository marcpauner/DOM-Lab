import agentSource from '../agent/agent.js?raw';
import { CHANNEL, VERSION, FROM_AGENT, TO_AGENT, LIMITS } from '../protocol/messages.js';

// The agent receives the protocol constants as JSON: a single source of truth.
const PROTOCOL = JSON.stringify({ CHANNEL, VERSION, FROM_AGENT, TO_AGENT, LIMITS });

/** File names shown in the console (script.js:12:5). */
export const FILE_NAMES = { html: 'index.html', css: 'style.css', js: 'script.js' };

// A "</script>" inside your JS would close the tag too early: it is the HTML
// parser, not JavaScript, that decides where a <script> ends.
// "<\/script>" means the same thing in JS (and "<\/style>" in CSS).
export const escapeEndTag = (code, tag) => code.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

const countNewlines = (text) => text.split('\n').length - 1;

/**
 * Builds the full preview document:
 *
 *   <!DOCTYPE html><html><head>
 *     <meta…> <script>AGENT</script> <style>YOUR CSS</style>
 *   </head><body>
 *     YOUR HTML <script>YOUR JS</script>
 *   </body></html>
 *
 * It also returns locate(), which maps a document line to a line of your
 * code (so errors point to script.js:12).
 */
export function buildSrcdoc({ html, css, js, runId, appOrigin }) {
  // If the app itself were served from an opaque origin we could not name it.
  const config = JSON.stringify({ runId, appOrigin: appOrigin === 'null' ? '*' : appOrigin });
  const agent =
    `<script>(() => {\n'use strict';\nconst PROTOCOL = ${PROTOCOL};\nconst CONFIG = ${config};\n` +
    `${agentSource}\n})();</script>`;

  // No spaces or line breaks between tags: any whitespace we added would
  // show up in the tree as a text node that is not in your code.
  const beforeHtml =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `${agent}<style>${escapeEndTag(css, 'style')}</style></head><body>`;
  const beforeJs = `${beforeHtml}${html}<script>`;
  const srcdoc = `${beforeJs}${escapeEndTag(js, 'script')}</script></body></html>`;

  const regions = [
    region('js', beforeJs, js),
    region('html', beforeHtml, html),
  ];

  /** Document line and column → { file, line, column } in your code, or null. */
  function locate(line, column) {
    for (const r of regions) {
      if (line >= r.start && line <= r.end) {
        const local = line - r.start + 1;
        return { file: r.file, line: local, column: local === 1 ? Math.max(1, column - r.firstColumn) : column };
      }
    }
    return null;
  }

  return { srcdoc, locate };
}

/** Where a piece of code starts and ends inside the document. */
function region(file, before, code) {
  const start = countNewlines(before) + 1;
  return {
    file,
    start,
    end: start + countNewlines(code),
    // Characters that come before the code on its first line
    firstColumn: before.length - before.lastIndexOf('\n') - 1,
  };
}
