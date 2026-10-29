/* Parent-facing booking flow. Vanilla on purpose: this page has to keep working
   for years with no toolchain, and it runs on whatever phone a parent has.

   Every request goes to CAMP.base, the tenant's own path prefix, which the
   server put in the boot payload. One process serves every business, so a
   hard-coded "/api/quote" here would be a request that could land on another
   business's booking page. */
(function () {
  'use strict';

  var CAMP = window.CAMP;
  var app = document.getElementById('app');
  var bar = document.getElementById('bar');
  var barAmount = document.getElementById('barAmount');
  var submitButton = document.getElementById('submit');

  var state = {
    children: [],
    signature: null,
    quote: null,
    submitting: false,
  };
  var nextChildId = 1;

  // ─────────────────────────── helpers ───────────────────────────

  function api(path) { return CAMP.base + path; }

  function money(amount) {
    try {
      return new Intl.NumberFormat('he-IL', {
        style: 'currency', currency: CAMP.currency, maximumFractionDigits: 0,
      }).format(amount);
    } catch (e) {
      return amount + ' ' + CAMP.currency;
    }
  }

  function dayParts(iso) {
    var date = new Date(iso + 'T00:00:00');
    return {
      dow: new Intl.DateTimeFormat('he-IL', { weekday: 'long' }).format(date).replace('יום ', ''),
      short: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric' }).format(date),
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }
  function value(id) { var node = el(id); return node ? node.value.trim() : ''; }
  function checked(id) { var node = el(id); return node ? node.checked : false; }

  function showError(message) {
    var box = el('formError');
    box.textContent = message;
    box.hidden = !message;
    if (message) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ───────────────────────── children + days ─────────────────────────

  function addChild() {
    state.children.push({ id: nextChildId++, childName: '', childGrade: '', weekId: null, days: [] });
    renderChildren();
    requestQuote();
  }

  function removeChild(id) {
    state.children = state.children.filter(function (c) { return c.id !== id; });
    if (state.children.length === 0) addChild();
    else { renderChildren(); requestQuote(); }
  }

  function childById(id) {
    return state.children.filter(function (c) { return c.id === id; })[0];
  }

  /** A child books inside one week: the weekly price only means anything per
      week, and in practice a parent picks days from the week they need. */
  function toggleDay(child, weekId, date, button) {
    if (child.weekId && child.weekId !== weekId) {
      child.days = [];
      child.weekId = weekId;
      Array.prototype.forEach.call(
        document.querySelectorAll('[data-child="' + child.id + '"] .day'),
        function (other) { other.setAttribute('aria-pressed', 'false'); },
      );
    } else {
      child.weekId = weekId;
    }

    var index = child.days.indexOf(date);
    if (index === -1) child.days.push(date);
    else child.days.splice(index, 1);

    if (child.days.length === 0) child.weekId = null;
    button.setAttribute('aria-pressed', index === -1 ? 'true' : 'false');
    updateChildSummary(child);
    requestQuote();
  }

  function selectWholeWeek(child, week) {
    var available = week.days.filter(function (d) { return d.remaining === null || d.remaining > 0; });
    child.weekId = week.id;
    child.days = available.map(function (d) { return d.date; });
    renderChildren();
    requestQuote();
  }

  function updateChildSummary(child) {
    var node = document.querySelector('[data-summary="' + child.id + '"]');
    if (!node) return;
    node.textContent = child.days.length === 0
      ? 'לא נבחרו ימים'
      : child.days.length + (child.days.length === 1 ? ' יום נבחר' : ' ימים נבחרו');
  }

  function renderChildren() {
    var html = state.children.map(function (child, index) {
      var weeks = CAMP.weeks.map(function (week) {
        var dayButtons = week.days.map(function (day) {
          var parts = dayParts(day.date);
          var full = day.remaining !== null && day.remaining <= 0;
          var picked = child.weekId === week.id && child.days.indexOf(day.date) !== -1;
          var seats = full
            ? 'מלא'
            : (day.remaining !== null && day.remaining <= 5 ? 'נותרו ' + day.remaining : '');
          return '<button type="button" class="day" data-week="' + escapeHtml(week.id) + '"'
            + ' data-date="' + escapeHtml(day.date) + '" aria-pressed="' + (picked ? 'true' : 'false') + '"'
            + (full ? ' disabled' : '') + '>'
            + '<span class="dow">' + escapeHtml(parts.dow) + '</span>'
            + '<span class="date">' + escapeHtml(parts.short) + '</span>'
            + '<span class="seats">' + escapeHtml(seats) + '</span>'
            + '</button>';
        }).join('');

        return '<div class="week-head"><h3>' + escapeHtml(week.label) + '</h3>'
          + '<button type="button" class="linkish" data-whole-week="' + escapeHtml(week.id) + '">כל השבוע</button>'
          + '</div><div class="days">' + dayButtons + '</div>';
      }).join('');

      return '<div class="child" data-child="' + child.id + '">'
        + '<div class="child-head"><strong>ילד/ה ' + (index + 1) + '</strong>'
        + (state.children.length > 1
          ? '<button type="button" class="linkish" data-remove="' + child.id + '">הסרה</button>' : '')
        + '</div>'
        + '<label>שם הילד/ה<input type="text" data-field="childName" data-id="' + child.id
        + '" value="' + escapeHtml(child.childName) + '" autocomplete="off" placeholder="שם פרטי ומשפחה"></label>'
        + '<label>כיתה <span class="hint">(לא חובה)</span>'
        + '<input type="text" data-field="childGrade" data-id="' + child.id
        + '" value="' + escapeHtml(child.childGrade) + '" autocomplete="off" placeholder="לדוגמה: ב&#39;"></label>'
        + '<label>הימים<span class="hint" data-summary="' + child.id + '"></span></label>'
        + weeks
        + '</div>';
    }).join('');

    el('childrenList').innerHTML = html
      + '<button type="button" class="linkish" id="addChild">+ הוספת ילד/ה נוסף</button>';

    state.children.forEach(updateChildSummary);
  }

  // ───────────────────────────── quote ─────────────────────────────

  var quoteTimer = null;
  function requestQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(sendQuote, 220);
  }

  /** The children that can actually be booked, in the shape the API wants.
      `childName` is the raw value, not a placeholder: submit() refuses an
      unnamed child, and the quote endpoint fills its own placeholder, so
      substituting one here would send a name nobody typed. */
  function bookableChildren() {
    return state.children
      .filter(function (c) { return c.weekId && c.days.length > 0; })
      .map(function (c) {
        return {
          childName: c.childName.trim(),
          childGrade: c.childGrade.trim(),
          weekId: c.weekId,
          days: c.days.slice().sort(),
        };
      });
  }

  function sendQuote() {
    var children = bookableChildren();
    if (children.length === 0) {
      state.quote = null;
      renderTotal();
      return;
    }
    fetch(api('/api/quote'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ children: children }),
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data.error) { showError(data.error); return; }
        state.quote = data;
        renderTotal();
      })
      .catch(function () { /* a failed quote is not fatal: the server prices again on submit */ });
  }

  function renderTotal() {
    var box = el('totalBox');
    if (!state.quote) {
      box.innerHTML = '<div class="total-line">בחרו ימים כדי לראות את המחיר</div>';
      bar.hidden = true;
      return;
    }
    var lines = state.quote.items.map(function (item) {
      var label = item.mode === 'daily' ? item.dayCount + ' ימים' : 'שבוע שלם';
      return '<div class="total-line"><span>' + escapeHtml(item.childName) + ' · ' + label + '</span>'
        + '<span>' + escapeHtml(money(item.listAmount)) + '</span></div>'
        + (item.discount > 0
          ? '<div class="total-line saving"><span>הנחת אחים</span><span>-'
            + escapeHtml(money(item.discount)) + '</span></div>' : '')
        + (item.upgraded
          ? '<div class="total-line saving"><span>שודרג למחיר שבועי, כל ימי השבוע כלולים</span><span></span></div>' : '');
    }).join('');

    box.innerHTML = lines
      + (state.quote.savingsTotal > 0
        ? '<div class="total-line saving"><span>חסכתם</span><span>'
          + escapeHtml(money(state.quote.savingsTotal)) + '</span></div>' : '')
      + '<div class="total-line big"><span>סה"כ</span><span>'
        + escapeHtml(money(state.quote.total)) + '</span></div>';

    barAmount.textContent = money(state.quote.total);
    bar.hidden = false;
  }

  // ─────────────────────────── signature ───────────────────────────

  function setupSignature() {
    var canvas = el('sig');
    var context = canvas.getContext('2d');
    var drawing = false;
    var dirty = false;

    function resize() {
      var ratio = window.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      var data = dirty ? canvas.toDataURL('image/png') : null;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.scale(ratio, ratio);
      context.lineWidth = 2.2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#12161c';
      if (data) {
        var image = new Image();
        image.onload = function () { context.drawImage(image, 0, 0, rect.width, rect.height); };
        image.src = data;
      }
    }

    function point(event) {
      var rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', function (event) {
      drawing = true;
      dirty = true;
      canvas.setPointerCapture(event.pointerId);
      var p = point(event);
      context.beginPath();
      context.moveTo(p.x, p.y);
      // A tap with no movement should still leave a mark.
      context.lineTo(p.x + 0.1, p.y);
      context.stroke();
      el('sigHint').textContent = '';
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!drawing) return;
      var p = point(event);
      context.lineTo(p.x, p.y);
      context.stroke();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      canvas.addEventListener(name, function () {
        if (!drawing) return;
        drawing = false;
        state.signature = canvas.toDataURL('image/png');
      });
    });

    el('sigClear').addEventListener('click', function () {
      context.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
      state.signature = null;
      el('sigHint').textContent = 'חתמו באצבע במסגרת';
    });

    resize();
    window.addEventListener('resize', resize);
  }

  // ──────────────────────────── submit ────────────────────────────

  function submit() {
    if (state.submitting) return;
    showError('');

    var children = bookableChildren();
    if (children.length === 0) return showError('בחרו לפחות יום אחד');
    var unnamed = children.filter(function (c) { return !c.childName; });
    if (unnamed.length > 0) return showError('חסר שם של אחד הילדים');
    if (!value('parentName')) return showError('חסר שם ההורה');
    if (!value('parentId')) return showError('חסר מספר זהות');
    if (!value('parentPhone')) return showError('חסר מספר טלפון');
    if (!value('parentEmail')) return showError('חסרה כתובת דוא"ל, החשבונית נשלחת אליה');
    if (!checked('agreeTerms')) return showError('יש לאשר את תנאי ההרשמה');
    if (!checked('agreeHealth')) return showError('יש לאשר את הצהרת הבריאות');
    if (!state.signature) return showError('חסרה חתימה');

    state.submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'רק רגע...';

    fetch(api('/api/book'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent: {
          name: value('parentName'),
          idNumber: value('parentId'),
          phone: value('parentPhone'),
          email: value('parentEmail'),
        },
        children: children,
        answers: {
          terms: true,
          healthDeclaration: true,
          photoConsent: checked('agreePhoto'),
          allergies: value('allergies'),
          pickup: value('pickup'),
        },
        signature: state.signature,
        termsVersion: CAMP.termsVersion,
      }),
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok || !result.body.paymentUrl) {
          throw new Error(result.body.error || 'ההרשמה לא נשמרה. נסו שוב בעוד רגע.');
        }
        window.location.href = result.body.paymentUrl;
      })
      .catch(function (error) {
        state.submitting = false;
        submitButton.disabled = false;
        submitButton.textContent = 'המשך לתשלום';
        showError(error.message);
      });
  }

  // ───────────────────────────── layout ─────────────────────────────

  function render() {
    var facts = [];
    if (CAMP.hours) facts.push('<div>שעות: ' + escapeHtml(CAMP.hours) + '</div>');
    if (CAMP.location) facts.push('<div>מקום: ' + escapeHtml(CAMP.location) + '</div>');
    if (CAMP.includes) facts.push('<div>כולל: ' + escapeHtml(CAMP.includes) + '</div>');

    var termsList = CAMP.consent.terms.map(function (t) {
      return '<li>' + escapeHtml(t) + '</li>';
    }).join('');

    app.innerHTML =
      (CAMP.closed
        ? '<div class="notice">ההרשמה המקוונת נסגרה. שלחו לנו הודעה בוואטסאפ ונשמח לבדוק אם נשאר מקום.</div>'
        : '')
      + (facts.length ? '<div class="card facts">' + facts.join('') + '</div>' : '')

      + '<div class="card"><h2><span class="step-num">1</span>מי נרשם ולאילו ימים</h2>'
      + '<div id="childrenList"></div></div>'

      + '<div class="card"><h2><span class="step-num">2</span>פרטי ההורה</h2>'
      + '<label>שם מלא<input type="text" id="parentName" autocomplete="name"></label>'
      + '<label>מספר זהות <span class="hint">(לטופס החתום)</span>'
      + '<input type="text" id="parentId" autocomplete="off"></label>'
      + '<label>טלפון<input type="tel" id="parentPhone" inputmode="tel" autocomplete="tel" placeholder="050-1234567"></label>'
      + '<label>דוא"ל <span class="hint">(לכאן תישלח החשבונית)</span>'
      + '<input type="email" id="parentEmail" inputmode="email" autocomplete="email"></label></div>'

      + '<div class="card"><h2><span class="step-num">3</span>בריאות ואיסוף</h2>'
      + '<label>' + escapeHtml(CAMP.consent.allergiesPrompt)
      + '<textarea id="allergies" placeholder="אם אין, אפשר להשאיר ריק"></textarea></label>'
      + '<label>' + escapeHtml(CAMP.consent.pickupPrompt)
      + '<input type="text" id="pickup" autocomplete="off"></label></div>'

      + '<div class="card"><h2><span class="step-num">4</span>תנאים וחתימה</h2>'
      + '<div class="terms"><ul>' + termsList + '</ul>'
      + '<p><strong>ביטול:</strong> ' + escapeHtml(CAMP.cancellationPolicy) + '</p></div>'
      + '<label class="check"><input type="checkbox" id="agreeTerms">'
      + '<span>קראתי ואני מאשר/ת את תנאי ההרשמה ומדיניות הביטול</span></label>'
      + '<label class="check"><input type="checkbox" id="agreeHealth">'
      + '<span>' + escapeHtml(CAMP.consent.healthDeclaration) + '</span></label>'
      + (CAMP.consent.photoConsent
        ? '<label class="check"><input type="checkbox" id="agreePhoto">'
          + '<span>' + escapeHtml(CAMP.consent.photoConsent)
          + (CAMP.consent.photoConsentOptional ? ' <span class="hint">(לא חובה)</span>' : '')
          + '</span></label>'
        : '')
      + '<label>חתימת ההורה</label><canvas id="sig"></canvas>'
      + '<div class="sig-row"><span class="hint" id="sigHint">חתמו באצבע במסגרת</span>'
      + '<button type="button" class="linkish" id="sigClear">ניקוי</button></div></div>'

      + '<div class="card"><h2>סיכום</h2><div class="total" id="totalBox"></div>'
      + '<div class="error" id="formError" hidden></div></div>';

    renderChildren();
    renderTotal();
    setupSignature();
  }

  // One delegated listener for everything the day grids and child list produce.
  app.addEventListener('click', function (event) {
    var target = event.target.closest('button');
    if (!target) return;

    if (target.id === 'addChild') return addChild();
    if (target.dataset.remove) return removeChild(Number(target.dataset.remove));
    if (target.dataset.wholeWeek) {
      var childNode = target.closest('[data-child]');
      var week = CAMP.weeks.filter(function (w) { return w.id === target.dataset.wholeWeek; })[0];
      return selectWholeWeek(childById(Number(childNode.dataset.child)), week);
    }
    if (target.classList.contains('day')) {
      var owner = target.closest('[data-child]');
      return toggleDay(childById(Number(owner.dataset.child)), target.dataset.week, target.dataset.date, target);
    }
  });

  app.addEventListener('input', function (event) {
    var field = event.target.dataset.field;
    if (!field) return;
    var child = childById(Number(event.target.dataset.id));
    if (!child) return;
    child[field] = event.target.value;
    // So the summary says "יובל · 2 ימים" rather than the placeholder.
    if (field === 'childName' && child.days.length > 0) requestQuote();
  });

  submitButton.addEventListener('click', submit);

  render();
  addChild();
})();
