/** Input validation for the parent-facing booking form. Every message here is
 *  shown to a parent on their phone, so they are specific and in Hebrew. */

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.field = field ?? null;
  }
}

/** Trimmed, with runs of whitespace collapsed. */
export function text(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Israeli mobile numbers, however the parent typed them. Returns the E.164
 * digits (972…) used for Morning and for wa.me links, plus a local form for
 * display. Landlines are accepted too: businesses call parents back on them.
 */
export function normalizePhone(input, { field = 'phone' } = {}) {
  const digits = String(input ?? '').replace(/\D/g, '');
  let local;
  if (digits.startsWith('972')) local = `0${digits.slice(3)}`;
  else if (digits.startsWith('0')) local = digits;
  else if (digits.length === 9) local = `0${digits}`;
  else local = digits;

  if (!/^0(5\d|[2-489]|7\d)\d{7}$/.test(local)) {
    throw new ValidationError('מספר הטלפון לא נראה תקין. לדוגמה: 050-1234567', field);
  }
  return { local, e164: `972${local.slice(1)}` };
}

/** The standard Israeli ID check digit. Only applied to 9-digit values, so a
 *  passport number or a foreign ID still goes through. */
export function isValidIsraeliId(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 9) return null; // not an Israeli ID, nothing to check
  const sum = [...digits].reduce((acc, char, index) => {
    const doubled = Number(char) * (index % 2 === 0 ? 1 : 2);
    return acc + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return sum % 10 === 0;
}

export function requireText(value, { field, label, min = 2, max = 120 }) {
  const cleaned = text(value);
  if (cleaned.length < min) throw new ValidationError(`${label} חסר או קצר מדי`, field);
  if (cleaned.length > max) throw new ValidationError(`${label} ארוך מדי`, field);
  return cleaned;
}

export function optionalText(value, max = 600) {
  return text(value).slice(0, max);
}

export function validEmail(value, { required = false } = {}) {
  const cleaned = text(value).toLowerCase();
  if (!cleaned) {
    if (required) throw new ValidationError('כתובת דוא"ל חסרה', 'email');
    return '';
  }
  // Deliberately loose: the only authority on a deliverable address is a
  // delivery attempt, and Morning emails the invoice itself.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(cleaned)) {
    throw new ValidationError('כתובת הדוא"ל לא נראית תקינה', 'email');
  }
  return cleaned;
}

/**
 * Validate and normalise the whole booking payload against the tenant's live
 * config, so a crafted request cannot book a day that is not on offer or skip
 * the health declaration.
 *
 * Which config is the point. The caller resolves the tenant from the URL and
 * loads that tenant's config, so a request carrying another business's week id
 * fails here with "לא נבחר שבוע" rather than booking across the boundary. The
 * weeks of one tenant simply do not exist in another's `weekById`.
 */
export function validateBookingPayload(camp, body) {
  if (!body || typeof body !== 'object') throw new ValidationError('הבקשה ריקה');

  const parentName = requireText(body.parent?.name, { field: 'parent.name', label: 'שם ההורה' });
  const phone = normalizePhone(body.parent?.phone, { field: 'parent.phone' });
  const email = validEmail(body.parent?.email, { required: true });
  const idNumber = requireText(body.parent?.idNumber, {
    field: 'parent.idNumber', label: 'מספר זהות', min: 5, max: 20,
  });
  if (isValidIsraeliId(idNumber) === false) {
    throw new ValidationError('מספר הזהות אינו תקין: בדקו את הספרות', 'parent.idNumber');
  }

  const rawChildren = Array.isArray(body.children) ? body.children : [];
  if (rawChildren.length === 0) throw new ValidationError('צריך להוסיף לפחות ילד/ה אחד', 'children');
  if (rawChildren.length > 10) throw new ValidationError('אפשר לרשום עד 10 ילדים בהרשמה אחת', 'children');

  const children = rawChildren.map((child, index) => {
    const field = `children.${index}`;
    const childName = requireText(child?.childName, {
      field: `${field}.childName`, label: `שם הילד/ה ${index + 1}`,
    });
    const week = camp.weekById(String(child?.weekId ?? ''));
    if (!week) throw new ValidationError(`לא נבחר שבוע עבור ${childName}`, `${field}.weekId`);

    const days = [...new Set(Array.isArray(child?.days) ? child.days.map(String) : [])].sort();
    if (days.length === 0) throw new ValidationError(`לא נבחרו ימים עבור ${childName}`, `${field}.days`);
    const unknown = days.filter((d) => !week.days.includes(d));
    if (unknown.length > 0) {
      throw new ValidationError(`ימים שאינם חלק מ${week.label}: ${unknown.join(', ')}`, `${field}.days`);
    }
    return {
      childName,
      childGrade: optionalText(child?.childGrade, 40),
      weekId: week.id,
      days,
    };
  });

  if (body.answers?.healthDeclaration !== true) {
    throw new ValidationError('חייבים לאשר את הצהרת הבריאות כדי להשלים את ההרשמה', 'answers.healthDeclaration');
  }
  if (body.answers?.terms !== true) {
    throw new ValidationError('חייבים לאשר את תנאי ההרשמה', 'answers.terms');
  }

  const answers = {
    healthDeclaration: true,
    terms: true,
    photoConsent: body.answers?.photoConsent === true,
    allergies: optionalText(body.answers?.allergies),
    pickup: optionalText(body.answers?.pickup, 200),
  };

  if (typeof body.signature !== 'string' || body.signature.length < 100) {
    throw new ValidationError('חסרה חתימה', 'signature');
  }

  return {
    parent: { name: parentName, phone: phone.e164, phoneLocal: phone.local, email, idNumber },
    children,
    answers,
    signature: body.signature,
    termsVersion: text(body.termsVersion),
  };
}

/** The subset needed to price a cart, for the live total on the booking page. */
export function validateQuotePayload(camp, body) {
  const raw = Array.isArray(body?.children) ? body.children : [];
  if (raw.length === 0 || raw.length > 10) throw new ValidationError('רשימת הילדים אינה תקינה', 'children');

  return raw.map((child, index) => {
    const week = camp.weekById(String(child?.weekId ?? ''));
    if (!week) throw new ValidationError('שבוע לא מוכר', `children.${index}.weekId`);
    const days = [...new Set(Array.isArray(child?.days) ? child.days.map(String) : [])]
      .filter((day) => week.days.includes(day))
      .sort();
    if (days.length === 0) throw new ValidationError('לא נבחרו ימים', `children.${index}.days`);
    return {
      childName: text(child?.childName).slice(0, 120) || 'ילד/ה',
      childGrade: text(child?.childGrade).slice(0, 40),
      weekId: week.id,
      days,
    };
  });
}
