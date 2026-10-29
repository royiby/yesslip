import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSignature, renderConsentDocument, assertSafeOrderId, signedStamp,
} from '../src/consent/document.js';
import { archiveConsent, readConsentDocument, AlreadySignedError } from '../src/consent/archive.js';
import { makeMemoryObjectStore } from '../src/storage/objects.js';
import { decoratedSampleCamp, SIGNATURE_PNG, longSignature } from './_helpers.js';

const camp = await decoratedSampleCamp();
const TENANT = '3f4b2c10-0000-4000-8000-000000000001';

const signer = {
  name: 'דנה כהן',
  idNumber: '123456782',
  phone: '0501234567',
  email: 'dana@example.com',
};
const children = [
  { childName: 'יובל כהן', childGrade: "ב'", weekId: 'w1', days: ['2030-07-01', '2030-07-02'] },
];
const answers = {
  healthDeclaration: true,
  terms: true,
  photoConsent: false,
  allergies: 'אלרגיה לבוטנים',
  pickup: 'סבתא רחל',
};
const meta = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone)' };

test('a signature must be a real PNG, not a renamed payload', () => {
  assert.throws(() => parseSignature('data:image/jpeg;base64,abcd'), /PNG/);
  assert.throws(() => parseSignature('data:image/png;base64,'), /פגומה|ריקה/);
  assert.throws(() => parseSignature('data:image/png;base64,!!!!'), /פגומה/);
  // Valid base64 of something that is not a PNG: the magic number catches it.
  const notPng = `data:image/png;base64,${Buffer.from('GIF89a and then some').toString('base64')}`;
  assert.throws(() => parseSignature(notPng), /אינה קובץ PNG תקין/);
  assert.throws(() => parseSignature(null), /PNG/);
});

test('an oversized signature is refused', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(400 * 1024),
  ]);
  const big = `data:image/png;base64,${png.toString('base64')}`;
  assert.throws(() => parseSignature(big), /גדולה מדי/);
});

