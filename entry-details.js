// ============================================================
//  entry-details.js  —  Fleet Manager
//  Detaljan prikaz (modal) za administratora voznog parka:
//   • točenje goriva / putarina / parking / pranje / ostali trošak
//   • vožnja
//   • zaduženje (sa vožnjama i unosima)
//   • vozač
//  Otvara se klikom na element sa jednim od atributa:
//   data-entry-id, data-detail-assignment, data-detail-trip,
//   data-detail-driver. Prikazuje SVE što se čuva pri unosu.
//  Vozači (rola "driver") vide samo detalje SVOJIH unosa (gorivo, putarina,
//  parking, pranje, ostalo, prijave) — bez detalja zaduženja/vožnje/vozača.
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, doc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, formatDateDMY, formatDateTimeDMY } from "./i18n.js";
import { S, openModal, showToast } from "./app.js";
import { fetchReceiptDetails, receiptWorkerConfigured } from "./receipt-scan.js";
import { esc, fmtNum, fmtRsd, toMillis, COST_TYPES, COST_META } from "./entries-view.js";
import {
  rememberEntry, rememberAssignment, rememberTrip,
  getRememberedEntry, getRememberedAssignment, getRememberedTrip,
  getRememberedService, getRememberedIncident, rememberService, rememberIncident,
} from "./detail-registry.js";
import { serviceTypeLabel, serviceDetailText, serviceWorkText } from "./service-types.js";
import { effectiveServiceStatus } from "./service-status.js";

const ICONS  = { fuel: "⛽", ...Object.fromEntries(COST_TYPES.map(k => [k, COST_META[k].icon])),
                 fault: "🔧", damage: "💥", accident: "🚨", other: "📋" };

export function isAdminViewer() {
  return S.profile?.role !== "driver";
}

// Detalje unosa (račun za gorivo i ostali troškovi) mogu da otvore svi —
// vozač vidi svoje unose (pravila baze mu ni ne daju tuđe preko upita).
export function canOpenEntryDetails() {
  return !!S.profile;
}

function typeLabel(type) {
  const map = {
    fuel: t("trip_entry_fuel"),
    ...Object.fromEntries(COST_TYPES.map(k => [k, t(COST_META[k].label)])),
  };
  if (map[type]) return map[type];
  const inc = t("incident_" + type);
  return inc && inc !== "incident_" + type ? inc : type;
}

// ── POMOĆNE ZA HTML ───────────────────────────────────────────
function rows(list) {
  const f = list.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (f.length === 0) return `<p class="empty-text">${t("no_data")}</p>`;
  return `<div class="detail-table">${f.map(([label, value, raw]) => `
    <div class="detail-row">
      <div class="detail-row__label">${esc(label)}</div>
      <div class="detail-row__value">${raw ? value : esc(value)}</div>
    </div>`).join("")}</div>`;
}

function section(title, html) {
  return `<div class="form-section-title detail-modal__section">${esc(title)}</div>${html}`;
}

function dt(val)   { return val ? formatDateTimeDMY(val) : null; }
function d(val)    { return val ? formatDateDMY(val) : null; }
function km(val)   { return val != null && val !== "" ? `${fmtNum(val)} km` : null; }
function fuelLvl(code) { return code ? t("fuel_level_" + code) : null; }

// Datum/vreme sa računa je string iz datetime-local ("2026-11-02T14:35:10")
function receiptDateTime(val) {
  if (!val) return null;
  const x = new Date(val);
  return isNaN(x) ? String(val) : formatDateTimeDMY(x);
}

function safeReceiptLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer" class="detail-link">${esc(u.hostname)} ↗</a>`;
  } catch { return null; }
}

// Klikabilan mali red unosa (koristi se u detaljima vožnje/zaduženja)
function entryMiniRow(e) {
  rememberEntry(e);
  const isFuel = e.type === "fuel";
  const isCost = COST_TYPES.includes(e.type);
  const main = isFuel
    ? `${fmtNum(e.fuelAmount, 2)} L · ${fmtRsd(e.fuelCost)}${e.fuelStation ? " · " + esc(e.fuelStation) : ""}`
    : isCost
      ? `${fmtRsd(e.amount)}${e.location ? " · " + esc(e.location) : ""}`
      : esc(e.description || "");
  return `
    <div class="detail-mini-row" data-entry-id="${esc(e.id)}" role="button" tabindex="0">
      <span class="detail-mini-row__icon">${ICONS[e.type] || "📋"}</span>
      <span class="detail-mini-row__type">${esc(typeLabel(e.type))}</span>
      <span class="detail-mini-row__main">${main}</span>
      <span class="detail-mini-row__date">${formatDateDMY(e.createdAt)}</span>
    </div>`;
}

function driverLink(name, driverId) {
  if (!driverId || !isAdminViewer()) return esc(name || "—");
  return `<a href="#" class="detail-link" data-detail-driver="${esc(driverId)}">${esc(name || "—")}</a>`;
}

