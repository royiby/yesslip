import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandPalette, contrastRatio, parseHex, luminance } from '../src/lib/palette.js';
import { safeColor } from '../src/lib/html.js';

const WHITE = { r: 255, g: 255, b: 255 };
const DARK_CARD = { r: 26, g: 31, b: 39 };

test('a dark brand colour gets white text', () => {
  const palette = brandPalette({ primary: '#2f6f4f' });
  assert.equal(palette.brandInk, '#ffffff');
});

test('a pale brand colour gets dark text instead of unreadable white', () => {
  // The failure this guards: a business picks pale yellow because it is their
  // logo, and white-on-yellow makes the button that takes a payment illegible.
  const palette = brandPalette({ primary: '#fde047' });
  assert.equal(palette.brandInk, '#14181f');
  assert.ok(palette.contrastOnBrand > 4.5, `ratio was ${palette.contrastOnBrand}`);
});

test('every hue clears WCAG AA on its own button', () => {
  const hues = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
    '#808080', '#ffffff', '#000000', '#7f3fbf', '#f97316', '#14b8a6'];
  for (const hue of hues) {
    const palette = brandPalette({ primary: hue });
    const ratio = contrastRatio(parseHex(palette.brand), parseHex(palette.brandInk));
    assert.ok(ratio >= 4.5, `${hue} gave only ${ratio.toFixed(2)}:1`);
  }
});

test('a colour that cannot carry readable text is darkened, and says so', () => {
  // Pure red is the case: white on it is 4.00:1 and near-black 4.55:1, so
  // neither clears AA for a button label. The hue is kept, the shade is not.
  const palette = brandPalette({ primary: '#ff0000' });
  assert.equal(palette.adjusted, true);
  assert.equal(palette.requested, '#ff0000');
  assert.notEqual(palette.brand, '#ff0000');
  assert.ok(contrastRatio(parseHex(palette.brand), parseHex(palette.brandInk)) >= 4.5);
  // Still recognisably red: only the red channel is non-zero.
  const rgb = parseHex(palette.brand);
  assert.ok(rgb.r > 180 && rgb.g === 0 && rgb.b === 0, palette.brand);
});

test('a colour that already works is left exactly as chosen', () => {
  for (const hue of ['#2f6f4f', '#2563eb', '#fde047', '#f97316', '#808080']) {
    const palette = brandPalette({ primary: hue });
    assert.equal(palette.brand, hue);
    assert.equal(palette.adjusted, false);
  }
});

test('a brand colour too dark for dark mode is lifted until it is visible', () => {
  const palette = brandPalette({ primary: '#0b1021' });
  const ratio = contrastRatio(parseHex(palette.darkBrand), DARK_CARD);
  assert.ok(ratio >= 3, `dark-mode brand gave only ${ratio.toFixed(2)}:1`);
  assert.notEqual(palette.darkBrand, palette.brand);
});

test('a brand colour already visible in dark mode is left alone', () => {
  const palette = brandPalette({ primary: '#fde047' });
  assert.equal(palette.darkBrand, '#fde047');
});

test('nonsense falls back instead of reaching the stylesheet', () => {
  // The values are interpolated into CSS, so this is an injection site, not a
  // cosmetic one.
  for (const bad of ['red', 'rgb(1,2,3)', '#fff', '#12345g', 'url(x)', '#123456;}', null, undefined, 0]) {
    const palette = brandPalette({ primary: bad });
    assert.match(palette.brand, /^#[0-9a-f]{6}$/, `${bad} produced ${palette.brand}`);
  }
});

test('safeColor refuses anything that is not a six-digit hex', () => {
  assert.equal(safeColor('#abcdef', '#000000'), '#abcdef');
  assert.equal(safeColor('#ABCDEF', '#000000'), '#ABCDEF');
  assert.equal(safeColor('#abc', '#000000'), '#000000');
  assert.equal(safeColor('blue; background: url(//evil)', '#000000'), '#000000');
  assert.equal(safeColor('', '#000000'), '#000000');
});

test('luminance is monotonic from black to white', () => {
  assert.ok(luminance({ r: 0, g: 0, b: 0 }) < luminance({ r: 128, g: 128, b: 128 }));
  assert.ok(luminance({ r: 128, g: 128, b: 128 }) < luminance(WHITE));
  assert.equal(Math.round(contrastRatio({ r: 0, g: 0, b: 0 }, WHITE)), 21);
});
