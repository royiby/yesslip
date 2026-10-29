import { createHash } from 'node:crypto';
import { dayOfWeek } from '../lib/hebrew.js';

/**
 * A camp program: what days are on offer, what they cost, and what the parent
 * signs. Pure functions over a plain object, with no database and no tenant in
 * sight, because validation has to be runnable on a candidate the settings
 * screen has not saved yet.
 *
 * The single-tenant original kept this in a JSON file on a hosted disk. Here it
 * is a row in `program_configs` (see src/programs/store.js), which is what
 * makes a second business possible: a file is one per process, a row is one per
 * tenant. The shape of the object is unchanged, so the pricing, consent and
 * booking code ported across without edits.
 */

const MAX_PRICE = 100_000; // a typo guard
const MAX_WEEK_DAYS = 14;

/** `2026-02-31` matches the pattern but is not a day; round-tripping catches it. */
function isRealDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Every reason a camp config would be unusable, as Hebrew lines the owner can
 * act on. The settings screen runs this before writing anything, so a bad edit
 * is refused with its reason instead of taking a public booking page down.
 */
export function campProblems(camp) {
  const problems = [];
  if (!String(camp?.campName ?? '').trim()) problems.push('חסר שם לקייטנה');

  const { dailyPrice, weeklyPrice, siblingDiscountPercent } = camp?.pricing ?? {};
  if (!(dailyPrice > 0)) problems.push('pricing.dailyPrice חייב להיות מספר גדול מאפס');
  if (!(weeklyPrice > 0)) problems.push('pricing.weeklyPrice חייב להיות מספר גדול מאפס');
  if (dailyPrice > MAX_PRICE || weeklyPrice > MAX_PRICE) {
    problems.push(`מחיר גבוה מ-${MAX_PRICE} ₪ נראה כמו טעות הקלדה`);
  }
  const sibling = Number(siblingDiscountPercent ?? 0);
  if (!Number.isFinite(sibling) || sibling < 0 || sibling > 90) {
    problems.push('הנחת אחים חייבת להיות אחוז בין 0 ל-90');
  }

  if (!Array.isArray(camp?.weeks) || camp.weeks.length === 0) {
    problems.push('weeks חייב להכיל לפחות שבוע אחד');
  }

  const seenDays = new Set();
  const seenIds = new Set();
  for (const week of camp?.weeks ?? []) {
    if (!week.id) problems.push('לכל שבוע חייב להיות id');
    else if (seenIds.has(week.id)) problems.push(`המזהה ${week.id} מופיע בשני שבועות`);
    else seenIds.add(week.id);

    if (week.capacityPerDay !== undefined && week.capacityPerDay !== null && week.capacityPerDay !== '') {
      const capacity = Number(week.capacityPerDay);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        problems.push(`הקיבולת של ${week.label || week.id} חייבת להיות מספר שלם גדול מאפס (או ריקה: ללא הגבלה)`);
      }
    }

    if (!Array.isArray(week.days) || week.days.length === 0) {
      problems.push(`לשבוע ${week.label || week.id} אין ימים`);
      continue;
    }
    // The booking page renders a real calendar, so there is no hard ceiling.
    // This bound only catches a mistyped date list.
    if (week.days.length > MAX_WEEK_DAYS) {
      problems.push(`לשבוע ${week.id} יש ${week.days.length} ימים, נראה כמו טעות הקלדה`);
    }
    for (const d of week.days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        problems.push(`התאריך "${d}" בשבוע ${week.id} חייב להיות בפורמט YYYY-MM-DD`);
      } else if (!isRealDate(d)) {
        problems.push(`התאריך ${d} אינו תאריך קיים בלוח השנה`);
      }
      if (seenDays.has(d)) problems.push(`התאריך ${d} מופיע ביותר משבוע אחד`);
      seenDays.add(d);
    }
  }

  // The longest week is the one that has to be worth buying whole. If the
  // weekly rate does not beat paying for its days one by one, the discount the
  // owner thinks she is offering does not exist.
  const longestWeek = Math.max(0, ...(camp?.weeks ?? []).map((w) => w.days?.length ?? 0));
  if (camp?.pricing && longestWeek > 0 && weeklyPrice >= dailyPrice * longestWeek) {
    problems.push(
      `מחיר השבוע (${weeklyPrice}) אינו מוזל: השבוע הארוך ביותר הוא ${longestWeek} ימים, `
      + `ולכן תשלום יום-יום עולה ${dailyPrice * longestWeek}. הורידי את מחיר השבוע או הוסיפי ימים.`,
    );
  }

  if (camp?.registrationClosesAt && !Number.isFinite(new Date(camp.registrationClosesAt).getTime())) {
    problems.push(`מועד סגירת ההרשמה "${camp.registrationClosesAt}" אינו תאריך תקין`);
  }
  if (camp?.paymentLinkTtlMinutes !== undefined && !(Number(camp.paymentLinkTtlMinutes) > 0)) {
    problems.push('paymentLinkTtlMinutes חייב להיות מספר גדול מאפס');
  }

  const consent = camp?.consent ?? {};
  if (consent.terms !== undefined && !Array.isArray(consent.terms)) {
    problems.push('consent.terms חייב להיות רשימת סעיפים');
  }
  if (!String(consent.healthDeclaration ?? '').trim()) {
    problems.push('חסרה הצהרת הבריאות: בלי נוסח, אין על מה שההורה יחתום');
  }

  return problems;
}