test('a signature is re-encoded from the bytes, not passed through', () => {
  // Whatever padding or whitespace variation arrived, what gets archived is
  // canonical base64 of bytes this code has actually inspected.
  const parsed = parseSignature(SIGNATURE_PNG);
  assert.ok(parsed.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(parseSignature(parsed.dataUrl).dataUrl, parsed.dataUrl);
  assert.equal(parsed.bytes[0], 0x89);
});

test('an order id is restricted to what can safely be a filename and a URL', () => {
  assert.equal(assertSafeOrderId('AB12CD34'), 'AB12CD34');
  for (const bad of ['../x', 'ab12cd34', 'A B', '', 'A/B', null, 'A'.repeat(70)]) {
    assert.throws(() => assertSafeOrderId(bad), /מזהה הזמנה לא תקין/, `accepted ${bad}`);
  }
});

test('the document records the terms version, the IP and the exact wording', () => {
  const html = renderConsentDocument({
    camp, orderId: 'AB12CD34', signer, children, answers,
    signatureDataUrl: parseSignature(SIGNATURE_PNG).dataUrl,
    signedAt: '2030-06-01T09:00:00.000Z',
    meta,
  });
  assert.match(html, new RegExp(camp.termsVersion));
  assert.match(html, /203\.0\.113\.9/);
  assert.match(html, /אני מצהיר\/ה שהילד\/ה בריא\/ה/);
  assert.match(html, /סעיף ראשון/);
  assert.match(html, /אלרגיה לבוטנים/);
  assert.match(html, /סבתא רחל/);
  assert.match(html, /123456782/);
  // The declined photo consent must be visible as declined, not merely absent.
  assert.match(html, /ההורה לא אישר\/ה צילום ופרסום/);
  // Self-contained: nothing to fetch for it to render in seven years.
  assert.doesNotMatch(html, /<link|<script|src="http/);
  assert.match(html, /dir="rtl"/);
});

test('the document escapes what the parent typed', () => {
  const html = renderConsentDocument({
    camp,
    orderId: 'AB12CD34',
    signer: { ...signer, name: '<script>alert(1)</script>' },
    children,
    answers: { ...answers, allergies: '"><img onerror=alert(1) src=x>' },
    signatureDataUrl: parseSignature(SIGNATURE_PNG).dataUrl,
    signedAt: '2030-06-01T09:00:00.000Z',
    meta,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img onerror/);
  assert.match(html, /&lt;script&gt;/);
});

test('the timestamp is printed in the business timezone, not the server one', () => {
  // Same instant, two zones: a business in Jerusalem must not read its own
  // signing times in UTC because the server happens to run there.
  const instant = '2030-06-01T21:30:00.000Z';
  assert.notEqual(signedStamp(instant, 'Asia/Jerusalem'), signedStamp(instant, 'UTC'));
  assert.match(signedStamp(instant, 'Asia/Jerusalem'), /2\.6\.2030|2\.6\.30/);
});

test('archiving writes the document under a tenant-scoped key', async () => {
  const store = makeMemoryObjectStore();
  const result = await archiveConsent({
    tenantId: TENANT, camp, orderId: 'AB12CD34',
    signer, children, answers, signature: longSignature(), meta, store,
  });
  assert.equal(result.archiveKey, `t/${TENANT}/consent/AB12CD34.html`);
  assert.equal(result.consent.termsVersion, camp.termsVersion);
  assert.deepEqual(result.consent.children, ['יובל כהן']);
  assert.equal(result.consent.photoConsent, false);

  const html = await readConsentDocument(result.archiveKey, { store });
  assert.match(html, /דנה כהן/);
});

test('the stored object carries the terms version as metadata', async () => {
  // So the bucket alone answers "which version did this one agree to", without
  // the database. A retention sweep and an audit both need that.
  const store = makeMemoryObjectStore();
  const { archiveKey } = await archiveConsent({
    tenantId: TENANT, camp, orderId: 'AB12CD35',
    signer, children, answers, signature: longSignature(), meta, store,
  });
  const head = await store.head(archiveKey);
  assert.equal(head.metadata['terms-version'], camp.termsVersion);
  assert.equal(head.metadata.tenant, TENANT);
  assert.equal(head.metadata.order, 'AB12CD35');
});

test('signing the same order twice is refused, not silently overwritten', async () => {
  const store = makeMemoryObjectStore();
  const once = {
    tenantId: TENANT, camp, orderId: 'AB12CD36',
    signer, children, answers, signature: longSignature(), meta, store,
  };
  await archiveConsent(once);
  await assert.rejects(
    () => archiveConsent({ ...once, signer: { ...signer, name: 'מישהו אחר' } }),
    AlreadySignedError,
  );
  const html = await readConsentDocument(`t/${TENANT}/consent/AB12CD36.html`, { store });
  assert.match(html, /דנה כהן/);
  assert.doesNotMatch(html, /מישהו אחר/);
});

test('two tenants signing the same order id do not collide', async () => {
  // Order ids are per tenant and short, so the same one will come up twice
  // across businesses. The key prefix is what keeps them apart.
  const store = makeMemoryObjectStore();
  const other = '3f4b2c10-0000-4000-8000-000000000002';
  await archiveConsent({
    tenantId: TENANT, camp, orderId: 'SAMEID01',
    signer, children, answers, signature: longSignature(), meta, store,
  });
  const second = await archiveConsent({
    tenantId: other, camp, orderId: 'SAMEID01',
    signer: { ...signer, name: 'הורה אחר' },
    children, answers, signature: longSignature(), meta, store,
  });
  assert.equal(second.archiveKey, `t/${other}/consent/SAMEID01.html`);
  assert.match(await readConsentDocument(`t/${TENANT}/consent/SAMEID01.html`, { store }), /דנה כהן/);
  assert.match(await readConsentDocument(second.archiveKey, { store }), /הורה אחר/);
});

test('reading with no key returns null rather than reaching the store', async () => {
  assert.equal(await readConsentDocument(null), null);
  assert.equal(await readConsentDocument(''), null);
});