// ── STEK MODALA (dugme "Nazad" kad se ide iz zaduženja u unos itd.) ──
let current = null;      // { title, html } trenutno prikazan detaljni modal
const stack = [];

function overlayOpen() {
  const ov = document.getElementById("modal-overlay");
  return !!ov && !ov.classList.contains("hidden");
}

function show(title, html) {
  if (current && overlayOpen()) stack.push(current);
  else stack.length = 0;
  render(title, html);
}

function render(title, html) {
  current = { title, html };
  const back = stack.length
    ? `<button type="button" class="btn btn--ghost btn--sm detail-modal__back" data-detail-back>${t("vehicle_back")}</button>`
    : "";
  openModal(title, back + html);
  const cancel = document.getElementById("modal-cancel");
  if (cancel) cancel.textContent = t("close");
}

function goBack() {
  const prev = stack.pop();
  if (prev) render(prev.title, prev.html);
}

// ── DETALJI UNOSA ─────────────────────────────────────────────
export function entryDetailHTML(e) {
  const common = [
    [t("assignment_vehicle"), e.vehiclePlate],
    [t("assignment_driver"),  e.driverName ? driverLink(e.driverName, e.driverId) : null, true],
    [t("det_entered_at"),     dt(e.createdAt)],
    [t("det_entered_by_admin"), e.enteredByAdmin ? (e.enteredByName || t("yes")) : null],
  ];

  if (e.type === "fuel") {
    return [
      section(t("det_section_fuel"), rows([
        [t("trip_fuel_type"),        e.fuelType ? t("fuel_" + e.fuelType) : null],
        [t("trip_fuel_amount"),      e.fuelAmount != null ? `${fmtNum(e.fuelAmount, 2)} L` : null],
        [t("trip_fuel_price"),       e.fuelCost != null ? fmtRsd(e.fuelCost) : null],
        [t("trip_fuel_price_per_l"), e.pricePerL ? `${fmtNum(e.pricePerL, 2)} RSD/L` : null],
        [t("det_km_at_entry"),       km(e.currentKm)],
      ])),
      itemsOrReload(e.receiptItems, "entry", e),
      section(t("det_section_station"), rows([
        [t("trip_fuel_station"),  e.fuelStation],
        [t("trip_fuel_address"),  e.fuelStationAddress],
        [t("det_station_pib"),    e.stationPib],
        [t("det_station_object"), e.stationObject],
        [t("det_station_contract"), e.fuelStationContracted === undefined || e.fuelStationContracted === null
          ? null : (e.fuelStationContracted ? t("yes") : t("trip_fuel_off_contract_badge"))],
      ])),
      section(t("det_section_receipt"), rows([
        [t("trip_fuel_receipt"),      e.receiptNo],
        [t("trip_fuel_receipt_time"), receiptDateTime(e.receiptTime)],
        [t("det_receipt_link"),       safeReceiptLink(e.receiptUrl), true],
        [t("det_receipt_source"),     e.receiptSource ? t(e.receiptSource === "qr" ? "det_source_qr" : "det_source_manual") : null],
      ])),
      section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
    ].join("");
  }

  if (COST_TYPES.includes(e.type)) {
    return [
      section(t("det_section_cost"), rows([
        [t("trip_cost_type").replace(" *", ""), typeLabel(e.type)],
        [t("trip_cost_amount").replace(" *", ""), e.amount != null ? fmtRsd(e.amount) : null],
        [t("trip_cost_merchant"),   e.merchant],
        [t("trip_cost_location").replace(" *", ""), e.location],
        [t("det_km_at_entry"),       km(e.currentKm)],
      ])),
      itemsOrReload(e.receiptItems, "entry", e),
      section(t("det_section_receipt"), rows([
        [t("trip_fuel_receipt"),      e.receiptNo],
        [t("trip_fuel_receipt_time"), receiptDateTime(e.receiptTime)],
        [t("det_receipt_link"),       safeReceiptLink(e.receiptUrl), true],
        [t("det_receipt_source"),     e.receiptSource ? t(e.receiptSource === "qr" ? "det_source_qr" : "det_source_manual") : null],
      ])),
      section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
    ].join("");
  }

  // prijave koje se čuvaju u tripEntries (kvar, oštećenje, nezgoda, ostalo)
  return [
    section(typeLabel(e.type), rows([
      [t("incident_description"), e.description],
      [t("incident_location"),    e.location],
      [t("det_km_at_entry"),      km(e.currentKm)],
    ])),
    section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
  ].join("");
}

