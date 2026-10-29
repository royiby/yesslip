/**
 * Turning a tenant's two chosen colours into a usable set.
 *
 * A business owner picks a primary colour because it matches their logo, not
 * because it contrasts with white. Pale yellow is a reasonable brand colour and
 * a terrible button background for white text, so the text colour on top is
 * computed rather than chosen: whichever of near-black and white has the better
 * contrast ratio against what they picked.
 *
 * The ratios are WCAG 2.1 relative luminance, which is arithmetic, not taste.
 * It is the one part of letting somebody theme a page that cannot be left to
 * them, because the failure mode is a parent who cannot read the button that
 * takes their money.
 */

const HEX = /^#([0-9a-fA-F]{6})$/;

export function parseHex(value) {
  const match = HEX.exec(String(value ?? ''));
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

const WHITE = { r: 255, g: 255, b: 255 };
const INK = { r: 20, g: 24, b: 31 };

/** Mix towards white. 0 is the colour itself, 1 is white. */
function tint(rgb, amount) {
  return {
    r: rgb.r + (255 - rgb.r) * amount,
    g: rgb.g + (255 - rgb.g) * amount,
    b: rgb.b + (255 - rgb.b) * amount,
  };
}

/** Mix towards black, for the dark-mode variants. */
function shade(rgb, amount) {
  return { r: rgb.r * (1 - amount), g: rgb.g * (1 - amount), b: rgb.b * (1 - amount) };
}

const FALLBACK = { primary: '#2563eb', accent: '#f59e0b' };

/** WCAG AA for body-sized text. A bold 16px button label is body-sized. */
const AA_TEXT = 4.5;
/** WCAG AA for a large interactive element against its background. */
const AA_LARGE = 3;

/**
 * The full set a page needs, derived from the two the tenant chose. Returned as
 * plain hex strings so the caller interpolates them into a stylesheet without
 * any further arithmetic, and so a test can assert the contrast rather than
 * eyeball it.
 */
export function brandPalette({ primary, accent } = {}) {
  const requested = parseHex(primary) ?? parseHex(FALLBACK.primary);
  const highlight = parseHex(accent) ?? parseHex(FALLBACK.accent);

  // Some colours cannot carry readable text at all. Pure red is the clearest
  // case: white on it is 4.00:1 and near-black on it is 4.55:1, so neither
  // reaches the 4.5:1 that WCAG AA asks of body-sized text, and a bold 16px
  // button label is body-sized. Picking the less-bad option and moving on would
  // ship an unreadable button, so the colour itself is darkened in small steps
  // until one of the two text colours works.
  //
  // This overrides what the business chose, which needs justifying: it happens
  // only when their choice is unusable, it moves along their own hue rather
  // than substituting another, and `adjusted` is returned so a settings screen
  // can say so instead of leaving them wondering why the shade looks off.
  let base = requested;
  let steps = 0;
  while (Math.max(contrastRatio(base, WHITE), contrastRatio(base, INK)) < AA_TEXT && steps < 24) {
    base = shade(base, 0.08);
    steps += 1;
  }

  const onBrand = contrastRatio(base, WHITE) >= contrastRatio(base, INK) ? WHITE : INK;

  // A readable dark-mode primary. A deep navy on a dark background is as
  // illegible as pale yellow is in light mode, so it is lifted towards white
  // until it clears 3:1 against the dark card colour, which is the WCAG
  // threshold for a large interactive element.
  const darkCard = { r: 26, g: 31, b: 39 };
  let darkBrand = base;
  for (let step = 0; step < 10 && contrastRatio(darkBrand, darkCard) < AA_LARGE; step += 1) {
    darkBrand = tint(darkBrand, 0.12);
  }

  return {
    brand: toHex(base),
    brandInk: toHex(onBrand),
    requested: toHex(requested),
    adjusted: steps > 0,
    brandSoft: toHex(tint(base, 0.88)),
    accent: toHex(highlight),
    accentInk: toHex(contrastRatio(highlight, WHITE) >= contrastRatio(highlight, INK) ? WHITE : INK),
    darkBrand: toHex(darkBrand),
    darkBrandSoft: toHex(shade(darkBrand, 0.74)),
    contrastOnBrand: Math.round(contrastRatio(base, onBrand) * 100) / 100,
  };
}

export const _internals = { tint, shade, toHex, WHITE, INK, FALLBACK, AA_TEXT, AA_LARGE };
