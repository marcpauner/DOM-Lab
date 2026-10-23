import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Every color is a CSS variable (styles/tokens.css): when switching between
// light and dark mode the editor updates by itself, without reconfiguring it.

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--code-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65',
    // Room for the translucent header that floats above the code
    paddingTop: 'calc(var(--panel-header-h) + 6px)',
    paddingBottom: '24px',
  },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    paddingLeft: '6px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--editor-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
    borderRadius: '3px',
  },
  '.cm-foldPlaceholder': {
    border: 'none',
    borderRadius: '4px',
    backgroundColor: 'var(--fill)',
    color: 'var(--text-2)',
    padding: '0 6px',
  },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-3)' },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: '10px',
    backgroundColor: 'var(--glass-strong)',
    backdropFilter: 'var(--blur)',
    boxShadow: 'var(--shadow-float)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', padding: '4px' },
  '.cm-tooltip-autocomplete > ul > li': { borderRadius: '6px', padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },
  '.cm-completionDetail': { color: 'var(--text-2)', fontStyle: 'normal' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-sunken)',
    color: 'var(--text)',
    borderColor: 'var(--separator) !important',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--yellow) 35%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--orange) 45%, transparent)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.tagName, color: 'var(--syn-tag)' },
  { tag: t.angleBracket, color: 'var(--text-3)' },
  { tag: t.attributeName, color: 'var(--syn-attr)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.className, t.typeName, t.namespace, t.labelName], color: 'var(--syn-type)' },
  { tag: [t.regexp, t.escape, t.color], color: 'var(--syn-meta)' },
  { tag: [t.meta, t.documentMeta, t.processingInstruction], color: 'var(--syn-meta)' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--text-2)' },
  { tag: t.invalid, color: 'var(--red)' },
]);

export const editorTheme = [theme, syntaxHighlighting(highlight)];