/**
 * The hash that ties a signature to the exact wording the parent saw.
 *
 * Computed from the consent text alone, so editing a price does not invalidate
 * anything anybody signed, and editing a single term does. It is also the one
 * derived field stored in its own column rather than recomputed on read: the
 * row has to record which version was in force, and a column cannot be
 * retroactively changed by a later edit the way a recomputation can.
 */
export function termsVersionOf(camp) {
  const consent = camp?.consent ?? {};
  return createHash('sha256')
    .update(JSON.stringify([
      consent.terms ?? [],
      consent.healthDeclaration ?? '',
      consent.photoConsent ?? '',
      camp?.cancellationPolicy ?? '',
    ]))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Adds derived, read-only fields so the rest of the code never recomputes them.
 * The lookup helpers are closures over this one config, which is the reason a
 * decorated config can be handed to the pricing and consent code without
 * either of them ever seeing a tenant id.
 */
export function decorateCamp(camp) {
  const weeks = (camp.weeks ?? []).map((week) => ({
    ...week,
    capacityPerDay: week.capacityPerDay === '' ? null : week.capacityPerDay ?? null,
    fullWeekDayCount: week.days.length,
    fullWeekPrice: camp.pricing.weeklyPrice,
  }));
  const dayToWeek = new Map();
  for (const week of weeks) for (const d of week.days) dayToWeek.set(d, week);
  return {
    ...camp,
    consent: camp.consent ?? {},
    termsVersion: termsVersionOf(camp),
    weeks,
    allDays: weeks.flatMap((w) => w.days).sort(),
    weekOf: (isoDate) => dayToWeek.get(isoDate),
    weekById: (id) => weeks.find((w) => w.id === id),
    isWeekend: (isoDate) => [5, 6].includes(dayOfWeek(isoDate)),
  };
}

/** Has online registration closed? Null or empty means never. */
export function registrationClosed(camp, now = Date.now()) {
  if (!camp?.registrationClosesAt) return false;
  const closesAt = new Date(camp.registrationClosesAt).getTime();
  if (!Number.isFinite(closesAt)) return false;
  return now > closesAt;
}

/**
 * A starting config for a tenant who has just finished onboarding, named after
 * their business so the booking page is not titled "קייטנה" on day one. No
 * weeks: an empty calendar is an honest empty state, and inventing dates would
 * put a page live that takes money for days nobody is running.
 */
export function starterCamp({ name, timezone = 'Asia/Jerusalem', currency = 'ILS' }) {
  return {
    campName: name,
    timezone,
    currency,
    pricing: { dailyPrice: 0, weeklyPrice: 0, siblingDiscountPercent: 0, vatType: 1 },
    hours: '',
    location: '',
    includes: '',
    cancellationPolicy: '',
    refundPolicy: { fullRefundHoursBefore: 48, lateRefundPercent: 0 },
    registrationClosesAt: '',
    paymentLinkTtlMinutes: 60,
    consent: {
      terms: [],
      healthDeclaration: '',
      photoConsent: '',
      allergiesPrompt: 'רגישויות ואלרגיות',
      pickupPrompt: 'מורשים לאיסוף',
    },
    weeks: [],
  };
}

export const _internals = { isRealDate, MAX_PRICE, MAX_WEEK_DAYS };
