import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProgramConfig, getRawProgramConfig, saveProgramConfig,
  listProgramConfigHistory, undoProgramConfig, ProgramConfigError,
} from '../src/programs/store.js';
import { termsVersionOf } from '../src/programs/camp.js';
import { makeTenant, dropTenant, sampleCamp, closePool } from './_helpers.js';

let tenant;
let other;

test('setup', async () => {
  tenant = await makeTenant('עסק א');
  other = await makeTenant('עסק ב');
});

test('a tenant with no program reads null, which is an ordinary state', async () => {
  assert.equal(await getProgramConfig(tenant.id), null);
  assert.equal(await getRawProgramConfig(tenant.id), null);
});

test('a saved config comes back decorated', async () => {
  const saved = await saveProgramConfig(tenant.id, sampleCamp());
  assert.equal(saved.created, true);
  assert.equal(saved.termsVersion, termsVersionOf(sampleCamp()));
  assert.equal(saved.termsChanged, false); // nothing before it to change from

  const camp = await getProgramConfig(tenant.id);
  assert.equal(camp.campName, 'קייטנת בדיקה');
  assert.equal(typeof camp.weekById, 'function');
  assert.equal(camp.weekById('w1').days.length, 5);
  assert.ok(camp.updatedAt instanceof Date);
});

test('an invalid config is refused with its reasons and does not replace the live one', async () => {
  const broken = sampleCamp({ pricing: { dailyPrice: 0, weeklyPrice: 0 } });
  await assert.rejects(() => saveProgramConfig(tenant.id, broken), ProgramConfigError);
  const still = await getProgramConfig(tenant.id);
  assert.equal(still.pricing.dailyPrice, 150);
});

test('the refusal carries every reason, not just the first', async () => {
  try {
    await saveProgramConfig(tenant.id, { campName: '' });
    assert.fail('should have been refused');
  } catch (error) {
    assert.ok(error.problems.length > 1, error.problems.join(' | '));
    assert.equal(error.code, 'PROGRAM_CONFIG');
  }
});

test('one tenant cannot read or write another tenant program', async () => {
  // Row-level security, not a WHERE clause in this module.
  assert.equal(await getProgramConfig(other.id), null);
  await saveProgramConfig(other.id, sampleCamp({ campName: 'קייטנה אחרת' }));
  assert.equal((await getProgramConfig(tenant.id)).campName, 'קייטנת בדיקה');
  assert.equal((await getProgramConfig(other.id)).campName, 'קייטנה אחרת');
});

test('a price change does not change the terms version', async () => {
  const before = (await getProgramConfig(tenant.id)).termsVersion;
  const saved = await saveProgramConfig(tenant.id, sampleCamp({
    pricing: { dailyPrice: 120, weeklyPrice: 500, siblingDiscountPercent: 10, vatType: 1 },
  }));
  assert.equal(saved.termsChanged, false);
  assert.equal(saved.termsVersion, before);
});

test('a wording change is reported, because every later signature records it', async () => {
  const reworded = sampleCamp({
    pricing: { dailyPrice: 120, weeklyPrice: 500, siblingDiscountPercent: 10, vatType: 1 },
  });
  reworded.consent.terms = ['סעיף ראשון', 'סעיף שני', 'סעיף שלישי'];
  const saved = await saveProgramConfig(tenant.id, reworded);
  assert.equal(saved.termsChanged, true);
  assert.notEqual(saved.termsVersion, saved.previousTermsVersion);
});

test('every save is archived', async () => {
  const history = await listProgramConfigHistory(tenant.id);
  // Three successful saves so far, the first of which had nothing to archive.
  assert.equal(history.length, 2);
  // Newest first, so the screen can offer the top one as undo.
  assert.ok(history[0].created_at >= history[1].created_at);
  assert.equal(history[0].config.pricing.dailyPrice, 120);
  assert.equal(history[1].config.pricing.dailyPrice, 150);
});

test('undo walks back through saves rather than toggling the last two', async () => {
  // The failure this guards: an undo that archives what it discards makes a
  // second press return to where you started, which is not what somebody
  // pressing undo twice means.
  const live = await getProgramConfig(tenant.id);
  assert.equal(live.consent.terms.length, 3);

  const first = await undoProgramConfig(tenant.id);
  assert.equal(first.ok, true);
  assert.equal((await getProgramConfig(tenant.id)).pricing.dailyPrice, 120);
  assert.equal(first.canUndo, true);

  const second = await undoProgramConfig(tenant.id);
  assert.equal(second.ok, true);
  assert.equal((await getProgramConfig(tenant.id)).pricing.dailyPrice, 150);
  assert.equal(second.canUndo, false);

  const third = await undoProgramConfig(tenant.id);
  assert.equal(third.ok, false);
  assert.match(third.problem, /אין מה לבטל/);
});

test('an unknown program kind is refused rather than silently stored', async () => {
  await assert.rejects(() => getProgramConfig(tenant.id, 'spa'), /סוג תוכנית לא מוכר/);
  await assert.rejects(() => saveProgramConfig(tenant.id, sampleCamp(), { kind: 'spa' }), /סוג תוכנית לא מוכר/);
});

test('teardown', async () => {
  await dropTenant(tenant?.id);
  await dropTenant(other?.id);
  await closePool();
});