// ── DETALJI SERVISA ───────────────────────────────────────────
const money2 = (v) => v != null && v !== "" && !isNaN(v)
  ? Number(v).toLocaleString("sr-RS", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : "—";

// Stavke sa računa: obični redovi (bez <table> i skrolujućeg omotača), da se
// u modalu uvek iscrtaju. Levo naziv, desno ukupno + "količina × cena".
function receiptItemsList(items) {
  const allTotals = items.length > 0 && items.every(it => it.total != null && !isNaN(it.total));
  const sum = allTotals ? items.reduce((a, it) => a + Number(it.total), 0) : null;
  const rowsHtml = items.map(it => {
    const calc = [
      it.quantity != null ? esc(fmtNum(it.quantity, 3)) : null,
      it.unitPrice != null && !isNaN(it.unitPrice) ? esc(money2(it.unitPrice)) : null,
    ].filter(Boolean).join(" × ");
    return `<div class="detail-item${it.fuelType ? " detail-item--fuel" : ""}">
      <div class="detail-item__name">${it.fuelType ? "⛽ " : ""}${esc(it.name || "—")}</div>
      <div class="detail-item__sum">
        <strong>${esc(money2(it.total))}</strong>
        ${calc ? `<small>${calc}</small>` : ""}
      </div>
    </div>`;
  }).join("");
  const totalRow = sum != null
    ? `<div class="detail-item detail-item--total">
         <div class="detail-item__name">${esc(t("det_items_sum"))}</div>
         <div class="detail-item__sum"><strong>${esc(money2(sum))}</strong></div>
       </div>`
    : "";
  return `<div class="detail-items-body">${rowsHtml}${totalRow}</div>`;
}

// Unos ima račun (receiptUrl) ali nema sačuvane stavke → administrator može
// da ih ponovo učita sa fiskalnog računa (radi dok je račun dostupan na portalu poreske uprave)
function itemsOrReload(items, kind, obj) {
  if (Array.isArray(items) && items.length) return itemsSection(items);
  if (!isAdminViewer() || !obj?.receiptUrl || !obj?.id || !receiptWorkerConfigured()) return "";
  return `<div class="detail-reload">
    <div class="form-section-title detail-modal__section">${esc(t("det_section_items"))}</div>
    <p class="empty-text">${esc(t("det_reload_hint"))}</p>
    <button type="button" class="btn btn--secondary btn--sm" data-reload-receipt="${kind}" data-id="${esc(obj.id)}">${esc(t("det_reload_btn"))}</button>
    <p class="detail-reload__status" role="status"></p>
  </div>`;
}

// Sekcija je uvek otvorena; klik na naslov je sklapa/otvara
function itemsSection(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<div class="detail-items-section">
    <div class="form-section-title detail-modal__section detail-items-toggle" data-toggle-items
      role="button" tabindex="0" aria-expanded="true">
      <span>${esc(t("det_section_items"))} (${items.length})</span><span class="detail-items-toggle__arrow">▾</span>
    </div>
    ${receiptItemsList(items)}
  </div>`;
}

function incidentLinkLabel(incidentId) {
  const inc = getRememberedIncident(incidentId);
  if (!inc) return t("det_open_incident");
  const type = ["fault", "damage", "accident", "other"].includes(inc.type) ? inc.type : "other";
  const desc = String(inc.description || "").replace(/\s+/g, " ").trim();
  return `${ICONS[type]} ${t("incident_" + type)}${desc ? ": " + (desc.length > 70 ? desc.slice(0, 70) + "…" : desc) : ""}`;
}

export function serviceDetailHTML(s) {
  const status = effectiveServiceStatus(s);
  const items = Array.isArray(s.receiptItems) ? s.receiptItems : [];
  const work = serviceWorkText(s);
  return [
    s.incidentId ? section(t("det_section_from_incident"), rows([
      [t("det_incident_link"),
       `<a href="#" class="detail-link" data-detail-incident="${esc(s.incidentId)}">${esc(incidentLinkLabel(s.incidentId))}</a>`, true],
    ])) : "",
    section(t("det_section_service"), rows([
      [t("service_type"),          serviceTypeLabel(s.serviceType || "")],
      [t("det_service_works"),     serviceDetailText(s)],
      [t("det_service_status"),    t("service_status_" + status)],
      [t("service_date"),          d(s.serviceDate)],
      [t("service_time"),          s.serviceTime],
      [t("service_km"),            km(s.km)],
      [t("det_service_cost"),      s.cost != null && s.cost !== "" ? fmtRsd(s.cost) : null],
      [t("service_end_date"),      d(s.endDate)],
      [t("service_end_km"),        km(s.endKm)],
    ])),
    section(t("service_workshop"), rows([
      [t("service_workshop"),         s.workshop],
      [t("service_workshop_address"), s.workshopAddress],
      [t("servicer_pib"),             s.receiptPib],
    ])),
    work ? section(t("service_description"), `<div class="vehicle-notes-box">${esc(work)}</div>`) : "",
    itemsOrReload(items, "service", s),
    section(t("det_section_receipt"), rows([
      [t("trip_fuel_receipt"),      s.receiptNo],
      [t("trip_fuel_receipt_time"), receiptDateTime(s.receiptTime)],
      [t("det_receipt_link"),       safeReceiptLink(s.receiptUrl), true],
      [t("det_receipt_source"),     s.receiptSource ? t(s.receiptSource === "qr" ? "det_source_qr" : "det_source_manual") : null],
    ])),
    section(t("det_section_entry"), rows([
      [t("assignment_vehicle"),  s.vehiclePlate],
      [t("det_entered_at"),      dt(s.createdAt)],
      [t("det_taken_at"),        dt(s.takenAt)],
      [t("det_updated_at"),      dt(s.updatedAt)],
    ])),
  ].join("");
}

export function openServiceDetail(service) {
  if (!service) return;
  show(`🔧 ${serviceTypeLabel(service.serviceType || "")}`, serviceDetailHTML(service));
}

// ── DETALJI PRIJAVE ───────────────────────────────────────────
export function incidentDetailHTML(inc) {
  const type   = ["fault", "damage", "accident", "other"].includes(inc.type) ? inc.type : "other";
  const status = ["open", "in_progress", "closed"].includes(inc.status) ? inc.status : "open";
  return [
    section(t("det_section_incident"), rows([
      [t("incident_type"),         t("incident_" + type)],
      [t("det_incident_status"),   t("incident_status_" + status)],
      [t("incident_description"),  inc.description],
      [t("incident_location"),     inc.location],
      [t("incident_km_label"),     km(inc.currentKm)],
    ])),
    type === "accident" && (inc.thirdParty || inc.policeReport || inc.insurance)
      ? section(t("incident_accident_section"), rows([
          [t("incident_third_party"),  inc.thirdParty],
          [t("incident_police_report"), inc.policeReport],
          [t("incident_insurance"),    inc.insurance],
        ]))
      : "",
    inc.adminNote
      ? section(t("incident_note_label"), `<div class="vehicle-notes-box">${esc(inc.adminNote)}</div>`) : "",
    inc.resolution
      ? section(t("incident_resolution_label"), `<div class="vehicle-notes-box">${esc(inc.resolution)}</div>`) : "",
    isAdminViewer() ? incidentServicesPlaceholder(inc.id) : "",
    section(t("det_section_entry"), rows([
      [t("assignment_vehicle"), inc.vehiclePlate],
      [t("assignment_driver"),  inc.driverName ? driverLink(inc.driverName, inc.driverId) : null, true],
      [t("det_reported_at"),    dt(inc.createdAt)],
      [t("det_updated_at"),     dt(inc.updatedAt)],
    ])),
  ].join("");
}

// Servisi zakazani iz ove prijave (servis pamti incidentId) — učitavaju se posle otvaranja modala
const incidentServicesPlaceholder = (id) =>
  `<div id="detail-incident-services" data-incident-services="${esc(id)}" hidden></div>`;

function serviceMiniRow(sv) {
  const status = effectiveServiceStatus(sv);
  const main = [t("service_status_" + status), sv.cost != null && sv.cost !== "" ? fmtRsd(sv.cost) : null, sv.workshop]
    .filter(Boolean).join(" · ");
  return `<div class="detail-mini-row" data-service-id="${esc(sv.id)}" role="button" tabindex="0">
    <span class="detail-mini-row__type">🔧 ${esc(serviceTypeLabel(sv.serviceType || ""))}</span>
    <span class="detail-mini-row__main">${esc(main)}</span>
    <span class="detail-mini-row__date">${esc(d(sv.serviceDate) || "")}</span>
  </div>`;
}

// Zameni deo HTML-a i u trenutnom modalu i u steku ("Nazad" ne sme da vrati zastareo prikaz)
function patchDetailHtml(oldHtml, newHtml) {
  [current, ...stack].forEach(m => { if (m?.html?.includes(oldHtml)) m.html = m.html.replace(oldHtml, newHtml); });
}

async function loadIncidentServices(inc) {
  if (!isAdminViewer() || !S.companyId || !inc?.id) return;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "services"), where("incidentId", "==", inc.id)
    ));
    const list = snap.docs.map(x => rememberService({ id: x.id, ...x.data() }));
    if (!list.length) return;
    list.sort((a, b) => toMillis(b.serviceDate) - toMillis(a.serviceDate));
    const filled = `<div id="detail-incident-services" data-incident-services="${esc(inc.id)}">${
      section(t("det_section_incident_service"), `<div class="detail-mini-list">${list.map(serviceMiniRow).join("")}</div>`)
    }</div>`;
    patchDetailHtml(incidentServicesPlaceholder(inc.id), filled);
    const el = document.getElementById("detail-incident-services");
    if (el && el.dataset.incidentServices === inc.id) el.outerHTML = filled;
  } catch (e) {
    console.warn("Učitavanje servisa za prijavu nije uspelo:", e.message);
  }
}

// Otvara prijavu po ID-ju (iz detalja servisa): prvo iz evidencije, pa iz baze
async function openIncidentById(id) {
  let inc = getRememberedIncident(id);
  if (!inc && S.companyId) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId, "incidents", id));
      if (snap.exists()) inc = rememberIncident({ id: snap.id, ...snap.data() });
    } catch (e) { console.warn("Učitavanje prijave nije uspelo:", e.message); }
  }
  if (!inc) { showToast(t("det_incident_not_found"), "error"); return; }
  openIncidentDetail(inc);
}

export function openIncidentDetail(inc) {
  if (!inc) return;
  const type = ["fault", "damage", "accident", "other"].includes(inc.type) ? inc.type : "other";
  show(`${ICONS[type]} ${t("incident_" + type)}`, incidentDetailHTML(inc));
  loadIncidentServices(inc);
}

export function openEntryDetail(entry) {
  if (!entry) return;
  show(`${ICONS[entry.type] || "📋"} ${typeLabel(entry.type)}`, entryDetailHTML(entry));
}

// ── DOHVAT VEZANIH PODATAKA ───────────────────────────────────
async function fetchByAssignment(subcollection, assignmentId) {
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, subcollection),
      where("assignmentId", "==", assignmentId)
    ));
    return snap.docs.map(x => ({ id: x.id, ...x.data() }));
  } catch (e) {
    console.warn(`Detalji: učitavanje ${subcollection} nije uspelo:`, e);
    return [];
  }
}

async function loadAssignment(id) {
  let a = getRememberedAssignment(id);
  if (a) return a;
  try {
    const snap = await getDoc(doc(db, "companies", S.companyId, "assignments", id));
    if (snap.exists()) a = rememberAssignment({ id: snap.id, ...snap.data() });
  } catch (e) { console.warn("Detalji: zaduženje nije učitano:", e); }
  return a;
}

// ── DETALJI VOŽNJE ────────────────────────────────────────────
function tripFields(tr) {
  const tripKm = (tr.endKm != null && tr.startKm != null) ? tr.endKm - tr.startKm : null;
  return rows([
    [t("assignment_start_date"), d(tr.startDate)],
    [t("assignment_end_date"),   tr.endDate ? d(tr.endDate) : t("assignment_status_active")],
    [t("assignment_start_km"),   km(tr.startKm)],
    [t("assignment_end_km"),     km(tr.endKm)],
    [t("assignment_summary_km"), tripKm != null ? km(tripKm) : null],
    [t("det_fuel_level"),        fuelLvl(tr.fuelLevel)],
    [t("assignment_type"),       tr.tripType === "intercity" ? t("assignment_intercity") : (tr.tripType ? t("assignment_local") : null)],
    [t("assignment_destination"), tr.destination],
    [t("assignment_route"),      tr.route],
    [t("assignment_reason"),     tr.reason],
    [t("det_status"),            tr.status ? t("assignment_status_" + tr.status) : null],
    [t("notes"),                 tr.notes],
  ]);
}

export async function openTripDetail(tripId, assignmentId = null) {
  const tr = getRememberedTrip(tripId);
  if (!tr) return;
  const aId = assignmentId || tr.assignmentId;
  let entries = [];
  if (aId) {
    const all = await fetchByAssignment("tripEntries", aId);
    entries = tr._legacy ? all : all.filter(e => e.tripId === tr.id);
  }
  entries.sort((x, y) => toMillis(x.createdAt) - toMillis(y.createdAt));
  show(`🔑 ${t("det_title_trip")}`, [
    section(t("assignment_vehicle") + " / " + t("assignment_driver"), rows([
      [t("assignment_vehicle"), [tr.vehiclePlate, `${tr.vehicleBrand || ""} ${tr.vehicleModel || ""}`.trim()].filter(Boolean).join(" — ")],
      [t("assignment_driver"),  tr.driverName ? driverLink(tr.driverName, tr.driverId) : null, true],
    ])),
    section(t("driver_trip_label"), tripFields(tr)),
    section(t("det_section_entries"), entries.length
      ? `<div class="detail-mini-list">${entries.map(entryMiniRow).join("")}</div>`
      : `<p class="empty-text">${t("trip_no_entries")}</p>`),
  ].join(""));
}

// ── DETALJI ZADUŽENJA ─────────────────────────────────────────
export async function openAssignmentDetail(assignmentId) {
  const a = await loadAssignment(assignmentId);
  if (!a) return;
  const [trips, entries] = await Promise.all([
    fetchByAssignment("trips", assignmentId),
    fetchByAssignment("tripEntries", assignmentId),
  ]);
  trips.sort((x, y) => toMillis(x.startDate) - toMillis(y.startDate));
  entries.sort((x, y) => toMillis(x.createdAt) - toMillis(y.createdAt));
  trips.forEach(tr => rememberTrip(tr, assignmentId));

  const totalKm = trips.reduce((s, tr) =>
    s + ((tr.endKm != null && tr.startKm != null) ? tr.endKm - tr.startKm : 0), 0)
    || ((a.endKm != null && a.startKm != null) ? a.endKm - a.startKm : 0);
  const fuel  = entries.filter(e => e.type === "fuel");
  const costs = entries.filter(e => COST_TYPES.includes(e.type));
  const fuelL    = fuel.reduce((s, e) => s + (Number(e.fuelAmount) || 0), 0);
  const fuelCost = fuel.reduce((s, e) => s + (Number(e.fuelCost) || 0), 0);
  const costSum  = costs.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const mismatch = [];
  if (a.kmMismatch) {
    mismatch.push(t("assignment_km_mismatch_detail")
      .replace("{0}", a.driverStartKm != null ? fmtNum(a.driverStartKm) : "?")
      .replace("{1}", a.startKm != null ? fmtNum(a.startKm) : "?"));
  }
  if (a.fuelLevelMismatch) {
    mismatch.push(t("assignment_fuel_mismatch_detail")
      .replace("{0}", fuelLvl(a.fuelLevelConfirmedValue) || "?")
      .replace("{1}", fuelLvl(a.systemFuelLevel) || "?"));
  }

  show(`🔑 ${t("det_title_assignment")}`, [
    section(t("assignment_vehicle") + " / " + t("assignment_driver"), rows([
      [t("assignment_vehicle"), `${a.vehiclePlate || ""} — ${a.vehicleBrand || ""} ${a.vehicleModel || ""}`.trim()],
      ["VIN", a.vehicleVin],
      [t("assignment_driver"), a.driverName ? driverLink(a.driverName, a.driverId) : null, true],
    ])),
    section(t("det_section_assignment"), rows([
      [t("det_status"),            t("assignment_status_" + a.status)],
      [t("assignment_start_date"), d(a.startDate)],
      [t("assignment_end_date"),   a.endDate ? d(a.endDate) : (a.status === "closed" ? null : t("assignment_status_active"))],
      [t("assignment_start_km"),   km(a.startKm)],
      [t("assignment_end_km"),     km(a.endKm)],
      [t("assignment_summary_km"), totalKm > 0 ? km(totalKm) : null],
      [t("det_fuel_level"),        fuelLvl(a.fuelLevel)],
      [t("assignment_type"),       a.tripType === "intercity" ? t("assignment_intercity") : t("assignment_local")],
      [t("assignment_destination"), a.destination],
      [t("assignment_route"),      a.route],
      [t("assignment_reason"),     a.reason],
      [t("det_unassign_notes"),    a.unassignNotes],
      [t("det_entered_at"),        dt(a.createdAt)],
    ])),
    mismatch.length ? section(t("det_section_mismatch"), `<div class="assignment-card__mismatch">${mismatch.map(m => `⚠️ ${esc(m)}`).join("<br>")}</div>`) : "",
    section(t("det_section_totals"), rows([
      [t("trip_stats_fuel"),            `${fmtNum(fuelL, 2)} L · ${fmtRsd(fuelCost)} (${fuel.length})`],
      [t("det_other_costs"),            `${fmtRsd(costSum)} (${costs.length})`],
      [t("assignment_summary_costs"),   fmtRsd(fuelCost + costSum)],
    ])),
    section(`${t("det_section_trips")} (${trips.length})`, trips.length
      ? `<div class="detail-mini-list">${trips.map((tr, i) => `
          <div class="detail-mini-row" data-detail-trip="${esc(tr.id)}" role="button" tabindex="0">
            <span class="detail-mini-row__icon">🔑</span>
            <span class="detail-mini-row__type">${t("driver_trip_label")} ${i + 1}</span>
            <span class="detail-mini-row__main">${d(tr.startDate) || "—"} → ${tr.endDate ? d(tr.endDate) : t("assignment_status_active")} · ${km(tr.startKm) || "—"} → ${km(tr.endKm) || "—"}</span>
          </div>`).join("")}</div>`
      : `<p class="empty-text">${t("no_data")}</p>`),
    section(`${t("det_section_entries")} (${entries.length})`, entries.length
      ? `<div class="detail-mini-list">${entries.map(entryMiniRow).join("")}</div>`
      : `<p class="empty-text">${t("trip_no_entries")}</p>`),
  ].join(""));
}

// ── DETALJI VOZAČA ────────────────────────────────────────────
export async function openDriverDetail(driverId) {
  let drv = null;
  try {
    const snap = await getDoc(doc(db, "companies", S.companyId, "drivers", driverId));
    if (snap.exists()) drv = { id: snap.id, ...snap.data() };
  } catch (e) { console.warn("Detalji: vozač nije učitan:", e); }
  if (!drv) return;

  let active = [];
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverId", "==", driverId),
      where("status", "==", "active")
    ));
    active = snap.docs.map(x => rememberAssignment({ id: x.id, ...x.data() }));
  } catch (e) { /* bez aktivnih zaduženja u prikazu */ }

  show(`👤 ${drv.firstName || ""} ${drv.lastName || ""}`.trim(), [
    section(t("driver_personal_section"), rows([
      [t("driver_firstname"),   drv.firstName],
      [t("driver_lastname"),    drv.lastName],
      [t("driver_jmbg_label"),  drv.jmbg],
      [t("driver_birth_year"),  drv.birthYear],
      [t("driver_license_cat"), Array.isArray(drv.licenseCategories) ? drv.licenseCategories.join(", ") : drv.licenseCategories],
      [t("driver_position"),    drv.position],
      [t("driver_status_label"), drv.active !== false ? t("driver_active") : t("driver_inactive")],
    ])),
    section(t("driver_contact_section"), rows([
      [t("driver_phone"),        drv.phone],
      [t("driver_email"),        drv.email],
      [t("driver_home_address"), drv.homeAddress],
      [t("driver_work_address"), drv.workAddress],
    ])),
    section(t("det_current_assignments"), active.length
      ? `<div class="detail-mini-list">${active.map(a => `
          <div class="detail-mini-row" data-detail-assignment="${esc(a.id)}" role="button" tabindex="0">
            <span class="detail-mini-row__icon">🚗</span>
            <span class="detail-mini-row__type">${esc(a.vehiclePlate || "")}</span>
            <span class="detail-mini-row__main">${esc(`${a.vehicleBrand || ""} ${a.vehicleModel || ""}`.trim())}${a.tripType === "intercity" && a.destination ? " · 📍 " + esc(a.destination) : ""}</span>
            <span class="detail-mini-row__date">${d(a.startDate) || ""}</span>
          </div>`).join("")}</div>`
      : `<p class="empty-text">${t("det_no_active_assignment")}</p>`),
    drv.notes ? section(t("notes"), `<div class="vehicle-notes-box">${esc(drv.notes)}</div>`) : "",
  ].join(""));
}

// ── PONOVNO UČITAVANJE STAVKI SA RAČUNA ───────────────────────
// Čita fiskalni račun preko receiptUrl i DOPUNJUJE unos: stavke sa računa, a od
// podataka samo ono što u unosu nedostaje (PIB, objekat, vreme računa).
// Ništa što je već uneto se ne prepisuje.
// Jezgro: učitaj račun i dopuni unos. Vraća { status: "loaded"|"empty"|"failed", error? }
async function applyReceiptReload(kind, obj) {
  const r = await fetchReceiptDetails(obj.receiptUrl);
  const isFuel = kind === "entry" && obj.type === "fuel";
  const items = (r.items || []).map(it => ({
    name: it.name || null,
    quantity: it.quantity ?? null,
    unitPrice: it.unitPrice ?? null,
    total: it.total ?? null,
    ...(isFuel ? { fuelType: it.fuelType || null } : {}),
  }));
  if (!items.length) return { status: "empty" };

  const updates = { receiptItems: items };
  if (kind === "service") {
    if (!obj.receiptPib && r.pib) updates.receiptPib = r.pib;
    updates.updatedAt = serverTimestamp();
  } else {
    if (!obj.stationPib && r.pib) updates.stationPib = r.pib;
    if (isFuel && !obj.stationObject && r.object) updates.stationObject = r.object;
  }
  if (!obj.receiptTime && r.time) updates.receiptTime = r.time;

  await updateDoc(doc(db, "companies", S.companyId, kind === "service" ? "services" : "tripEntries", obj.id), updates);

  const local = { ...updates };
  if (local.updatedAt) local.updatedAt = new Date();
  Object.assign(obj, local);
  return { status: "loaded" };
}

async function reloadReceipt(btn) {
  const kind = btn.dataset.reloadReceipt;
  const obj = kind === "service" ? getRememberedService(btn.dataset.id) : getRememberedEntry(btn.dataset.id);
  const statusEl = btn.parentElement?.querySelector(".detail-reload__status");
  const say = (msg, cls = "") => { if (statusEl) { statusEl.textContent = msg; statusEl.className = `detail-reload__status ${cls}`; } };
  if (!obj?.receiptUrl || !isAdminViewer()) return;

  btn.disabled = true;
  say(t("det_reload_loading"));
  try {
    const res = await applyReceiptReload(kind, obj);
    if (res.status === "empty") { say(t("det_reload_empty"), "is-warn"); btn.disabled = false; return; }

    // Ako je isti modal još otvoren, prikaži dopunjen unos
    if (document.body.contains(btn) && current) {
      render(current.title, kind === "service" ? serviceDetailHTML(obj) : entryDetailHTML(obj));
    }
    showToast(t("det_reload_ok"), "success");
  } catch (e) {
    console.warn("Ponovno učitavanje računa nije uspelo:", e.message, e.diag || "");
    say(t("det_reload_failed", { reason: e.message }), "is-error");
    btn.disabled = false;
  }
}

// ── GRUPNO UČITAVANJE STAVKI (za starije unose) ───────────────
// Unosi koji imaju račun (receiptUrl), a nemaju sačuvane stavke.
export function receiptReloadTargets(services = [], entries = []) {
  const missing = (o) => o?.receiptUrl && !(Array.isArray(o.receiptItems) && o.receiptItems.length);
  return [
    ...entries.filter(missing).map(obj => ({ kind: "entry", obj })),
    ...services.filter(missing).map(obj => ({ kind: "service", obj })),
  ];
}

export function canBulkReloadReceipts() {
  return isAdminViewer() && receiptWorkerConfigured();
}

/**
 * Redom učitava račune (jedan po jedan, da se ne optereti servis poreske uprave).
 * Staje posle 3 uzastopna neuspeha (servis nedostupan). onProgress({done,total,loaded,empty,failed}).
 * Vraća { loaded, empty, failed, total, aborted }.
 */
export async function bulkReloadReceiptItems(targets, onProgress = () => {}) {
  const res = { loaded: 0, empty: 0, failed: 0, total: targets.length, aborted: false };
  let consecutiveFails = 0;
  for (let i = 0; i < targets.length; i++) {
    const { kind, obj } = targets[i];
    try {
      const r = await applyReceiptReload(kind, obj);
      if (r.status === "loaded") res.loaded++; else res.empty++;
      consecutiveFails = 0;
    } catch (e) {
      res.failed++;
      consecutiveFails++;
      console.warn("Grupno učitavanje računa:", e.message);
      if (consecutiveFails >= 3) { res.aborted = true; onProgress({ done: i + 1, ...res }); break; }
    }
    onProgress({ done: i + 1, ...res });
    await new Promise(r => setTimeout(r, 400));
  }
  return res;
}

// ── GLOBALNI KLIK (capture, da ne okine toggle roditeljskog zaglavlja) ──
function onActivate(e) {
  // Sklapanje/otvaranje liste stavki sa računa (dostupno svima koji vide detalje)
  const tg = e.target.closest?.("[data-toggle-items]");
  if (tg) {
    e.preventDefault(); e.stopPropagation();
    const body = tg.parentElement?.querySelector(".detail-items-body");
    if (body) {
      body.hidden = !body.hidden;
      tg.setAttribute("aria-expanded", String(!body.hidden));
      tg.classList.toggle("is-collapsed", body.hidden);
    }
    return;
  }
  if (!canOpenEntryDetails()) return;

  // Dugme "Učitaj stavke sa računa" (samo administrator)
  const rl = e.target.closest?.("[data-reload-receipt]");
  if (rl) {
    e.preventDefault(); e.stopPropagation();
    if (isAdminViewer() && !rl.disabled) reloadReceipt(rl);
    return;
  }

  const el = e.target.closest?.(
    "[data-detail-back], [data-entry-id], [data-service-id], [data-incident-id], [data-detail-incident], [data-detail-assignment], [data-detail-trip], [data-detail-driver]"
  );
  if (!el) return;

  // Kartice servisa i prijava imaju svoja dugmad (Završi, Izmeni, Zakaži servis…):
  // klik na dugme/link/polje unutar kartice radi svoju akciju, ne otvara detalje.
  if ((el.dataset.serviceId || el.dataset.incidentId) && e.target.closest) {
    const inner = e.target.closest("button, a, input, select, textarea, label");
    if (inner && inner !== el && el.contains(inner)) return;
  }

  // Vozač: dozvoljeni su samo detalji unosa i dugme "Nazad" u modalu
  if (!isAdminViewer() && !el.hasAttribute("data-detail-back") && !el.dataset.entryId && !el.dataset.incidentId) return;
  if (el.dataset.serviceId && !isAdminViewer()) return;

  e.preventDefault();
  e.stopPropagation();

  if (el.hasAttribute("data-detail-back"))       { goBack(); return; }
  if (el.dataset.entryId)                         { openEntryDetail(getRememberedEntry(el.dataset.entryId)); return; }
  if (el.dataset.serviceId)                       { openServiceDetail(getRememberedService(el.dataset.serviceId)); return; }
  if (el.dataset.incidentId)                      { openIncidentDetail(getRememberedIncident(el.dataset.incidentId)); return; }
  if (el.dataset.detailIncident)                  { openIncidentById(el.dataset.detailIncident); return; }
  if (el.dataset.detailAssignment)                { openAssignmentDetail(el.dataset.detailAssignment); return; }
  if (el.dataset.detailTrip)                      { openTripDetail(el.dataset.detailTrip); return; }
  if (el.dataset.detailDriver)                    { openDriverDetail(el.dataset.detailDriver); return; }
}

if (!window.__fmDetailHandlersInstalled) {
  window.__fmDetailHandlersInstalled = true;
  document.addEventListener("click", onActivate, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const hit = e.target.closest?.("[role='button'][data-entry-id], [role='button'][data-service-id], [role='button'][data-incident-id], [role='button'][data-detail-assignment], [role='button'][data-detail-trip], [role='button'][data-toggle-items]");
    if (!hit || hit !== e.target) return; // Enter/Space samo kad je fokus na samoj kartici (ne na dugmetu u njoj)
    onActivate(e);
  }, true);
}

// Pomoćnik za HTML dugme "ℹ️" u zaglavljima (vraća "" za vozače)
export function detailButton(attr, id, title = null) {
  if (!isAdminViewer()) return "";
  return `<button type="button" class="btn btn--ghost btn--sm detail-btn" ${attr}="${esc(id)}" title="${esc(title || t("det_btn_details"))}" aria-label="${esc(title || t("det_btn_details"))}">ℹ️</button>`;
}
