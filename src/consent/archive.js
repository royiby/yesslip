import { objectStore, documentKey } from '../storage/objects.js';
import { log } from '../lib/logger.js';
import { assertSafeOrderId, parseSignature, renderConsentDocument } from './document.js';

/**
 * Render a signed consent and put it in object storage, write-once.
 *
 * Deliberately does not touch the database. The evidence row is written in the
 * same transaction as the registrations it belongs to (see
 * src/store/registrations.js), and splitting the document write out is what
 * lets that transaction stay short: no third-party network call is held open
 * inside it, and no advisory lock is held while a bucket decides to be slow.
 *
 * The cost of the split is an orphan document when the transaction afterwards
 * rolls back, for example because the last seat went while the parent was
 * signing. That is the right way round. An orphan document is collected by the
 * retention sweep and harms nobody; a registration whose document failed to
 * write is a business holding money for a form that does not exist.
 */
export class AlreadySignedError extends Error {
  constructor(orderId) {
    super(`כבר קיים טופס חתום עבור ${orderId}`);
    this.name = 'AlreadySignedError';
    this.code = 'ALREADY_SIGNED';
  }
}

export async function archiveConsent({
  tenantId, camp, orderId, signer, children, answers, signature, meta, store = objectStore(),
}) {
  assertSafeOrderId(orderId);
  const signedAt = new Date().toISOString();
  const parsed = parseSignature(signature);

  const html = renderConsentDocument({
    camp, orderId, signer, children, answers,
    signatureDataUrl: parsed.dataUrl,
    signedAt,
    meta,
  });

  const key = documentKey(tenantId, 'consent', orderId);
  const result = await store.putOnce(key, html, {
    contentType: 'text/html; charset=utf-8',
    metadata: {
      tenant: String(tenantId),
      order: orderId,
      'terms-version': camp.termsVersion,
      'signed-at': signedAt,
    },
  });
  if (!result.written) throw new AlreadySignedError(orderId);

  log.info('consent.archived', {
    tenantId, orderId, termsVersion: camp.termsVersion,
    bytes: parsed.bytes.length, store: store.kind,
  });

  return {
    archiveKey: key,
    signedAt,
    consent: {
      signedAt,
      signerName: signer.name,
      signerId: signer.idNumber,
      phone: signer.phone,
      email: signer.email,
      children: children.map((c) => c.childName),
      termsVersion: camp.termsVersion,
      healthDeclaration: answers.healthDeclaration,
      photoConsent: answers.photoConsent,
      ip: meta.ip,
      userAgent: meta.userAgent,
      archiveKey: key,
    },
  };
}

/**
 * The archived document's bytes, or null. Reads through the key recorded on the
 * consent row, which row-level security already scoped to one tenant, so a
 * guessed order id from another business resolves to no row and therefore to no
 * key, rather than to a document.
 */
export async function readConsentDocument(archiveKey, { store = null } = {}) {
  // The key is checked before the store is resolved, so a consent row whose
  // document has already been destroyed does not touch object storage at all.
  if (!archiveKey) return null;
  const bytes = await (store ?? objectStore()).get(archiveKey);
  return bytes ? bytes.toString('utf8') : null;
}
