/*
 * Sharing through the URL: the code travels INSIDE the link, after the #.
 * The part after # (the "fragment") is never sent to any server, so nothing
 * is uploaded anywhere: whoever opens the link decodes it in their browser.
 *
 *   { html, css, js } → JSON → deflate (CompressionStream) → base64url → #code=…
 */

export const SHARE_PREFIX = '#code=';
const MAX_DECODED = 2_000_000; // bytes: a malicious link cannot make us decompress gigabytes
const MAX_FIELD = 500_000; // characters per language

/** base64 uses + / =, which have special meanings in URLs; base64url uses - _ and drops the = */
function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Compresses the code into the text that goes after #code= */
export async function encodeCode({ html, css, js }) {
  const json = JSON.stringify({ v: 1, html, css, js });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** The opposite of encodeCode. Throws if the text is not a valid shared project. */
export async function decodeCode(text) {
  const stream = new Blob([fromBase64Url(text)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  // Read it piece by piece and stop if it grows too much ("zip bomb")
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DECODED) {
      await reader.cancel();
      throw new Error('The shared code is too big.');
    }
    chunks.push(value);
  }
  const data = JSON.parse(await new Blob(chunks).text());
  // The link may come from anyone: check its shape before using it
  const field = (value) => (typeof value === 'string' ? value.slice(0, MAX_FIELD) : '');
  if (data === null || typeof data !== 'object' || data.v !== 1) throw new Error('This link is not a DOM Lab project.');
  return { html: field(data.html), css: field(data.css), js: field(data.js) };
}

/** The full link for some code: this same page with #code=… */
export async function shareUrl(code) {
  const url = new URL(location.href);
  url.hash = SHARE_PREFIX.slice(1) + (await encodeCode(code));
  return url.href;
}

/** The code in the current URL, if there is one. */
export async function readSharedCode() {
  if (!location.hash.startsWith(SHARE_PREFIX)) return null;
  return decodeCode(location.hash.slice(SHARE_PREFIX.length));
}
