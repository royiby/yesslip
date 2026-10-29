/** Shared HTML helpers. Every parent-facing page is server-rendered, so
 *  escaping has to be boringly available everywhere. */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// U+2028 / U+2029 are legal in JSON but terminate a line in JavaScript.
const SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

/** Safe to drop inside a <script> block: escapes the sequences that could end
 *  it and the two line separators that are valid JSON but invalid JavaScript. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(SEPARATORS, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

/**
 * A hex colour is interpolated straight into a stylesheet, which makes it an
 * injection site. The tenant store validates on the way in; this validates on
 * the way out too, because a page is rendered from whatever the database holds
 * and a column that was written before the check existed is still a column.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

export function safeColor(value, fallback) {
  return HEX.test(String(value ?? '')) ? String(value) : fallback;
}

/** The small centred card used by the confirmation and error pages. Takes the
 *  tenant's primary colour so a parent does not land on a stranger's page. */
export function cardPage(title, bodyHtml, { brand = '#2563eb' } = {}) {
  const accent = safeColor(brand, '#2563eb');
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --brand: ${accent}; }
  body { font-family: -apple-system, "Segoe UI", Rubik, Arial, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center;
         background: #f6f7f9; color: #14181f; padding: 24px; }
  @media (prefers-color-scheme: dark) {
    body { background: #14181f; color: #f1f3f6; } .card { background: #1d232c; }
  }
  .card { background: #fff; border-radius: 18px; padding: 32px 28px; max-width: 420px;
          width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 16px; }
  p { line-height: 1.6; margin: 10px 0; }
  a { color: var(--brand); }
  .muted { opacity: .6; font-size: .85rem; }
</style>
</head>
<body><main class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body>
</html>`;
}
