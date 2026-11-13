// ============================================================
//  date-input.js  —  Fleet Manager
//  Zajednička logika za SVA polja za datum u aplikaciji:
//   • tekstualno polje sa maskom dd.mm.gggg (format je isti za sve
//     korisnike, bez obzira na jezik/region browsera),
//   • jasno istaknuto dugme sa kalendarom na desnoj strani polja
//     (klik otvara kalendar, izabrani dan se upisuje u polje),
//   • provera datuma (npr. 31.09.2026 ne postoji) sa porukom ISPOD
//     polja, crvenim okvirom i fokusom na prvo pogrešno polje.
//
//  Ranije su toDMY / parseDMY / attachDateMask bili kopirani u
//  reports.js, vehicles.js, assignments.js i dashboard.js — sada
//  postoji samo ova jedna verzija.
// ============================================================

import { t, getCurrentLang } from "./i18n.js";

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// ── FORMATIRANJE / PARSIRANJE ─────────────────────────────────
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date | Firestore Timestamp | string → "dd.mm.gggg" ("" ako je prazno/nevažeće) */
export function toDMY(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function todayDMY() {
  return toDMY(new Date());
}

/** Placeholder prati jezik aplikacije (dd/mm je fiksno, menja se samo "godina"). */
export function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd.mm.yyyy" : "dd.mm.gggg";
}

/** Date → "gggg-mm-dd" po LOKALNOM vremenu (bez UTC pomeranja kao toISOString). */
export function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Detaljna provera teksta datuma.
 * Vraća { empty, ok, date, code, params } — `code` je jedan od:
 * "format" | "year" | "month" | "day_range" | "day" (dan ne postoji u tom mesecu).
 */
export function inspectDMY(str) {
  const s = String(str ?? "").trim();
  if (!s) return { empty: true, ok: false, date: null, code: null, params: {} };

  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\.?$/);
  if (!m) return { empty: false, ok: false, date: null, code: "format", params: {} };

  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);

  if (year < MIN_YEAR || year > MAX_YEAR) {
    return { empty: false, ok: false, date: null, code: "year", params: { min: MIN_YEAR, max: MAX_YEAR } };
  }
  if (month < 1 || month > 12) {
    return { empty: false, ok: false, date: null, code: "month", params: {} };
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1) {
    return { empty: false, ok: false, date: null, code: "day_range", params: { days: daysInMonth } };
  }
  if (day > daysInMonth) {
    const locale = getCurrentLang() === "en" ? "en-GB" : "sr-Latn-RS";
    const monthName = new Date(year, month - 1, 1).toLocaleDateString(locale, { month: "long" });
    return { empty: false, ok: false, date: null, code: "day", params: { month: monthName, year, days: daysInMonth } };
  }

  return { empty: false, ok: true, date: new Date(year, month - 1, day), code: null, params: {} };
}

/** Strogo parsiranje: Date ili null (npr. 31.09.2026 → null). */
export function parseDMY(str) {
  const r = inspectDMY(str);
  return r.ok ? r.date : null;
}

function messageFor(result) {
  return t("date_err_" + result.code, result.params);
}

// ── GREŠKE NA POLJU ───────────────────────────────────────────
function resolveEl(target) {
  return typeof target === "string" ? document.getElementById(target) : target;
}

function errorHost(el) {
  return el.closest(".date-field") || el;
}

export function clearDateError(target) {
  const el = resolveEl(target);
  if (!el) return;
  el.classList.remove("input--error");
  el.removeAttribute("aria-invalid");
  const scope = errorHost(el).parentElement;
  scope?.querySelectorAll(`.field-error-msg[data-date-err="${el.id}"]`).forEach(n => n.remove());
}

