import { escapeHtml } from '../lib/html.js';
import { dayLabel } from '../lib/hebrew.js';

/**
 * A signed consent is one self-contained HTML file with the signature embedded
 * as a data URI. Deliberately not a PDF: Hebrew right-to-left text in a
 * generated PDF needs an embedded font and manual bidi handling, while a
 * browser renders this correctly and prints to PDF on demand.
 *
 * Self-contained is the whole point. No stylesheet to fetch, no logo URL to
 * resolve, no font from a CDN. This file has to render identically in seven
 * years, on a machine that cannot reach this service, in front of someone who
 * is deciding whether a parent agreed to something.
 */

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_SIGNATURE_BYTES = 300 * 1024;
const BASE64 = /^[A-Za-z0-9+/=]+$/;
const SAFE_ID = /^[A-Z0-9][A-Z0-9-]{0,63}$/;

export function assertSafeOrderId(orderId) {
  if (!SAFE_ID.test(String(orderId ?? ''))) throw new Error(`מזהה הזמנה לא תקין: ${orderId}`);
  return String(orderId);
}

/** Decode and sanity-check the signature the canvas produced. */
export function parseSignature(dataUrl) {
  const value = String(dataUrl ?? '');
  if (!value.startsWith(PNG_PREFIX)) throw new Error('החתימה חייבת להיות תמונת PNG');
  const base64 = value.slice(PNG_PREFIX.length);
  if (!base64 || !BASE64.test(base64)) throw new Error('החתימה פגומה');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('החתימה ריקה');
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new Error('החתימה גדולה מדי');
  // PNG magic number, so a renamed payload cannot be stored as an image.
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!magic.every((byte, i) => bytes[i] === byte)) throw new Error('החתימה אינה קובץ PNG תקין');
  // Re-encoded from the decoded bytes, not passed through: whatever whitespace
  // or padding variation arrived, what gets archived is canonical base64 of
  // bytes this function has actually inspected.
  return { bytes, dataUrl: PNG_PREFIX + bytes.toString('base64') };
}

/**
 * The shared style for every signed document. One stylesheet so a consent and
 * a contract cannot drift apart visually, and inline so an archived file still
 * renders years later with nothing to fetch.
 *
 * Note what is not here: the tenant's colours. A signed document is evidence,
 * not marketing, and the business name in its heading is identification
 * enough. Branding that changes would also make two documents signed under the
 * same terms look like different documents.
 */
export const DOCUMENT_STYLE = `
  body { font-family: -apple-system, "Segoe UI", Rubik, Arial, sans-serif; max-width: 760px;
         margin: 0 auto; padding: 32px 20px 64px; color: #14181f; background: #fff; line-height: 1.65; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #e3e6ea; }
  h3 { font-size: 1rem; margin: 12px 0 4px; }
  .sub { color: #5b6472; margin: 0 0 24px; font-size: .9rem; }
  dl { margin: 0; }
  .field { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dotted #e8eaee; }
  dt { font-weight: 600; min-width: 150px; margin: 0; }
  dd { margin: 0; }
  ul { margin: 6px 0; padding-inline-start: 22px; }
  .days li { display: inline-block; margin-inline-end: 14px; }
  .child { background: #f7f8fa; border-radius: 10px; padding: 10px 16px; margin: 10px 0; }
  .declared { background: #f0f7f0; border-inline-start: 4px solid #3f8f4f; padding: 12px 16px;
              margin: 12px 0; border-radius: 6px; }
  .declined { background: #faf6f0; border-inline-start: 4px solid #b98a3c; padding: 12px 16px;
              margin: 12px 0; border-radius: 6px; }
  .sig { margin-top: 10px; border: 1px solid #d8dce2; border-radius: 10px; padding: 10px;
         display: inline-block; background: #fff; }
  .sig img { display: block; max-width: 320px; height: auto; }
  .evidence { margin-top: 36px; font-size: .78rem; color: #6b7480; border-top: 1px solid #e3e6ea;
              padding-top: 12px; }
  .evidence code { background: #f2f4f7; padding: 1px 5px; border-radius: 4px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
`;

