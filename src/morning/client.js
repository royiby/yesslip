/**
 * A Morning client, bound to ONE tenant's credentials.
 *
 * This is a factory, not a module of functions, and that is the whole point.
 * The single-tenant original kept its access token in a module-level
 * `let cachedToken`, which in a multi-tenant process means tenant A's token
 * answers tenant B's call: one business reading another's invoices, silently,
 * with every response looking perfectly valid. A per-tenant cache is not a
 * mitigation of that bug, it removes the shared thing that makes it possible.
 *
 * So: no module-level mutable state in this file. If you are about to add a
 * `let` out here, you are re-introducing the bug.
 *
 * Morning's token lives on a dedicated auth host and is valid for about an
 * hour; the resource API lives on a different host. See developers.morning.co.
 */

const HOSTS = {
  sandbox: { auth: 'https://api.sandbox.morning.dev', api: 'https://sandbox.d.greeninvoice.co.il/api/v1' },
  production: { auth: 'https://api.morning.co', api: 'https://api.greeninvoice.co.il/api/v1' },
};

export function createMorningClient({
  tenantId,
  keyId,
  keySecret,
  environment = 'production',
  pluginId = null,
  documentType = 320,
  // Injectable so that tests can prove behaviour without reaching the real
  // API. Production never passes it.
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  if (!keyId || !keySecret) throw new Error('a Morning client needs a key id and secret');
  const hosts = HOSTS[environment];
  if (!hosts) throw new Error(`unknown Morning environment: ${environment}`);

  // In the closure, not the module. One cache per client, and a client belongs
  // to one tenant.
  let cachedToken = null; // { accessToken, expiresAtMs }

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) return cachedToken.accessToken;

    const response = await fetchImpl(`${hosts.auth}/idp/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: keyId,
        client_secret: keySecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `אימות מול מורנינג נכשל (${response.status}): ${text.slice(0, 300)}\n` +
        `בדקו את מפתח ה-API של מורנינג ושסביבת העבודה (${environment}) תואמת למפתח.`,
      );
    }

    const body = JSON.parse(text);
    const token = body.accessToken ?? body.access_token;
    if (!token) throw new Error(`מורנינג לא החזירה access token: ${text.slice(0, 300)}`);

    // `expiresAt` is an absolute epoch; `expires_in` is relative. Support both.
    const expiresAtMs = body.expiresAt
      ? Number(body.expiresAt) * (String(body.expiresAt).length > 11 ? 1 : 1000)
      : Date.now() + Number(body.expires_in ?? 3600) * 1000;

    cachedToken = { accessToken: token, expiresAtMs };
    log('morning.token_refreshed', { tenantId, env: environment });
    return token;
  }

  async function api(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${hosts.api}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const token = await accessToken();
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    const text = await response.text();
    if (response.status === 401) cachedToken = null; // rejected: refresh next call
    if (!response.ok) {
      throw new Error(`מורנינג ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // ──────────────────── account and setup ────────────────────

  async function businessInfo() {
    return api('/businesses/me');
  }

  /** Document-type metadata, including the available payment plugins (the Grow clearing UUID). */
  async function documentTypeInfo(type = documentType) {
    return api('/documents/info', { query: { type } });
  }

  async function listPaymentPlugins(type = documentType) {
    const info = await documentTypeInfo(type);
    return info?.paymentPlugins ?? [];
  }

  /**
   * The onboarding gate. These two calls together prove three separate things:
   * the key works, the plan actually includes API access, and a clearing is
   * connected. A tenant who gets past signup without this discovers the third
   * one when forty parents cannot pay.
   */
  async function verifyConnection() {
    const business = await businessInfo();
    const plugins = await listPaymentPlugins();
    const plugin = plugins[0] ?? null;
    if (!plugin?.id) {
      return {
        ok: false,
        business,
        pluginId: null,
        problem: 'לא הוגדרה סליקה בחשבון מורנינג לסוג המסמך הזה. הפעילו את Grow בהגדרות החשבון.',
      };
    }
    return { ok: true, business, pluginId: plugin.id, pluginName: plugin.name ?? null, problem: null };
  }

  // ──────────────────── one-off payments ────────────────────

  /**
   * Create a hosted Grow checkout link. On a successful payment Morning issues
   * the configured document (320 = tax invoice + receipt) by itself, POSTs the
   * document to `notifyUrl` form-urlencoded, and echoes `custom` back there as
   * `external_data` -- that is how a payment gets matched to an order.
   *
   * notifyUrl is per request, not per account, which is what makes this work
   * for many tenants in one process: each tenant's forms point at that
   * tenant's webhook path, with that tenant's own secret.
   */
  async function createPaymentForm({
    description, amount, currency = 'ILS', client: clientDetails, income, custom,
    successUrl, failureUrl, notifyUrl, lang = 'he', group = 100, maxPayments = 1,
  }) {
    if (!pluginId) {
      throw new Error('אין סליקה מוגדרת לחשבון המורנינג הזה: אי אפשר ליצור קישור תשלום');
    }

    const payload = {
      type: documentType,
      description,
      amount,
      currency,
      vatType: income?.[0]?.vatType ?? 1,
      lang,
      pluginId,
      group,
      maxPayments,
      client: clientDetails,
      income,
    };
    if (successUrl) payload.successUrl = successUrl;
    if (failureUrl) payload.failureUrl = failureUrl;
    if (notifyUrl) payload.notifyUrl = notifyUrl;
    if (custom) payload.custom = custom;

    const result = await api('/payments/form', { method: 'POST', body: payload });

    // Field naming has drifted across Morning API versions; accept the variants.
    const url = result?.url ?? result?.paymentUrl ?? result?.payment_form_url ?? result?.form?.url;
    if (!url) {
      throw new Error(`מורנינג לא החזירה כתובת תשלום. תשובה: ${JSON.stringify(result).slice(0, 500)}`);
    }
    return { url, id: result?.id ?? result?.linkId ?? null, raw: result };
  }

  /** Re-read a payment link so a webhook claim can be checked against Morning itself. */
  async function getPaymentLink(linkId) {
    return api(`/payments/links/${encodeURIComponent(linkId)}`);
  }

  /**
   * Every document Morning issued in a date range. This is the other half of
   * the payment story: the webhook tells us about a payment that arrived, and
   * this tells us about the ones that did not.
   *
   * Paged, because the endpoint is and because a season can be a few hundred
   * documents. `pageSize` is capped by Morning at 100.
   */
  async function searchDocuments({ fromDate, toDate, types, pageSize = 100, maxPages = 20 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = { page, pageSize, fromDate, toDate, sort: 'documentDate', descending: true };
      if (types?.length) body.type = types;
      const result = await api('/documents/search', { method: 'POST', body });

      // The field has been `items` for as long as this account has existed, but
      // the shape has drifted elsewhere in this API, so accept the alternatives
      // rather than silently reconciling against an empty list, which would
      // report every paid order as missing from Morning.
      const batch = result?.items ?? result?.rows ?? result?.data ?? [];
      if (!Array.isArray(batch)) {
        throw new Error(`מורנינג החזירה חיפוש מסמכים בצורה לא מוכרת: ${JSON.stringify(result).slice(0, 300)}`);
      }
      items.push(...batch);

      const total = Number(result?.total ?? result?.totalCount ?? NaN);
      if (batch.length < pageSize) break;
      if (Number.isFinite(total) && items.length >= total) break;
    }
    return items;
  }

  async function getDocument(id) {
    return api(`/documents/${encodeURIComponent(id)}`);
  }

  /**
   * The clearing transaction behind a payment. Undocumented but stable, and the
   * only way to see whether a refund actually landed: `status` moves 20 -> 30
   * and `cancellable` becomes false.
   */
  async function getTransaction(transactionId) {
    return api(`/payments/transactions/${encodeURIComponent(transactionId)}`);
  }

  /**
   * Refund a card charge. Verified against production on 26 Oct 2026 with a
   * real ILS 1 refund.
   *
   * Morning issues the credit note (type 330) and the negative receipt (type
   * 400) by itself as part of this call. Do NOT create a 330 alongside it, or
   * the books carry two credits for one cancellation and the VAT reported is
   * wrong. That is the whole reason this function does not touch /documents.
   */
  async function refundTransaction(transactionId, { amount } = {}) {
    if (!transactionId) throw new Error('חסר מזהה עסקה להחזר');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('סכום ההחזר חייב להיות מספר גדול מאפס');

    const result = await api(`/payments/transactions/${encodeURIComponent(transactionId)}/refund`, {
      method: 'POST',
      body: { amount: Math.round(value * 100) / 100 },
    });
    log('morning.refunded', { tenantId, transactionId, amount: value });
    return result;
  }

  // ──────────────────── standing orders (הוראת קבע) ────────────────────

  /**
   * These calls are how a yearly subscription is paid, and they are absent from
   * Morning's published reference. The field names were taken from the
   * `shirser121/n8n-nodes-morning` node, whose author verified them against the
   * live sandbox, and then checked against a real account.
   *
   * The shape is two steps. First the parent saves a card on a Morning-hosted
   * page, which yields a reusable token. Then a recurring payment is created
   * against that token, and Morning charges it on the same day every month and
   * issues the invoice itself, which is the whole reason to use its standing
   * order rather than a monthly charge of our own: nothing here has to be
   * running on the 5th of the month for a parent to be billed.
   */

  /**
   * A hosted page where the parent saves their card. There is no successUrl and
   * no notifyUrl on this call (Morning does not tell us when the card has been
   * saved), so `externalKey` is the whole correlation mechanism, exactly as
   * `custom` is for a payment form.
   *
   * `channel` 1 returns the link for us to send; 2 would have Morning email it.
   */
  async function createCardTokenLink({ externalKey, lang = 'he' }) {
    if (!pluginId) throw new Error('אין סליקה מוגדרת: אי אפשר ליצור קישור לשמירת כרטיס');
    const result = await api('/payments/tokens/url', {
      method: 'POST',
      body: { pluginId, lang, channel: 1, externalKey },
    });

    const url = result?.url ?? result?.tokenUrl ?? result?.link ?? null;
    if (!url) {
      throw new Error(`מורנינג לא החזירה כתובת לשמירת כרטיס. תשובה: ${JSON.stringify(result).slice(0, 500)}`);
    }
    return { url, raw: result };
  }

  async function searchCardTokens({ externalKey, page = 1, pageSize = 50 } = {}) {
    const body = { page, pageSize };
    if (externalKey) body.externalKey = externalKey;
    const result = await api('/payments/tokens/search', { method: 'POST', body });
    const items = result?.items ?? result?.rows ?? result?.data ?? [];
    if (!Array.isArray(items)) {
      throw new Error(`מורנינג החזירה חיפוש כרטיסים בצורה לא מוכרת: ${JSON.stringify(result).slice(0, 300)}`);
    }
    return items;
  }

  /**
   * The one saved card filed under `externalKey`, or null while the parent has
   * not finished saving one. The newest wins: a parent whose first card was
   * declined and who went round again should be charged on the second.
   */
  async function findCardToken(externalKey) {
    const tokens = await searchCardTokens({ externalKey });
    if (tokens.length === 0) return null;
    // `creationDate` is a Unix epoch *number*, checked against live tokens, so
    // this sorts numerically. Comparing as strings happened to work while every
    // epoch has ten digits, which is not a property to rely on.
    const newest = [...tokens].sort((a, b) =>
      Number(b.creationDate ?? b.created ?? 0) - Number(a.creationDate ?? a.created ?? 0))[0];
    const id = newest?.id ?? newest?.tokenId ?? newest?.token ?? null;
    if (!id) {
      throw new Error(`מורנינג החזירה כרטיס שמור בלי מזהה: ${JSON.stringify(newest).slice(0, 300)}`);
    }
    // The last four digits come back as `number`, not `cardSuffix` or `last4`.
    return { id, last4: newest?.number ?? newest?.cardSuffix ?? newest?.last4 ?? '', raw: newest };
  }

  /**
   * The standing order itself. `cycles` rather than `endDate` on purpose: the
   * parent signed a contract promising exactly N monthly charges, and a count
   * is that promise, where an end date leaves the count to Morning's own
   * arithmetic about which side of the last month the charge day falls on.
   *
   * `day`, `interval`, `currency` and `startDate` are fixed at creation and
   * cannot be changed afterwards.
   */
  async function createRecurringPayment({
    tokenId, amount, currency = 'ILS', description, startDate, dayOfMonth, cycles,
    clientEmail, clientId, lang = 'he', skipHolidays = true,
    docType = documentType,
    /**
     * The VAT treatment of the *document*, which is not the `vatType` of an
     * income line and must not be fed from it. Every standing order already
     * running on the account this was verified against carries 0 here, and
     * those orders issue correct invoices, which is better evidence than the
     * two field lists we have, since they contradict each other about what the
     * numbers mean (one reads 1 as "VAT included", the other as "exempt").
     * Passing a line-item 1 through to this field could mark a year of
     * invoices VAT-exempt.
     */
    documentVatType = 0,
  }) {
    if (!tokenId) throw new Error('אי אפשר ליצור הוראת קבע בלי כרטיס שמור');
    if (!pluginId) throw new Error('אין סליקה מוגדרת: אי אפשר ליצור הוראת קבע');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('סכום ההוראת קבע חייב להיות מספר גדול מאפס');

    const body = {
      tokenId,
      amount: Math.round(value * 100) / 100,
      currency,
      lang,
      day: dayOfMonth,
      interval: '1', // monthly; Morning also takes '2', '3' and '12'
      startDate,
      data: {
        description,
        documentType: docType,
        documentVatType,
        // Present inside `data` on every live order checked. Not in any field
        // list we had; without it Morning would have to guess which clearing
        // to charge through.
        pluginId,
        skipHolidays,
      },
    };
    if (cycles > 0) body.cycles = cycles;
    if (clientEmail) body.clientEmail = clientEmail;
    if (clientId) body.clientId = clientId;

    const result = await api('/payments/recurrings', { method: 'POST', body });
    const id = result?.id ?? result?.recurringId ?? result?.data?.id ?? null;
    if (!id) {
      throw new Error(`מורנינג לא החזירה מזהה להוראת הקבע. תשובה: ${JSON.stringify(result).slice(0, 500)}`);
    }
    log('morning.recurring_created', { tenantId, recurringId: id, amount: value });
    return { id, raw: result };
  }

  /**
   * Standing orders at Morning, whoever created them. `status` filters by its
   * numeric codes: 5 pending, 10 created, 20 started, 30 finished, 50 canceled,
   * 60 suspended, 70 expired.
   */
  async function searchRecurrings({ status = null, page = 1, pageSize = 100 } = {}) {
    const body = { page, pageSize };
    if (status) body.status = status;
    const result = await api('/payments/recurrings/search', { method: 'POST', body });
    const items = result?.items ?? result?.rows ?? result?.data ?? [];
    if (!Array.isArray(items)) {
      throw new Error(`מורנינג החזירה חיפוש הוראות קבע בצורה לא מוכרת: ${JSON.stringify(result).slice(0, 300)}`);
    }
    return items;
  }

  async function getRecurringPayment(recurringId) {
    return api(`/payments/recurrings/${encodeURIComponent(recurringId)}`);
  }

  /**
   * Stop a standing order. Morning keeps the record and its history: this is
   * the end of the charges, not the deletion of what already happened.
   */
  async function cancelRecurringPayment(recurringId) {
    if (!recurringId) throw new Error('חסר מזהה הוראת קבע לביטול');
    const result = await api(`/payments/recurrings/${encodeURIComponent(recurringId)}`, { method: 'DELETE' });
    log('morning.recurring_cancelled', { tenantId, recurringId });
    return result;
  }

  /**
   * Charges that failed, across every standing order on this account. A monthly
   * charge posts no callback anywhere (Morning simply suspends the order after
   * it fails), so this list is the only way to learn that a parent's card
   * stopped working.
   *
   * Returns { items, withheld }. On the account this was verified against, the
   * envelope answers `total: 1` with `items: []` for every page size and date
   * range tried, so `total` counts something this endpoint will not hand over.
   * It matters because of what this is for: an empty list is indistinguishable
   * from "nothing failed", and a watchdog built on it would report all-clear
   * while a charge sits failed. We cannot fix Morning's answer, but we can
   * refuse to be quietly wrong about it, so the discrepancy is returned rather
   * than logged and dropped.
   */
  async function failedRecurringJobs({ page = 1, pageSize = 100 } = {}) {
    const result = await api('/payments/recurrings/jobs/failed', { method: 'POST', body: { page, pageSize } });
    const items = result?.items ?? result?.rows ?? result?.data ?? [];
    if (!Array.isArray(items)) {
      throw new Error(`מורנינג החזירה חיובים שנכשלו בצורה לא מוכרת: ${JSON.stringify(result).slice(0, 300)}`);
    }

    const total = Number(result?.total ?? NaN);
    const withheld = Number.isFinite(total) && total > items.length ? total - items.length : 0;
    if (withheld > 0) {
      log('morning.failed_jobs_withheld', {
        tenantId, total, returned: items.length,
        hint: 'מורנינג סופרת חיובים שנכשלו אך אינה מחזירה אותם: יש לבדוק ידנית בממשק שלה',
      });
    }
    return { items, withheld };
  }

  return {
    tenantId,
    environment,
    pluginId,
    documentType,
    businessInfo,
    documentTypeInfo,
    listPaymentPlugins,
    verifyConnection,
    createPaymentForm,
    getPaymentLink,
    searchDocuments,
    getDocument,
    getTransaction,
    refundTransaction,
    createCardTokenLink,
    searchCardTokens,
    findCardToken,
    createRecurringPayment,
    searchRecurrings,
    getRecurringPayment,
    cancelRecurringPayment,
    failedRecurringJobs,
    /** Testing seam only: proves the cache is per-client, not shared. */
    _tokenState: () => (cachedToken ? { ...cachedToken } : null),
  };
}
