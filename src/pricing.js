import { dayLabelShort, money } from './lib/hebrew.js';

/**
 * Pricing is a pure function of a decorated config and a cart. No tenant id,
 * no database, no clock. That is deliberate: it is the part of the system a
 * business owner will dispute with a parent, and it has to be reproducible
 * from the config alone, years later, from the archived consent document.
 */

/**
 * Price one child's selection of days inside a single week.
 *
 * Two tariffs: a per-day price and a cheaper flat price for the whole week.
 * Picking every day of the week obviously gets the weekly price, but so does
 * any selection whose per-day total would have exceeded the weekly price.
 * A parent should never pay more for 4 days than for 5, so the weekly price
 * acts as a ceiling, and the summary says so out loud.
 */
export function priceSelection(camp, weekId, days) {
  const week = camp.weekById(weekId);
  if (!week) throw new Error(`שבוע לא מוכר: ${weekId}`);

  const selected = [...new Set(days)].filter((d) => week.days.includes(d)).sort();
  const dayCount = selected.length;
  const { dailyPrice, weeklyPrice } = camp.pricing;

  if (dayCount === 0) {
    return { weekId, days: selected, dayCount: 0, amount: 0, mode: 'empty', upgraded: false, savings: 0 };
  }

  const dailyTotal = dayCount * dailyPrice;
  const isFullWeek = dayCount >= week.days.length;

  if (isFullWeek) {
    return {
      weekId, days: selected, dayCount,
      amount: round2(weeklyPrice),
      mode: 'weekly',
      upgraded: false,
      savings: round2(dailyTotal - weeklyPrice),
    };
  }

  if (dailyTotal >= weeklyPrice) {
    // Cheaper to sell them the whole week than the days they picked.
    return {
      weekId, days: selected, dayCount,
      amount: round2(weeklyPrice),
      mode: 'weekly-capped',
      upgraded: true,
      savings: round2(dailyTotal - weeklyPrice),
    };
  }

  return {
    weekId, days: selected, dayCount,
    amount: round2(dailyTotal),
    mode: 'daily',
    upgraded: false,
    savings: 0,
  };
}

/**
 * Price a whole cart (one entry per child) and apply the sibling discount to
 * every child after the first. Returns the per-child breakdown plus the total
 * actually charged.
 */
export function priceCart(camp, cart) {
  const discountPercent = Number(camp.pricing.siblingDiscountPercent ?? 0);
  const items = cart.map((entry, index) => {
    const selection = priceSelection(camp, entry.weekId, entry.days);
    const discount = index > 0 ? round2((selection.amount * discountPercent) / 100) : 0;
    return {
      ...entry,
      ...selection,
      listAmount: selection.amount,
      discount,
      amount: round2(selection.amount - discount),
    };
  });

  const total = round2(items.reduce((sum, i) => sum + i.amount, 0));
  return {
    items,
    total,
    discountTotal: round2(items.reduce((sum, i) => sum + i.discount, 0)),
    savingsTotal: round2(items.reduce((sum, i) => sum + i.savings, 0)),
  };
}

/**
 * Morning income lines for a cart. One line per child so the invoice the parent
 * receives itemises exactly what they bought, which is also what makes a
 * dispute answerable without the business owner opening this system at all.
 */
export function cartToIncomeLines(camp, priced) {
  return priced.items.map((item) => ({
    description: incomeDescription(camp, item),
    quantity: 1,
    price: item.amount,
    currency: camp.currency ?? 'ILS',
    vatType: camp.pricing.vatType ?? 1,
  }));
}

function incomeDescription(camp, item) {
  const week = camp.weekById(item.weekId);
  const label = item.mode === 'daily'
    ? item.days.map(dayLabelShort).join(', ')
    : `${week.label}: כל השבוע`;
  return `${camp.campName} · ${item.childName} · ${label}`;
}

/** Human-readable summary of a priced cart, for a WhatsApp confirmation. */
export function summarizeCart(camp, priced) {
  const lines = [];
  for (const item of priced.items) {
    const week = camp.weekById(item.weekId);
    lines.push(`*${item.childName}* · ${week.label}`);
    for (const day of item.days) lines.push(`   • ${dayLabelShort(day)}`);
    if (item.mode === 'daily') {
      lines.push(`   ${item.dayCount} × ${money(camp.pricing.dailyPrice)} = ${money(item.listAmount)}`);
    } else {
      lines.push(`   מחיר שבועי מוזל: ${money(item.listAmount)}`);
      if (item.savings > 0) lines.push(`   _חסכת ${money(item.savings)} לעומת תשלום יומי_`);
      if (item.upgraded) lines.push('   _שדרגנו אותך למחיר השבועי: כל ימי השבוע כלולים_');
    }
    if (item.discount > 0) lines.push(`   הנחת אחים: −${money(item.discount)}`);
    lines.push('');
  }
  lines.push(`*סה"כ לתשלום: ${money(priced.total)}*`);
  return lines.join('\n');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
