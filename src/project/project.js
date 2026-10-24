import { readPref, writePref } from '../lib/storage.js';
import { readSharedCode } from './share.js';
import { TEMPLATES } from '../examples/templates.js';

/*
 * The project is the code in the three editors: { html, css, js }.
 * It is saved in localStorage as you type, so reloading the page (or coming
 * back tomorrow) brings it back. localStorage only lives in this browser:
 * to take your code somewhere else, export it or share a link.
 */

const isCode = (value) =>
  value !== null && typeof value === 'object' && ['html', 'css', 'js'].every((key) => typeof value[key] === 'string');

export const sameCode = (a, b) => a.html === b.html && a.css === b.css && a.js === b.js;

export function saveCode(code) {
  writePref('code', { html: code.html, css: code.css, js: code.js, savedAt: Date.now() });
}

/** The code you had before opening a shared link or a template, kept just in case. */
export function readBackup() {
  const backup = readPref('code-backup', null);
  return isCode(backup) ? backup : null;
}

export function saveBackup(code) {
  writePref('code-backup', { html: code.html, css: code.css, js: code.js });
}

/**
 * Code that came from a shared link has JavaScript written by someone else.
 * It stays "not reviewed" (and does not run by itself, not even after a
 * reload) until you press Run once.
 */
export const isJsReviewed = () => readPref('js-reviewed', true) !== false;
export const markJsReviewed = (reviewed) => writePref('js-reviewed', reviewed);

/**
 * Which code to open:
 *   1. a shared link (#code=…) wins, and your saved code is kept as a backup;
 *   2. otherwise, the code saved in this browser;
 *   3. otherwise, the first template.
 * @returns {Promise<{ code: object, source: 'shared'|'saved'|'template', error?: string, backedUp?: boolean }>}
 */
export async function loadInitialProject() {
  const saved = readPref('code', null);
  const savedCode = isCode(saved) ? saved : null;
  try {
    const shared = await readSharedCode();
    if (shared) {
      // Remove the #code=… so that reloading shows your latest edits, not the original link
      history.replaceState(null, '', location.pathname + location.search);
      // A link with the code you already have here is just a normal visit
      if (savedCode && sameCode(savedCode, shared)) return { code: savedCode, source: 'saved' };
      if (savedCode) saveBackup(savedCode);
      saveCode(shared);
      markJsReviewed(false);
      return { code: shared, source: 'shared', backedUp: Boolean(savedCode) };
    }
  } catch (error) {
    history.replaceState(null, '', location.pathname + location.search);
    return { code: savedCode ?? TEMPLATES[0], source: savedCode ? 'saved' : 'template', error: error.message };
  }
  return savedCode ? { code: savedCode, source: 'saved' } : { code: TEMPLATES[0], source: 'template' };
}