/** A "label: value" row, omitted entirely when there is no value. */
export function documentField(label, value) {
  return value
    ? `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    : '';
}

/**
 * The frame every signed document shares: title, sections, the declaration the
 * signer confirmed, the signature itself, and the evidence block.
 * `sectionsHtml` is the only part that differs between a consent and a
 * contract, which is what keeps the two from growing separate renderers.
 */
export function renderSignedDocument({
  docTitle, heading, subtitle, sectionsHtml, declaration,
  signatureDataUrl, signatureAlt = 'חתימה', signedAt, evidence = {},
}) {
  const versionLabel = evidence.versionLabel ?? 'גרסת התנאים';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle)}</title>
<style>${DOCUMENT_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
${sectionsHtml}

<h2>חתימה</h2>
<p>${escapeHtml(declaration)}</p>
<div class="sig"><img src="${signatureDataUrl}" alt="${escapeHtml(signatureAlt)}"></div>

<div class="evidence">
  <p><strong>פרטי אימות</strong>, נשמרו אוטומטית בזמן החתימה ואינם ניתנים לשינוי:</p>
  <p>
    ${escapeHtml(versionLabel)}: <code>${escapeHtml(evidence.version)}</code> ·
    חתימה: <code>${escapeHtml(signedAt)}</code> ·
    כתובת IP: <code>${escapeHtml(evidence.ip ?? '')}</code>
  </p>
  <p>דפדפן: <code>${escapeHtml((evidence.userAgent ?? '').slice(0, 200))}</code></p>
</div>
</body>
</html>`;
}

/** Format a signing timestamp the way every document prints it. */
export function signedStamp(signedAt, timezone = 'Asia/Jerusalem') {
  return new Date(signedAt).toLocaleString('he-IL', { timeZone: timezone });
}

/** The camp registration form: the sections, wrapped in the shared frame. */
export function renderConsentDocument({
  camp, orderId, signer, children, answers, signatureDataUrl, signedAt, meta,
}) {
  const stamp = signedStamp(signedAt, camp.timezone ?? 'Asia/Jerusalem');

  const childBlocks = children.map((child) => {
    const days = child.days.map((d) => `<li>${escapeHtml(dayLabel(d))}</li>`).join('');
    return `<section class="child">
      <h3>${escapeHtml(child.childName)}${child.childGrade ? ` · ${escapeHtml(child.childGrade)}` : ''}</h3>
      <ul class="days">${days}</ul>
    </section>`;
  }).join('');

  const terms = (camp.consent.terms ?? []).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  const field = documentField;

  const sectionsHtml = `<h2>פרטי ההורה</h2>
<dl>
  ${field('שם מלא', signer.name)}
  ${field('מספר זהות', signer.idNumber)}
  ${field('טלפון', signer.phone)}
  ${field('דוא"ל', signer.email)}
</dl>

<h2>הילדים והימים</h2>
${childBlocks}

<h2>פרטים רפואיים ואיסוף</h2>
<dl>
  ${field(camp.consent.allergiesPrompt ?? 'רגישויות ואלרגיות', answers.allergies || 'לא דווח')}
  ${field(camp.consent.pickupPrompt ?? 'מורשים לאיסוף', answers.pickup || 'לא צוין')}
</dl>

<h2>הצהרת בריאות</h2>
<div class="declared">
  <p>${escapeHtml(camp.consent.healthDeclaration ?? '')}</p>
  <p><strong>✓ ההורה אישר/ה את ההצהרה.</strong></p>
</div>

<h2>תנאי ההרשמה</h2>
<ul>${terms}</ul>
<p><strong>מדיניות ביטול:</strong> ${escapeHtml(camp.cancellationPolicy ?? '')}</p>

<h2>צילום ופרסום</h2>
<div class="${answers.photoConsent ? 'declared' : 'declined'}">
  <p>${escapeHtml(camp.consent.photoConsent ?? '')}</p>
  <p><strong>${answers.photoConsent
    ? '✓ ההורה אישר/ה צילום ופרסום.'
    : '✗ ההורה לא אישר/ה צילום ופרסום.'}</strong></p>
</div>`;

  return renderSignedDocument({
    docTitle: `טופס הרשמה חתום · ${orderId}`,
    heading: `${camp.campName}: טופס הרשמה והצהרת בריאות`,
    subtitle: `אסמכתא ${orderId} · נחתם ${stamp}`,
    sectionsHtml,
    declaration: `אני, ${signer.name}, קראתי את כל האמור לעיל ומאשר/ת אותו בחתימתי:`,
    signatureDataUrl,
    signatureAlt: 'חתימת ההורה',
    signedAt,
    evidence: {
      versionLabel: 'גרסת התנאים',
      version: camp.termsVersion,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });
}

export const _internals = { PNG_PREFIX, MAX_SIGNATURE_BYTES, SAFE_ID };
