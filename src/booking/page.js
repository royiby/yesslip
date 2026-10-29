import { fileURLToPath } from 'node:url';
import { assetUrl } from '../lib/assets.js';
import { escapeHtml, jsonForScript, safeColor } from '../lib/html.js';
import { money } from '../lib/hebrew.js';
import { brandPalette } from '../lib/palette.js';

const ASSET = fileURLToPath(new URL('assets/booking.js', import.meta.url));

/**
 * The whole parent-facing flow is this one page: pick days, give details, sign,
 * pay. Server-rendered shell plus one vanilla script, no build step, because
 * the thing most likely to break this project is a toolchain nobody maintains.
 *
 * ───────────────────────────── per tenant ─────────────────────────────
 *
 * Two things are tenant-scoped and both matter. The colours are computed from
 * the business's own two choices by src/lib/palette.js, which picks the text
 * colour on top rather than trusting it to contrast. And every URL the script
 * calls is built from `base`, the tenant's own path prefix, rather than from
 * `/api/...`: one process now serves every business, so a hard-coded path is
 * a request that could land on somebody else's booking page.
 */
export function renderBookingPage({ tenant, camp, availability, closed, base }) {
  const palette = brandPalette({ primary: tenant.color_primary, accent: tenant.color_accent });

  const boot = {
    base,
    campName: camp.campName,
    currency: camp.currency ?? 'ILS',
    termsVersion: camp.termsVersion,
    dailyPrice: camp.pricing.dailyPrice,
    weeklyPrice: camp.pricing.weeklyPrice,
    siblingDiscountPercent: camp.pricing.siblingDiscountPercent ?? 0,
    hours: camp.hours ?? '',
    location: camp.location ?? '',
    includes: camp.includes ?? '',
    cancellationPolicy: camp.cancellationPolicy ?? '',
    consent: {
      terms: camp.consent.terms ?? [],
      healthDeclaration: camp.consent.healthDeclaration ?? '',
      photoConsent: camp.consent.photoConsent ?? '',
      photoConsentOptional: camp.consent.photoConsentOptional !== false,
      allergiesPrompt: camp.consent.allergiesPrompt ?? 'רגישויות ואלרגיות',
      pickupPrompt: camp.consent.pickupPrompt ?? 'מורשים לאיסוף',
    },
    weeks: camp.weeks.map((week) => ({
      id: week.id,
      label: week.label,
      days: week.days.map((day) => ({
        date: day,
        remaining: availability.get(day) ?? null,
      })),
    })),
    closed,
  };

  const logo = tenant.logo_key
    ? `<img class="logo" src="${escapeHtml(base)}/logo" alt="${escapeHtml(tenant.name)}">`
    : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${safeColor(palette.brand, '#2563eb')}">
<meta name="robots" content="noindex">
<title>הרשמה · ${escapeHtml(camp.campName)}</title>
<style>
  :root {
    --bg: #f4f6f8; --card: #ffffff; --ink: #161d26; --muted: #66707e;
    --line: #e2e6eb; --warn: #b4472f; --radius: 14px;
    --brand: ${palette.brand};
    --brand-ink: ${palette.brandInk};
    --brand-soft: ${palette.brandSoft};
    --accent: ${palette.accent};
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Rubik, Arial, sans-serif;
         background: var(--bg); color: var(--ink); line-height: 1.6;
         padding: 0 0 120px; -webkit-text-size-adjust: 100%; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 0 16px; }
  header { background: var(--brand); color: var(--brand-ink); padding: 22px 0 18px; margin-bottom: 18px; }
  header h1 { margin: 0 0 4px; font-size: 1.35rem; }
  header p { margin: 0; opacity: .9; font-size: .9rem; }
  header .logo { max-height: 48px; max-width: 180px; margin-bottom: 10px; display: block; }
  .card { background: var(--card); border-radius: var(--radius); padding: 18px 16px;
          margin-bottom: 14px; box-shadow: 0 1px 3px rgba(16,24,38,.06); }
  .card > h2 { margin: 0 0 12px; font-size: 1.05rem; display: flex; align-items: center; gap: 8px; }
  .step-num { background: var(--brand-soft); color: var(--brand); width: 26px; height: 26px; flex: 0 0 26px;
              border-radius: 50%; display: grid; place-items: center; font-size: .85rem; font-weight: 700; }
  label { display: block; font-size: .9rem; font-weight: 600; margin: 12px 0 5px; }
  .hint { font-weight: 400; color: var(--muted); font-size: .82rem; margin-inline-start: 6px; }
  input[type=text], input[type=tel], input[type=email], textarea {
    width: 100%; font: inherit; padding: 12px; border: 1px solid var(--line);
    border-radius: 10px; background: #fff; color: inherit; }
  textarea { min-height: 72px; resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--brand); outline-offset: 1px; border-color: var(--brand); }
  .days { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; margin-top: 8px; }
  .day { border: 1.5px solid var(--line); border-radius: 12px; background: #fff; padding: 10px 6px;
         text-align: center; cursor: pointer; font: inherit; color: inherit; transition: .12s; }
  .day .dow, .day .date, .day .seats { display: block; }
  .day .dow { font-weight: 700; font-size: .95rem; }
  .day .date { font-size: .78rem; color: var(--muted); }
  .day .seats { font-size: .7rem; color: var(--muted); margin-top: 2px; }
  .day[aria-pressed=true] { border-color: var(--brand); background: var(--brand-soft); }
  .day[aria-pressed=true] .seats { color: var(--brand); }
  .day:disabled { opacity: .45; cursor: not-allowed; }
  .day:disabled .seats { color: var(--warn); }
  .week-head { display: flex; justify-content: space-between; align-items: baseline; margin-top: 14px; }
  .week-head h3 { margin: 0; font-size: .95rem; }
  .linkish { background: none; border: 0; color: var(--brand); font: inherit; font-weight: 600;
             cursor: pointer; padding: 4px 0; text-decoration: underline; }
  .child { border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
  .child-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .child-head strong { font-size: .95rem; }
  .check { display: flex; gap: 10px; align-items: flex-start; margin: 14px 0; font-size: .9rem; }
  .check input { width: 22px; height: 22px; margin: 2px 0 0; flex: 0 0 22px; accent-color: var(--brand); }
  .terms { background: #fafbfc; border: 1px solid var(--line); border-radius: 10px;
           padding: 12px 14px; max-height: 180px; overflow-y: auto; font-size: .86rem; }
  .terms ul { margin: 0; padding-inline-start: 18px; }
  .terms li { margin-bottom: 6px; }
  canvas#sig { width: 100%; height: 170px; border: 1.5px dashed var(--line); border-radius: 12px;
               background: #fff; touch-action: none; display: block; }
  .sig-row { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  .total { background: var(--brand-soft); border-radius: 12px; padding: 12px 14px; margin-top: 10px; }
  .total-line { display: flex; justify-content: space-between; font-size: .88rem; padding: 2px 0; }
  .total-line.big { font-size: 1.1rem; font-weight: 700; border-top: 1px solid var(--line);
                    margin-top: 8px; padding-top: 8px; }
  .saving { color: var(--brand); font-size: .82rem; }
  .bar { position: fixed; inset-inline: 0; bottom: 0; background: var(--card);
         border-top: 1px solid var(--line); padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
         box-shadow: 0 -2px 12px rgba(16,24,38,.08); }
  .bar .wrap { display: flex; align-items: center; gap: 12px; padding: 0 16px; }
  .bar .amount { font-weight: 700; font-size: 1.05rem; white-space: nowrap; }
  button.primary { flex: 1; background: var(--brand); color: var(--brand-ink); border: 0;
                   border-radius: 12px; padding: 15px; font: inherit; font-weight: 700; font-size: 1rem;
                   cursor: pointer; min-height: 52px; }
  button.primary:disabled { background: #a9b4bd; color: #fff; cursor: not-allowed; }
  .error { background: #fdf0ec; border-inline-start: 4px solid var(--warn); color: #8a2f1c;
           padding: 11px 14px; border-radius: 8px; margin: 12px 0; font-size: .9rem; }
  .notice { background: #fff8e8; border-inline-start: 4px solid var(--accent); padding: 12px 14px;
            border-radius: 8px; margin-bottom: 14px; font-size: .9rem; }
  .facts { font-size: .85rem; color: var(--muted); }
  .facts div { padding: 2px 0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #11151b; --card: #1a1f27; --ink: #eef1f5; --muted: #9aa5b1;
            --line: #2b323c;
            --brand: ${palette.darkBrand}; --brand-soft: ${palette.darkBrandSoft}; }
    input[type=text], input[type=tel], input[type=email], textarea, .day, canvas#sig { background: #141921; }
    .terms { background: #141921; }
    .error { background: #2a1a17; color: #f0b5a4; }
    .notice { background: #262016; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    ${logo}
    <h1>${escapeHtml(camp.campName)}</h1>
    <p>הרשמה לימים בודדים · ${escapeHtml(money(camp.pricing.dailyPrice))} ליום · ${escapeHtml(money(camp.pricing.weeklyPrice))} לשבוע שלם</p>
  </div>
</header>

<main class="wrap" id="app">
  <noscript><div class="error">הדף דורש JavaScript. פתחו אותו בדפדפן רגיל, או שלחו לנו הודעה ונרשום אותך/אותכם ידנית.</div></noscript>
</main>

<div class="bar" id="bar" hidden>
  <div class="wrap">
    <span class="amount" id="barAmount"></span>
    <button class="primary" id="submit" type="button">המשך לתשלום</button>
  </div>
</div>

<script>window.CAMP = ${jsonForScript(boot)};</script>
<script src="${escapeHtml(base)}${assetUrl('/assets/booking.js', ASSET)}"></script>
</body>
</html>`;
}

/** The page shown when a tenant exists but has not published a program yet. */
export function renderNotOpenPage(tenant) {
  const palette = brandPalette({ primary: tenant.color_primary, accent: tenant.color_accent });
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(tenant.name)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Rubik, Arial, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center; background: #f4f6f8;
         color: #161d26; padding: 24px; }
  .card { background: #fff; border-radius: 18px; padding: 32px 28px; max-width: 420px;
          text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
  h1 { font-size: 1.3rem; margin: 0 0 12px; color: ${palette.brand}; }
  p { line-height: 1.6; color: #66707e; }
</style>
</head>
<body><main class="card">
  <h1>${escapeHtml(tenant.name)}</h1>
  <p>אין כרגע הרשמה פתוחה. שלחו לנו הודעה ונעדכן כשנפתחת.</p>
</main></body>
</html>`;
}
