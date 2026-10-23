import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { editorTheme } from './cmTheme.js';
import './editor.css';

export const LANGUAGES = [
  { id: 'html', label: 'HTML', support: html },
  { id: 'css', label: 'CSS', support: css },
  { id: 'js', label: 'JavaScript', support: javascript },
];

// The floating header covers the top of the editor: tell CodeMirror so it
// does not leave the cursor hidden underneath while scrolling.
const headerMargin = EditorView.scrollMargins.of(() => ({ top: 50 }));

/**
 * Creates one CodeMirror editor per language. Only one is visible at a
 * time, but all three stay alive: each keeps its own undo history.
 */
export function createEditors(host, { initial, onChange }) {
  const views = new Map();

  for (const lang of LANGUAGES) {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial[lang.id] ?? '',
        extensions: [
          basicSetup,
          // Tab indents (to leave the editor with the keyboard: Esc, then Tab)
          keymap.of([indentWithTab]),
          lang.support(),
          editorTheme,
          headerMargin,
          EditorView.contentAttributes.of({ 'aria-label': `${lang.label} code` }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(lang.id);
          }),
        ],
      }),
    });
    view.dom.hidden = true;
    views.set(lang.id, view);
  }

  let active = null;

  return {
    getValue: (id) => views.get(id).state.doc.toString(),

    /** All the code: { html, css, js } */
    getCode: () => Object.fromEntries(LANGUAGES.map((lang) => [lang.id, views.get(lang.id).state.doc.toString()])),

    /** Replaces the code of every editor. It is a normal change: Ctrl+Z in an editor undoes it. */
    setCode(code) {
      for (const lang of LANGUAGES) {
        const view = views.get(lang.id);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code[lang.id] ?? '' } });
      }
    },

    show(id) {
      if (active === id) return;
      for (const [key, view] of views) view.dom.hidden = key !== id;
      active = id;
      // It was hidden (zero size): let it measure its space again
      views.get(id).requestMeasure();
    },

    focus: (id) => views.get(id).focus(),

    /** Moves the cursor to a line and column (1-based) and centers it on screen. */
    goTo(id, line, column = 1) {
      const view = views.get(id);
      const { doc } = view.state;
      const target = doc.line(Math.min(Math.max(1, line), doc.lines));
      const pos = target.from + Math.min(Math.max(0, column - 1), target.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
  };
}