/** Prikaži poruku ispod polja (crveni okvir). focus=true → fokus + scroll do polja. */
export function setDateError(target, message, { focus = false } = {}) {
  const el = resolveEl(target);
  if (!el) return;
  clearDateError(el);
  el.classList.add("input--error");
  el.setAttribute("aria-invalid", "true");

  const msg = document.createElement("span");
  msg.className = "field-error-msg";
  msg.dataset.dateErr = el.id;
  msg.setAttribute("role", "alert");
  msg.textContent = message;
  errorHost(el).insertAdjacentElement("afterend", msg);

  if (focus) {
    el.focus();
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
}

/**
 * Pročitaj i proveri jedno polje.
 * Vraća { ok, date, message }. Prazno polje je ok (date = null) osim ako je required.
 * Pri grešci odmah prikazuje poruku ispod polja.
 */
export function readDateField(id, { required = false, requiredMessage = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return { ok: true, date: null, message: null };

  const r = inspectDMY(el.value);
  if (r.empty) {
    if (required) {
      const message = requiredMessage || t("date_err_required");
      setDateError(el, message);
      return { ok: false, date: null, message };
    }
    clearDateError(el);
    return { ok: true, date: null, message: null };
  }
  if (!r.ok) {
    const message = messageFor(r);
    setDateError(el, message);
    return { ok: false, date: null, message };
  }
  clearDateError(el);
  return { ok: true, date: r.date, message: null };
}

/**
 * Proveri više polja odjednom.
 * specs: [{ id, required, requiredMessage? }]
 * Sva pogrešna polja dobijaju poruku, fokus ide na PRVO pogrešno.
 * Vraća { ok, values: { [id]: Date|null }, firstMessage }.
 */
export function collectDates(specs) {
  const values = {};
  let ok = true;
  let firstBadId = null;
  let firstMessage = null;

  for (const spec of specs) {
    const r = readDateField(spec.id, {
      required: !!spec.required,
      requiredMessage: spec.requiredMessage || null,
    });
    values[spec.id] = r.date;
    if (!r.ok) {
      ok = false;
      if (!firstBadId) { firstBadId = spec.id; firstMessage = r.message; }
    }
  }

  if (firstBadId) {
    const el = document.getElementById(firstBadId);
    el?.focus();
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
  return { ok, values, firstMessage };
}

// ── MASKA + KALENDAR ──────────────────────────────────────────
const CALENDAR_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2"></rect>
    <path d="M16 2v4M8 2v4M3 10h18"></path>
  </svg>`;

/**
 * Pretvara obično tekstualno polje (već u DOM-u) u polje za datum:
 *  - maska dd.mm.gggg dok korisnik kuca,
 *  - dugme sa kalendarom na desnoj strani,
 *  - provera pri napuštanju polja (blur).
 * Poziva se po ID-u, posle renderovanja forme (isto kao ranije).
 */
export function attachDateMask(id) {
  const el = document.getElementById(id);
  if (!el || el.dataset.dateField === "1") return;
  el.dataset.dateField = "1";

  el.setAttribute("autocomplete", "off");
  el.setAttribute("inputmode", "numeric");
  el.setAttribute("maxlength", "10");
  if (!el.getAttribute("placeholder")) el.setAttribute("placeholder", datePlaceholder());

  // Omotač: polje + dugme sa kalendarom + skriveni nativni birač datuma
  const wrap = document.createElement("div");
  wrap.className = "date-field";
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);

  const native = document.createElement("input");
  native.type = "date";
  native.className = "date-field__native";
  native.tabIndex = -1;
  native.setAttribute("aria-hidden", "true");
  native.min = `${MIN_YEAR}-01-01`;
  native.max = `${MAX_YEAR}-12-31`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "date-field__btn";
  btn.title = t("date_pick");
  btn.setAttribute("aria-label", t("date_pick"));
  btn.innerHTML = CALENDAR_SVG;
  btn.disabled = el.disabled;

  wrap.append(native, btn);

  // Maska dok se kuca
  el.addEventListener("input", () => {
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    el.value = out;
    clearDateError(el); // dok korisnik ispravlja, stara greška nestaje
  });

  // Nalepljen datum (5.9.2026, 05/09/2026, 2026-09-05) → dd.mm.gggg
  el.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") ?? "";
    const dmy = text.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\.?$/);
    const iso = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let out = null;
    if (dmy) out = `${pad2(dmy[1])}.${pad2(dmy[2])}.${dmy[3]}`;
    else if (iso) out = `${pad2(iso[3])}.${pad2(iso[2])}.${iso[1]}`;
    if (!out) return; // ostalo prepusti maski
    e.preventDefault();
    el.value = out;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Provera kad korisnik napusti polje (ne dok kuca)
  const validateOnLeave = () => {
    const r = inspectDMY(el.value);
    if (r.empty || r.ok) clearDateError(el);
    else setDateError(el, messageFor(r));
  };
  el.addEventListener("blur", validateOnLeave);
  el.addEventListener("change", validateOnLeave);

  // Klik na kalendar
  btn.addEventListener("click", () => {
    const r = inspectDMY(el.value);
    native.value = r.ok ? toISODate(r.date) : "";
    try {
      native.showPicker();
    } catch {
      // Stariji browseri bez showPicker() — probaj običan fokus/klik
      native.focus();
      native.click();
    }
  });

  // Izabran dan u kalendaru → upiši u polje u formatu dd.mm.gggg
  native.addEventListener("change", () => {
    const m = native.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return;
    el.value = `${m[3]}.${m[2]}.${m[1]}`;
    clearDateError(el);
    // Isti događaji kao da je korisnik ukucao datum — drugi listeneri
    // (npr. automatski prepis isteka registracije u istek osiguranja) rade i dalje.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();
  });
}

// ============================================================
//  DATUM + VREME (24h) i samo VREME
//  Nativni <input type="datetime-local"> / <input type="time"> prikazuju
//  format po jeziku/regionu browsera ili sistema (npr. 11/09/2026 12:41 PM).
//  Zato se ta polja zamenjuju tekstualnim poljem sa maskom:
//    datum + vreme: dd.mm.gggg HH:MM:SS (24h)     vreme: HH:MM (24h)
//  Ostalo u aplikaciji se ne menja: .value polja datum+vreme i dalje
//  daje/prima "gggg-mm-ddTHH:MM:SS" (kako se čuva i kako šalje skener računa).
//  Polja se označavaju atributima data-datetime="1" i data-timefield="1";
//  pripremu radi initDateTimeFields() (jednom, iz app.js).
// ============================================================
const INPUT_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
const rawGet = (el) => INPUT_VALUE.get.call(el);
const rawSet = (el, v) => INPUT_VALUE.set.call(el, v);

export function dateTimePlaceholder() {
  return getCurrentLang() === "en" ? "dd.mm.yyyy hh:mm:ss" : "dd.mm.gggg čč:mm:ss";
}

const ISO_DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** Date | Firestore Timestamp | ISO string → "dd.mm.gggg HH:MM:SS" ("" ako je prazno/nevažeće) */
export function toDMYHMS(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : (val instanceof Date ? val : new Date(val));
  if (isNaN(d)) return "";
  return `${toDMY(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ISO ("2026-11-09T12:41:40") → prikaz "09.11.2026 12:41:40"; sve ostalo ostaje kako jeste
function isoToDisplay(v) {
  const s = String(v ?? "").trim();
  const m = s.match(ISO_DT_RE);
  if (!m) return s;
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6] || "00"}`;
}

/**
 * Provera teksta "dd.mm.gggg HH:MM[:SS]".
 * Vraća { empty, ok, iso, code, params } — code: "format" | "year" | "month" |
 * "day_range" | "day" (greške datuma), "dt_format" ili "time_range".
 */
export function inspectDateTime(str) {
  const s = String(str ?? "").trim();
  if (!s) return { empty: true, ok: false, iso: null, code: null, params: {} };

  const m = s.match(/^(\d{1,2}[./-]\d{1,2}[./-]\d{4})\.?[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return { empty: false, ok: false, iso: null, code: "dt_format", params: {} };

  const dr = inspectDMY(m[1]);
  if (!dr.ok) return { empty: false, ok: false, iso: null, code: dr.code, params: dr.params };

  const hh = Number(m[2]), mi = Number(m[3]), ss = m[4] == null ? 0 : Number(m[4]);
  if (hh > 23 || mi > 59 || ss > 59) {
    return { empty: false, ok: false, iso: null, code: "time_range", params: {} };
  }
  return {
    empty: false, ok: true, code: null, params: {},
    iso: `${toISODate(dr.date)}T${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`,
  };
}

function dateTimeMessage(r) {
  if (r.code === "dt_format") return t("datetime_err_format");
  if (r.code === "time_range") return t("time_err_range");
  return t("date_err_" + r.code, r.params);
}

function maskDateTime(raw) {
  const d = String(raw).replace(/\\D/g, "").slice(0, 14);
  let out = d.slice(0, 2);
  if (d.length > 2) out += "." + d.slice(2, 4);
  if (d.length > 4) out += "." + d.slice(4, 8);
  if (d.length > 8) out += " " + d.slice(8, 10);
  if (d.length > 10) out += ":" + d.slice(10, 12);
  if (d.length > 12) out += ":" + d.slice(12, 14);
  return out;
}

/** Pretvara polje (type datetime-local ili text) u polje "dd.mm.gggg HH:MM:SS". */
export function attachDateTimeMask(target) {
  const el = resolveEl(target);
  if (!el || el.dataset.dateTimeField === "1") return;
  el.dataset.dateTimeField = "1";

  const initial = rawGet(el); // pre promene tipa (datetime-local ga vraća kao ISO)
  if (el.type !== "text") el.type = "text";
  el.removeAttribute("step");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("inputmode", "numeric");
  el.setAttribute("maxlength", "19");
  if (!el.getAttribute("placeholder")) el.setAttribute("placeholder", dateTimePlaceholder());

  // .value: spolja uvek ISO ("" ako je prazno ili neispravno), u polju se vidi dd.mm.gggg HH:MM:SS
  Object.defineProperty(el, "value", {
    configurable: true,
    get() {
      const r = inspectDateTime(rawGet(el));
      return r.ok ? r.iso : "";
    },
    set(v) { rawSet(el, isoToDisplay(v)); },
  });
  rawSet(el, isoToDisplay(initial));

  const wrap = document.createElement("div");
  wrap.className = "date-field";
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);

  const native = document.createElement("input");
  native.type = "date";
  native.className = "date-field__native";
  native.tabIndex = -1;
  native.setAttribute("aria-hidden", "true");
  native.min = `${MIN_YEAR}-01-01`;
  native.max = `${MAX_YEAR}-12-31`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "date-field__btn";
  btn.title = t("date_pick");
  btn.setAttribute("aria-label", t("date_pick"));
  btn.innerHTML = CALENDAR_SVG;
  btn.disabled = el.disabled;
  wrap.append(native, btn);

  const fire = () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  el.addEventListener("input", () => {
    rawSet(el, maskDateTime(rawGet(el)));
    clearDateError(el);
  });

  // Nalepljeno: gggg-mm-ddTHH:MM:SS ili dd.mm.gggg HH:MM:SS (i sa kosim crtama)
  el.addEventListener("paste", (e) => {
    const text = ((e.clipboardData || window.clipboardData)?.getData("text") ?? "").trim();
    const shown = isoToDisplay(text);
    const r = inspectDateTime(shown);
    if (!r.ok) return; // ostalo prepusti maski
    e.preventDefault();
    rawSet(el, toDMYHMS(r.iso));
    clearDateError(el);
    fire();
  });

  const validateOnLeave = () => {
    const r = inspectDateTime(rawGet(el));
    if (r.empty || r.ok) clearDateError(el);
    else setDateError(el, dateTimeMessage(r));
  };
  el.addEventListener("blur", validateOnLeave);
  el.addEventListener("change", validateOnLeave);

  // Kalendar bira samo DAN — vreme ostaje ono što je ukucano (ili trenutno vreme)
  btn.addEventListener("click", () => {
    const r = inspectDateTime(rawGet(el));
    native.value = r.ok ? r.iso.slice(0, 10) : "";
    try { native.showPicker(); } catch { native.focus(); native.click(); }
  });
  native.addEventListener("change", () => {
    const m = native.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return;
    const old = rawGet(el).match(/[ T]+(\d{1,2}:\d{2}(?::\d{2})?)\\s*$/);
    const now = new Date();
    const time = old ? old[1] : `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    rawSet(el, `${m[3]}.${m[2]}.${m[1]} ${time}`);
    clearDateError(el);
    fire();
    el.focus();
  });
}

/** Proveri polje datum+vreme: { ok, iso, message }. Pri grešci prikazuje poruku ispod polja. */
export function readDateTimeField(id, { required = false, requiredMessage = null, focus = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return { ok: true, iso: null, message: null };
  const r = inspectDateTime(rawGet(el));
  if (r.empty) {
    if (required) {
      const message = requiredMessage || t("datetime_err_required");
      setDateError(el, message, { focus });
      return { ok: false, iso: null, message };
    }
    clearDateError(el);
    return { ok: true, iso: null, message: null };
  }
  if (!r.ok) {
    const message = dateTimeMessage(r);
    setDateError(el, message, { focus });
    return { ok: false, iso: null, message };
  }
  clearDateError(el);
  return { ok: true, iso: r.iso, message: null };
}

/** Proveri SVA polja datum+vreme u dokumentu (ili u `root`). false = neko je neispravno (fokus na prvo). */
export function validateDateTimeFields(root = document) {
  let ok = true;
  root.querySelectorAll("[data-datetime]").forEach((el) => {
    if (!el.id) return;
    const r = readDateTimeField(el.id, { focus: ok }); // fokus samo na prvo pogrešno
    if (!r.ok) ok = false;
  });
  return ok;
}

// ── SAMO VREME (HH:MM, 24h) ───────────────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Pretvara polje (type time ili text) u tekstualno polje HH:MM sa maskom (24h, bez AM/PM). */
export function attachTimeMask(target) {
  const el = resolveEl(target);
  if (!el || el.dataset.timeMask === "1") return;
  el.dataset.timeMask = "1";

  const initial = rawGet(el);
  if (el.type !== "text") el.type = "text";
  el.removeAttribute("step");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("inputmode", "numeric");
  el.setAttribute("maxlength", "5");
  if (!el.getAttribute("placeholder")) el.setAttribute("placeholder", "HH:MM");
  rawSet(el, String(initial || "").slice(0, 5));

  // Samo cifre, dvotačka se dodaje sama; prva cifra veća od 2 dobija nulu (9 → 09:)
  el.addEventListener("input", () => {
    let digits = rawGet(el).replace(/\\D/g, "");
    if (digits.length >= 1 && Number(digits[0]) > 2) digits = "0" + digits;
    digits = digits.slice(0, 4);
    rawSet(el, digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits);
    clearDateError(el);
  });
  el.addEventListener("blur", () => {
    const v = rawGet(el).trim();
    if (!v || TIME_RE.test(v)) clearDateError(el);
    else setDateError(el, t("service_time_invalid"));
  });
}

/** Proveri polje HH:MM: { ok, value, message }. Prazno je ok osim ako je required. */
export function readTimeField(id, { required = false, requiredMessage = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return { ok: true, value: "", message: null };
  const v = String(el.value || "").trim();
  if (!v) {
    if (required) {
      const message = requiredMessage || t("service_time_required");
      setDateError(el, message, { focus: true });
      return { ok: false, value: "", message };
    }
    clearDateError(el);
    return { ok: true, value: "", message: null };
  }
  if (!TIME_RE.test(v)) {
    const message = t("service_time_invalid");
    setDateError(el, message, { focus: true });
    return { ok: false, value: v, message };
  }
  clearDateError(el);
  return { ok: true, value: v, message: null };
}

// ── AUTOMATSKO POVEZIVANJE ────────────────────────────────────
// Forme se crtaju dinamički (modali), pa se polja označena sa
// data-datetime / data-timefield povezuju čim se pojave u DOM-u.
export function initDateTimeFields() {
  if (initDateTimeFields.done) return;
  initDateTimeFields.done = true;
  const scan = (root) => {
    if (!root.querySelectorAll) return;
    if (root.matches?.("[data-datetime]")) attachDateTimeMask(root);
    if (root.matches?.("[data-timefield]")) attachTimeMask(root);
    root.querySelectorAll("[data-datetime]").forEach(attachDateTimeMask);
    root.querySelectorAll("[data-timefield]").forEach(attachTimeMask);
  };
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
}
