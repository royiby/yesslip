import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campProblems, decorateCamp, termsVersionOf, registrationClosed, starterCamp,
} from '../src/programs/camp.js';
import { sampleCamp } from './_helpers.js';

test('a sound config has no problems', () => {
  assert.deepEqual(campProblems(sampleCamp()), []);
});

test('a weekly price that is not a discount is refused', () => {
  // 5 days at 150 is 750, so a 750 weekly price is a discount the owner thinks
  // she is offering and is not. Caught before the page goes live, not after a
  // parent has noticed.
  const problems = campProblems(sampleCamp({
    pricing: { dailyPrice: 150, weeklyPrice: 750, siblingDiscountPercent: 0 },
  }));
  assert.ok(problems.some((p) => p.includes('אינו מוזל')), problems.join(' | '));
});

test('a date that is not on the calendar is refused', () => {
  const camp = sampleCamp();
  camp.weeks[0].days = ['2030-02-31'];
  assert.ok(campProblems(camp).some((p) => p.includes('אינו תאריך קיים')));
});

test('a day appearing in two weeks is refused', () => {
  const camp = sampleCamp();
  camp.weeks[1].days = [...camp.weeks[1].days, '2030-07-01'];
  assert.ok(campProblems(camp).some((p) => p.includes('מופיע ביותר משבוע אחד')));
});

test('a missing health declaration is refused, because there is nothing to sign', () => {
  const camp = sampleCamp();
  camp.consent.healthDeclaration = '   ';
  assert.ok(campProblems(camp).some((p) => p.includes('הצהרת הבריאות')));
});

test('a fractional capacity is refused but an empty one means no limit', () => {
  const camp = sampleCamp();
  camp.weeks[0].capacityPerDay = 2.5;
  assert.ok(campProblems(camp).some((p) => p.includes('קיבולת')));

  const open = sampleCamp();
  open.weeks[0].capacityPerDay = '';
  assert.deepEqual(campProblems(open), []);
  assert.equal(decorateCamp(open).weekById('w1').capacityPerDay, null);
});

test('termsVersion changes with the wording and not with the price', () => {
  // This is the whole reason the hash exists: a signature records the version
  // the parent saw, so dropping a price must not make every form on file look
  // like it agreed to different terms.
  const base = sampleCamp();
  const cheaper = sampleCamp({
    pricing: { dailyPrice: 100, weeklyPrice: 400, siblingDiscountPercent: 10 },
  });
  assert.equal(termsVersionOf(base), termsVersionOf(cheaper));

  const reworded = sampleCamp();
  reworded.consent.terms = ['סעיף ראשון', 'סעיף שני', 'סעיף שלישי'];
  assert.notEqual(termsVersionOf(base), termsVersionOf(reworded));

  const newPolicy = sampleCamp({ cancellationPolicy: 'ללא החזרים' });
  assert.notEqual(termsVersionOf(base), termsVersionOf(newPolicy));
});

test('decorate resolves a week by id and a day to its week', () => {
  const camp = decorateCamp(sampleCamp());
  assert.equal(camp.weekById('w2').label, 'שבוע שני');
  assert.equal(camp.weekOf('2030-07-09').id, 'w2');
  assert.equal(camp.weekById('nope'), undefined);
  assert.equal(camp.allDays.length, 10);
});

test('weekends are identified from the civil date, not the host timezone', () => {
  const camp = decorateCamp(sampleCamp());
  // 2030-07-05 is a Friday, 2030-07-06 a Saturday, 2030-07-07 a Sunday.
  assert.equal(camp.isWeekend('2030-07-05'), true);
  assert.equal(camp.isWeekend('2030-07-06'), true);
  assert.equal(camp.isWeekend('2030-07-07'), false);
});

test('registration closes on the configured instant and is open without one', () => {
  const closes = sampleCamp({ registrationClosesAt: '2030-06-01T23:59:00+03:00' });
  const at = new Date('2030-06-01T23:59:00+03:00').getTime();
  assert.equal(registrationClosed(closes, at - 1000), false);
  assert.equal(registrationClosed(closes, at + 1000), true);
  assert.equal(registrationClosed(sampleCamp()), false);
  // An unparseable value leaves registration open rather than closing a page
  // nobody meant to close.
  assert.equal(registrationClosed(sampleCamp({ registrationClosesAt: 'soon' })), false);
});

test('a starter config is named after the business and has no invented dates', () => {
  const starter = starterCamp({ name: 'הגן של דנה' });
  assert.equal(starter.campName, 'הגן של דנה');
  assert.deepEqual(starter.weeks, []);
  // Deliberately not valid yet: it has no priced days, and the settings screen
  // is what makes it bookable. An empty calendar beats a page that sells days
  // nobody is running.
  assert.ok(campProblems(starter).length > 0);
});
