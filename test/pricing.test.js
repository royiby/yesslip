import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSelection, priceCart, cartToIncomeLines, summarizeCart } from '../src/pricing.js';
import { decoratedSampleCamp } from './_helpers.js';

const camp = await decoratedSampleCamp();
// 150/day, 600/week, 5-day weeks, 10% sibling discount.

test('a few days are priced per day', () => {
  const priced = priceSelection(camp, 'w1', ['2030-07-01', '2030-07-02']);
  assert.equal(priced.amount, 300);
  assert.equal(priced.mode, 'daily');
  assert.equal(priced.upgraded, false);
  assert.equal(priced.savings, 0);
});

test('a full week gets the weekly price and reports the saving', () => {
  const priced = priceSelection(camp, 'w1', camp.weekById('w1').days);
  assert.equal(priced.amount, 600);
  assert.equal(priced.mode, 'weekly');
  assert.equal(priced.savings, 150); // 5 x 150 = 750
});

test('the weekly price is a ceiling, so 4 days never cost more than 5', () => {
  const four = priceSelection(camp, 'w1', camp.weekById('w1').days.slice(0, 4));
  const five = priceSelection(camp, 'w1', camp.weekById('w1').days);
  assert.equal(four.amount, 600); // 4 x 150 = 600, equal to the week
  assert.equal(four.mode, 'weekly-capped');
  assert.equal(four.upgraded, true);
  assert.ok(four.amount <= five.amount);
});

test('an unknown day in the selection is dropped, not priced', () => {
  const priced = priceSelection(camp, 'w1', ['2030-07-01', '2030-07-08', 'not-a-day']);
  assert.deepEqual(priced.days, ['2030-07-01']);
  assert.equal(priced.amount, 150);
});

test('a duplicated day is counted once', () => {
  const priced = priceSelection(camp, 'w1', ['2030-07-01', '2030-07-01']);
  assert.equal(priced.dayCount, 1);
  assert.equal(priced.amount, 150);
});

test('an unknown week is a thrown error, not a zero price', () => {
  assert.throws(() => priceSelection(camp, 'nope', ['2030-07-01']), /שבוע לא מוכר/);
});

test('the sibling discount applies to every child after the first', () => {
  const priced = priceCart(camp, [
    { childName: 'א', weekId: 'w1', days: ['2030-07-01', '2030-07-02'] },
    { childName: 'ב', weekId: 'w1', days: ['2030-07-01', '2030-07-02'] },
  ]);
  assert.equal(priced.items[0].discount, 0);
  assert.equal(priced.items[1].discount, 30); // 10% of 300
  assert.equal(priced.total, 570);
  assert.equal(priced.discountTotal, 30);
});

test('a cart of one child gets no discount however it is ordered', () => {
  const priced = priceCart(camp, [{ childName: 'א', weekId: 'w1', days: ['2030-07-01'] }]);
  assert.equal(priced.discountTotal, 0);
  assert.equal(priced.total, 150);
});

test('income lines itemise one line per child, with the configured vat type', () => {
  const priced = priceCart(camp, [
    { childName: 'יובל', weekId: 'w1', days: ['2030-07-01'] },
    { childName: 'נועה', weekId: 'w2', days: camp.weekById('w2').days },
  ]);
  const lines = cartToIncomeLines(camp, priced);
  assert.equal(lines.length, 2);
  assert.match(lines[0].description, /יובל/);
  assert.match(lines[1].description, /כל השבוע/);
  assert.equal(lines[0].vatType, 1);
  assert.equal(lines[0].currency, 'ILS');
  // The lines must add up to what is charged, or the invoice disagrees with
  // the payment and the business has to reconcile it by hand.
  assert.equal(lines.reduce((s, l) => s + l.price, 0), priced.total);
});

test('the summary names the upgrade rather than silently charging more days', () => {
  const priced = priceCart(camp, [
    { childName: 'יובל', weekId: 'w1', days: camp.weekById('w1').days.slice(0, 4) },
  ]);
  const text = summarizeCart(camp, priced);
  assert.match(text, /שדרגנו אותך למחיר השבועי/);
  assert.match(text, /600/);
});

test('prices are rounded to agorot, not left as floating point dust', async () => {
  const odd = await decoratedSampleCamp({
    pricing: { dailyPrice: 33.33, weeklyPrice: 160, siblingDiscountPercent: 7, vatType: 1 },
  });
  const priced = priceCart(odd, [
    { childName: 'א', weekId: 'w1', days: ['2030-07-01', '2030-07-02', '2030-07-03'] },
    { childName: 'ב', weekId: 'w1', days: ['2030-07-01'] },
  ]);
  for (const item of priced.items) {
    assert.equal(item.amount, Math.round(item.amount * 100) / 100);
    assert.equal(item.discount, Math.round(item.discount * 100) / 100);
  }
  assert.equal(priced.total, Math.round(priced.total * 100) / 100);
});
