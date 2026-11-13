// ════════════════════════════════════════════════════════════════
//  service-types.js  —  Fleet Manager
//  Katalog vrsta servisa (glavne stavke + podstavke za čekiranje),
//  picker za formu "Dodaj servis" i pomoćne funkcije za prikaz.
//
//  Čuvanje (kolekcija services):
//    serviceType  — ključ glavne stavke (stari ključevi regular, tech,
//                   tires, repair, other zadržavaju značenje)
//    serviceItems — niz ključeva čekiranih podstavki (može biti prazan)
//    serviceOther — slobodan tekst, samo za "Ostalo"
//  Stari zapisi bez serviceItems/serviceOther rade bez migracije.
// ════════════════════════════════════════════════════════════════

import { t } from "./i18n.js";
import { setDateError, clearDateError } from "./date-input.js";

// Redosled je redosled u padajućem meniju. Prevodi: service_type_<key>
// (glavna stavka) i service_item_<key> (podstavka).
export const SERVICE_CATALOG = [
  { key: "tech",       items: [] },
  { key: "regular",    items: ["regular_small", "regular_big"] },
  { key: "brakes",     items: ["brakes_pads", "brakes_discs", "brakes_calipers", "brakes_fluid"] },
  { key: "tires",      items: ["tires_seasonal", "tires_balance", "tires_repair"] },
  { key: "ac",         items: ["ac_gas", "ac_install", "ac_compressor"] },
  { key: "repair",     items: ["repair_timing", "repair_clutch", "repair_gearbox", "repair_injector", "repair_plugs", "repair_exhaust", "repair_cooling"] },
  { key: "suspension", items: ["susp_rack", "susp_shocks", "susp_links", "susp_geometry"] },
  { key: "electrical", items: ["elec_battery", "elec_obd", "elec_computer", "elec_bulbs"] },
  { key: "body",       items: ["body_paint", "body_rim", "body_light"] },
  { key: "tachograph", items: [] },
  { key: "other",      items: [], freeText: true },
];

const escAttr = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function label(prefix, key) {
  const k = prefix + key;
  const v = t(k);
  return v === k ? String(key) : v;
}

export const serviceTypeLabel = (key) => label("service_type_", key);
export const serviceItemLabel = (key) => label("service_item_", key);

// "Mali servis (ulje + filteri), Veliki servis" ili tekst iz "Ostalo"; "" ako nema
export function serviceDetailText(s) {
  if (!s) return "";
  if (s.serviceType === "other") return String(s.serviceOther || "").trim();
  const items = Array.isArray(s.serviceItems) ? s.serviceItems : [];
  return items.map(serviceItemLabel).join(", ");
}

// "Kočnice: Zamena pločica, Zamena diskova"
export function serviceTitle(s) {
  const main = serviceTypeLabel(s?.serviceType || "");
  const detail = serviceDetailText(s);
  return detail ? `${main}: ${detail}` : main;
}

// Podsetnik za gume se gasi samo sezonskom zamenom. Stari zapisi bez
// polja serviceItems računaju se kao do sada (svaki servis tipa "tires").
export function isSeasonalTireService(sv) {
  if (!sv || sv.serviceType !== "tires") return false;
  if (!Array.isArray(sv.serviceItems)) return true;
  return sv.serviceItems.includes("tires_seasonal");
}

// ── PICKER ZA FORMU ──────────────────────────────────────────
// HTML: padajući meni samo sa glavnim stavkama + kontejner za podstavke.
export function serviceTypePickerHTML(prefix, s = {}) {
  const current = s.serviceType || "regular";
  const known = SERVICE_CATALOG.some((c) => c.key === current);
  const opts = SERVICE_CATALOG.map((c) =>
    `<option value="${c.key}" ${c.key === current ? "selected" : ""}>${escAttr(serviceTypeLabel(c.key))}</option>`
  );
  // Stari zapis sa nepoznatim tipom — ne menjamo ga tiho pri izmeni
  if (!known) opts.push(`<option value="${escAttr(current)}" selected>${escAttr(current)}</option>`);
  return `
    <select id="${prefix}-type" class="form-select">${opts.join("")}</select>
    <div id="${prefix}-type-sub" class="svc-sub"></div>`;
}

// Poziva se posle openModal: iscrtava podstavke i prati promenu glavne stavke.
// Pri promeni glavne stavke čekirana polja se brišu.
export function bindServiceTypePicker(prefix, s = {}) {
  const sel = document.getElementById(`${prefix}-type`);
  const box = document.getElementById(`${prefix}-type-sub`);
  if (!sel || !box) return;

  const render = (initial) => {
    const cat = SERVICE_CATALOG.find((c) => c.key === sel.value);
    box.innerHTML = "";
    if (!cat) return;
    const sameType = initial && s.serviceType === cat.key;

    if (cat.freeText) {
      box.innerHTML = `
        <div class="form-group" style="margin-top:10px">
          <label class="form-label" for="${prefix}-other">${t("service_other_label")} *</label>
          <input id="${prefix}-other" class="form-input" type="text" maxlength="200" autocomplete="off"
            placeholder="${escAttr(t("service_other_ph"))}" />
        </div>`;
      const inp = document.getElementById(`${prefix}-other`);
      if (sameType) inp.value = s.serviceOther || "";
      inp.addEventListener("input", () => clearDateError(inp));
      return;
    }

    if (!cat.items.length) return;
    const chosen = new Set(sameType && Array.isArray(s.serviceItems) ? s.serviceItems : []);
    box.innerHTML = `
      <div class="svc-sub__list">
        ${cat.items.map((k) => `
          <label class="form-checkbox-label svc-sub__row">
            <input type="checkbox" data-svc-item="${k}" ${chosen.has(k) ? "checked" : ""} />
            <span>${escAttr(serviceItemLabel(k))}</span>
          </label>`).join("")}
      </div>`;
  };

  sel.addEventListener("change", () => render(false));
  render(true);
}

// Čita izbor iz forme. requireOther: za "Ostalo" tekst je obavezan.
// Vraća { ok, serviceType, serviceItems, serviceOther }.
export function readServiceType(prefix, { requireOther = true } = {}) {
  const serviceType = document.getElementById(`${prefix}-type`)?.value;
  const cat = SERVICE_CATALOG.find((c) => c.key === serviceType);
  let serviceItems = [];
  let serviceOther = null;

  if (cat?.freeText) {
    const inp = document.getElementById(`${prefix}-other`);
    serviceOther = (inp?.value || "").trim() || null;
    if (!serviceOther && requireOther) {
      setDateError(`${prefix}-other`, t("service_other_required"), { focus: true });
      return { ok: false };
    }
  } else {
    serviceItems = [...document.querySelectorAll(`#${prefix}-type-sub input[data-svc-item]:checked`)]
      .map((cb) => cb.dataset.svcItem);
  }
  return { ok: true, serviceType, serviceItems, serviceOther };
}

// Opis radova BEZ automatski ubačene liste "Stavke sa računa" (ona se prikazuje
// kao tabela iz polja receiptItems). Zapisi bez receiptItems zadržavaju ceo tekst.
export function serviceWorkText(s) {
  const text = String(s?.description || "").trim();
  if (!text) return "";
  if (!Array.isArray(s.receiptItems) || s.receiptItems.length === 0) return text;
  return text.replace(/(^|\n+)[^\n]*:[ \t]*\n•[\s\S]*$/, "").trim();
}
