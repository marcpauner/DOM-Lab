import { escapeEndTag } from '../preview/srcdoc.js';

/**
 * Your code as one standalone HTML file, ready to open in any browser:
 * the CSS in a <style> in <head>, the JS in a <script> at the end of <body>
 * (exactly where DOM Lab puts them, so it behaves the same).
 */
export function buildDocument({ html, css, js }, title = 'DOM Lab project') {
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title.replace(/[<&]/g, (char) => (char === '<' ? '&lt;' : '&amp;'))}</title>`,
  ];
  if (css.trim()) lines.push('<style>', escapeEndTag(css.trimEnd(), 'style'), '</style>');
  lines.push('</head>', '<body>', html.trimEnd());
  if (js.trim()) lines.push('<script>', escapeEndTag(js.trimEnd(), 'script'), '</script>');
  lines.push('</body>', '</html>', '');
  return lines.join('\n');
}

/**
 * Downloads some text as a file. A Blob is a "file in memory"; createObjectURL
 * gives it a temporary blob: URL, and a link with the download attribute saves
 * it instead of opening it.
 */
export function download(filename, text, type = 'text/html') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
