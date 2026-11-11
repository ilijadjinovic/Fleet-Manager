// ============================================================
//  servicers.js  —  Fleet Manager
//  Tab: Serviseri — lista servisa sa kojima kompanija sarađuje
//
//  Lista: sažet red (broj + naziv), klik proširuje detalje (više
//  redova može biti otvoreno), pretraga uz kucanje po svim poljima
//  (uključujući usluge), brojač "Prikazano X od Y servisera".
//
//  Usluge servisera (ček-lista):
//    services      — niz ključeva; osnovne usluge su obični ključevi
//                    (npr. "brakes"), usluge koje je admin dodao u
//                    katalog imaju oblik "c:<id dokumenta u katalogu>"
//    servicesOther — slobodan tekst ("Druge usluge")
//  Katalog dodatih usluga: companies/{id}/serviceCatalog/{id}
//    { name, category }   (category = ključ kategorije iz SERVICER_SERVICE_CATALOG)
// ============================================================

import { db } from "./firebase.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";

let allServicers = [];
let customServices = [];          // usluge koje je admin dodao u katalog
let searchQuery = "";
const openIds = new Set();        // ids servisera čiji su detalji otvoreni

// Osnovni katalog usluga (redosled = redosled kategorija u formi).
// Prevodi: sp_cat_<kategorija> i sp_svc_<usluga>.
export const SERVICER_SERVICE_CATALOG = [
  { key: "legal",       items: ["tech_inspection", "registration", "attestation", "homologation", "tachograph"] },
  { key: "maintenance", items: ["service_small", "service_big", "timing"] },
  { key: "mechanics",   items: ["brakes", "suspension", "geometry", "exhaust", "transmission", "lpg", "towbar"] },
  { key: "tires",       items: ["vulcanizer", "tires_sale", "tires_storage"] },
  { key: "electric",    items: ["auto_electric", "diagnostics", "ac", "battery", "car_radio", "refrigeration"] },
  { key: "body",        items: ["sheet_metal", "painting", "glass"] },
  { key: "other",       items: ["wash", "towing"] },
];
const BASE_SERVICE_KEYS = new Set(SERVICER_SERVICE_CATALOG.flatMap(c => c.items));

const catalogRef = () => collection(db, "companies", S.companyId, "serviceCatalog");

async function loadCatalog() {
  try {
    const snap = await getDocs(catalogRef());
    customServices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return true;
  } catch (e) {
    console.error("serviceCatalog load error:", e);
    customServices = [];
    return false;
  }
}

// Naziv usluge po ključu; null ako je dodata usluga u međuvremenu obrisana
function serviceLabel(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith("c:")) {
    const c = customServices.find(x => "c:" + x.id === key);
    return c ? c.name : null;
  }
  return BASE_SERVICE_KEYS.has(key) ? t("sp_svc_" + key) : null;
}

// Svi nazivi usluga jednog servisera (čekirane + slobodan unos)
function servicerServiceLabels(s) {
  const labels = (Array.isArray(s.services) ? s.services : []).map(serviceLabel).filter(Boolean);
  const other = String(s.servicesOther || "").split(",").map(x => x.trim()).filter(Boolean);
  return [...labels, ...other];
}

// ── PRETRAGA ──────────────────────────────────────────────────
const CYR = {
  а:"a",б:"b",в:"v",г:"g",д:"d",ђ:"dj",е:"e",ж:"z",з:"z",и:"i",ј:"j",к:"k",л:"l",љ:"lj",
  м:"m",н:"n",њ:"nj",о:"o",п:"p",р:"r",с:"s",т:"t",ћ:"c",у:"u",ф:"f",х:"h",ц:"c",ч:"c",џ:"dz",ш:"s"
};
// Mala slova, bez kvačica (č,ć,š,ž → c,c,s,z; đ → dj), ćirilica → latinica
function norm(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/đ/g, "dj")
    .replace(/[а-џ]/g, ch => CYR[ch] ?? ch)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const compact = (v) => norm(v).replace(/[^a-z0-9]/g, "");

function matchesSearch(s, tokens, compactTokens) {
  const hay = norm([
    s.name, s.address, s.phone, s.email, s.pib, s.mbr, s.account, s.notes,
    ...servicerServiceLabels(s),
  ].filter(Boolean).join(" "));
  const phoneC = compact(s.phone);
  return tokens.every((tok, i) =>
    hay.includes(tok) || (compactTokens[i].length >= 3 && phoneC.includes(compactTokens[i]))
  );
}

function filteredServicers() {
  const tokens = norm(searchQuery).split(/\s+/).filter(Boolean);
  if (!tokens.length) return allServicers;
  const compactTokens = tokens.map(compact);
  return allServicers.filter(s => matchesSearch(s, tokens, compactTokens));
}

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderServicers(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";
  searchQuery = "";
  openIds.clear();

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">🔧 ${t("tab_servicers")}</h2>
      ${canEdit ? `<button id="btn-add-servicer" class="btn btn--primary btn--sm">+ ${t("servicer_add")}</button>` : ""}
    </div>
    <div class="servicer-toolbar">
      <div class="servicer-search">
        <span class="servicer-search__icon" aria-hidden="true">🔍</span>
        <input id="servicer-search" class="form-input servicer-search__input" type="text"
               autocomplete="off" spellcheck="false"
               placeholder="${esc(t("servicer_search_ph"))}"
               aria-label="${esc(t("servicer_search_ph"))}" />
        <button id="servicer-search-clear" class="servicer-search__clear hidden" type="button"
                aria-label="${esc(t("servicer_search_clear"))}" title="${esc(t("servicer_search_clear"))}">✕</button>
      </div>
      <div id="servicer-count" class="servicer-count" aria-live="polite"></div>
    </div>
    <div id="servicers-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-servicer")?.addEventListener("click", () => openServicerForm());
  }

  const input = document.getElementById("servicer-search");
  const clearBtn = document.getElementById("servicer-search-clear");
  const applySearch = (value) => {
    searchQuery = value;
    clearBtn.classList.toggle("hidden", !value);
    renderList();
  };
  input.addEventListener("input", () => applySearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; applySearch(""); }
  });
  clearBtn.addEventListener("click", () => { input.value = ""; applySearch(""); input.focus(); });

  // Delegacija događaja na listi (lista se iznova crta pri svakom kucanju)
  const list = document.getElementById("servicers-list");
  list.addEventListener("click", (e) => {
    const editBtn = e.target.closest(".btn-edit-servicer");
    if (editBtn) {
      const s = allServicers.find(x => x.id === editBtn.dataset.id);
      if (s) openServicerForm(s);
      return;
    }
    const delBtn = e.target.closest(".btn-delete-servicer");
    if (delBtn) { deleteServicer(delBtn.dataset.id); return; }
    const header = e.target.closest(".servicer-card__header");
    if (header) toggleCard(header);
  });
  list.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("servicer-card__header")) {
      e.preventDefault();
      toggleCard(e.target);
    }
  });

  await loadServicers();
}

function toggleCard(header) {
  const card = header.closest(".servicer-card");
  if (!card) return;
  const open = !card.classList.contains("servicer-card--open");
  card.classList.toggle("servicer-card--open", open);
  header.setAttribute("aria-expanded", String(open));
  if (open) openIds.add(card.dataset.id); else openIds.delete(card.dataset.id);
}

// ── UČITAJ SERVISERE ──────────────────────────────────────────
async function loadServicers() {
  try {
    const [snap] = await Promise.all([
      getDocs(query(collection(db, "companies", S.companyId, "serviceProviders"), orderBy("name", "asc"))),
      loadCatalog(),   // greška u katalogu ne sme da obori listu
    ]);
    allServicers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    const list = document.getElementById("servicers-list");
    if (list) list.innerHTML = `<div class="error-state">${t("error")}: ${esc(e.message)}</div>`;
  }
}

function updateCount(shown, total) {
  const el = document.getElementById("servicer-count");
  if (!el) return;
  if (total === 0) { el.textContent = ""; return; }
  el.textContent = searchQuery.trim()
    ? t("servicer_count_shown", { shown, total })
    : t("servicer_count_total", { total });
}

function renderList() {
  const list = document.getElementById("servicers-list");
  if (!list) return;
  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  if (allServicers.length === 0) {
    updateCount(0, 0);
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🔧</div>
        <p>${t("servicer_no_data")}</p>
      </div>`;
    return;
  }

  const shown = filteredServicers();
  updateCount(shown.length, allServicers.length);

  if (shown.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <p>${t("servicer_none_found")}</p>
      </div>`;
    return;
  }

  list.innerHTML = `
    <div class="servicer-list">
      ${shown.map((s, i) => {
        const open = openIds.has(s.id);
        const labels = servicerServiceLabels(s);
        return `
        <div class="servicer-card${open ? " servicer-card--open" : ""}" data-id="${esc(s.id)}">
          <div class="servicer-card__header" role="button" tabindex="0"
               aria-expanded="${open}" title="${esc(t("servicer_expand"))}">
            <span class="servicer-card__num">${i + 1}</span>
            <span class="servicer-card__name">🔧 ${esc(s.name)}</span>
            ${canEdit ? `
              <span class="servicer-card__actions">
                <button class="btn btn--icon btn-edit-servicer" data-id="${esc(s.id)}" title="${esc(t("servicer_edit"))}">✏️</button>
                <button class="btn btn--icon btn-delete-servicer" data-id="${esc(s.id)}" title="${esc(t("delete"))}">🗑️</button>
              </span>` : ""}
            <span class="servicer-card__chevron" aria-hidden="true">▾</span>
          </div>
          <div class="servicer-card__details">
            ${labels.length ? `
              <div class="servicer-services">
                <div class="servicer-services__label">${t("servicer_services")}</div>
                <div class="servicer-chips">${labels.map(l => `<span class="servicer-chip">${esc(l)}</span>`).join("")}</div>
              </div>` : ""}
            ${s.address ? `<div class="servicer-detail"><span>📍</span> ${esc(s.address)}</div>` : ""}
            ${s.phone ? `<div class="servicer-detail"><span>📞</span> <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></div>` : ""}
            ${s.email ? `<div class="servicer-detail"><span>✉️</span> <a href="mailto:${esc(s.email)}">${esc(s.email)}</a></div>` : ""}
            ${s.pib ? `<div class="servicer-detail"><span>🧾</span> ${t("servicer_pib")}: ${esc(s.pib)}</div>` : ""}
            ${s.mbr ? `<div class="servicer-detail"><span>🏢</span> ${t("servicer_mbr")}: ${esc(s.mbr)}</div>` : ""}
            ${s.account ? `<div class="servicer-detail"><span>💳</span> ${esc(s.account)}</div>` : ""}
            ${s.notes ? `<div class="servicer-detail servicer-detail--notes"><span>📝</span> ${esc(s.notes)}</div>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  `;
}

// ── FORMA ZA UNOS/EDIT ────────────────────────────────────────
// opts.prefill: početne vrednosti za NOVOG servisera (npr. sa skeniranog računa)
// opts.onSaved(id, data): poziva se posle uspešnog snimanja
export function openServicerForm(servicer = null, opts = {}) {
  const isEdit = !!servicer;
  const s = servicer || opts.prefill || {};

  // Stanje ček-liste usluga (živi dok je forma otvorena)
  const selected = new Set(Array.isArray(s.services) ? s.services : []);
  const openCats = new Set();
  let catalogLoaded = false;
  let addingCat = null;      // kategorija u kojoj je otvoreno polje "nova usluga"
  let renamingId = null;     // id dodate usluge koja se preimenuje
  let svcMsg = null;         // { text, kind } poruka iznad ček-liste

  // Stara napomena (usluge su se do sada upisivale tamo) — prikazuje se uz ček-listu
  const showOldNoteHint = isEdit && s.notes && !(Array.isArray(s.services) && s.services.length) && !s.servicesOther;

  const bodyHTML = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_name")}</label>
        <input id="sf-name" class="form-input" type="text" value="${esc(s.name)}" placeholder="${esc(t("servicer_name"))}" />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_address")}</label>
        <input id="sf-address" class="form-input" type="text" value="${esc(s.address)}" placeholder="Ulica i broj, grad" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_phone")}</label>
        <input id="sf-phone" class="form-input" type="tel" value="${esc(s.phone)}" placeholder="+381..." />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_email")}</label>
        <input id="sf-email" class="form-input" type="email" value="${esc(s.email)}" placeholder="servis@example.com" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_pib")}</label>
        <input id="sf-pib" class="form-input" type="text" value="${esc(s.pib)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_mbr")}</label>
        <input id="sf-mbr" class="form-input" type="text" value="${esc(s.mbr)}" />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_account")}</label>
        <input id="sf-account" class="form-input" type="text" value="${esc(s.account)}" placeholder="160-..." />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_services_form")}</label>
        ${showOldNoteHint ? `<div class="svc-note-hint">${esc(t("servicer_old_note_hint", { note: s.notes }))}</div>` : ""}
        <div id="sf-services" class="svc-picker"></div>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_services_other")}</label>
        <input id="sf-services-other" class="form-input" type="text" value="${esc(s.servicesOther)}" placeholder="${esc(t("servicer_services_other_ph"))}" />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("notes")}</label>
        <textarea id="sf-notes" class="form-input form-textarea" rows="2">${esc(s.notes)}</textarea>
      </div>
    </div>
    <p id="servicer-form-error" class="login-error hidden"></p>
  `;

  // ── ček-lista usluga ────────────────────────────────────────
  const picker = () => document.getElementById("sf-services");

  function categoryItems(cat) {
    const base = cat.items.map(k => ({ key: k, label: t("sp_svc_" + k), custom: false }));
    const custom = customServices
      .filter(c => c.category === cat.key)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "sr"))
      .map(c => ({ key: "c:" + c.id, label: c.name, custom: true, id: c.id }));
    return [...base, ...custom];
  }

  function renderPicker() {
    const host = picker();
    if (!host) return;
    host.innerHTML = `
      ${svcMsg ? `<p class="svc-msg svc-msg--${svcMsg.kind}" role="alert">${esc(svcMsg.text)}</p>` : ""}
      ${SERVICER_SERVICE_CATALOG.map(cat => {
        const items = categoryItems(cat);
        const count = items.filter(i => selected.has(i.key)).length;
        const isOpen = openCats.has(cat.key) || addingCat === cat.key
          || items.some(i => i.id && i.id === renamingId);
        return `
        <details class="svc-cat" data-cat="${cat.key}" ${isOpen ? "open" : ""}>
          <summary class="svc-cat__summary">
            <span class="svc-cat__name">${t("sp_cat_" + cat.key)}</span>
            <span class="svc-cat__count">${count ? esc(t("servicer_svc_selected", { n: count })) : ""}</span>
          </summary>
          <div class="svc-cat__body">
            ${items.map(i => (i.id && i.id === renamingId) ? `
              <div class="svc-edit-row">
                <input class="form-input form-input--sm svc-rename-input" type="text" value="${esc(i.label)}" data-id="${esc(i.id)}" />
                <button type="button" class="btn btn--primary btn--sm" data-act="rename-save" data-id="${esc(i.id)}">${t("servicer_svc_save")}</button>
                <button type="button" class="btn btn--ghost btn--sm" data-act="rename-cancel">${t("servicer_svc_cancel")}</button>
              </div>` : `
              <div class="svc-item">
                <label class="svc-check">
                  <input type="checkbox" data-key="${esc(i.key)}" ${selected.has(i.key) ? "checked" : ""} />
                  <span>${esc(i.label)}</span>
                </label>
                ${i.custom ? `
                  <span class="svc-item__tools">
                    <button type="button" class="svc-tool" data-act="rename" data-id="${esc(i.id)}" title="${esc(t("servicer_svc_rename"))}" aria-label="${esc(t("servicer_svc_rename"))}">✏️</button>
                    <button type="button" class="svc-tool" data-act="delete" data-id="${esc(i.id)}" title="${esc(t("servicer_svc_delete"))}" aria-label="${esc(t("servicer_svc_delete"))}">🗑️</button>
                  </span>` : ""}
              </div>`).join("")}
            ${addingCat === cat.key ? `
              <div class="svc-edit-row">
                <input class="form-input form-input--sm svc-add-input" type="text" placeholder="${esc(t("servicer_svc_add_ph"))}" />
                <button type="button" class="btn btn--primary btn--sm" data-act="add-save" data-cat="${cat.key}">${t("servicer_svc_add_btn")}</button>
                <button type="button" class="btn btn--ghost btn--sm" data-act="add-cancel">${t("servicer_svc_cancel")}</button>
              </div>` : `
              <button type="button" class="svc-add-link" data-act="add-open" data-cat="${cat.key}">${t("servicer_svc_add")}</button>`}
          </div>
        </details>`;
      }).join("")}
    `;
    host.querySelector(".svc-add-input, .svc-rename-input")?.focus();
  }

  // Da li je naziv već zauzet (osnovne usluge + dodate)
  function nameTaken(name, exceptId = null) {
    const n = norm(name);
    const baseTaken = SERVICER_SERVICE_CATALOG.some(c => c.items.some(k => norm(t("sp_svc_" + k)) === n));
    return baseTaken || customServices.some(c => c.id !== exceptId && norm(c.name) === n);
  }

  async function addCustomService(category, rawName) {
    const name = rawName.trim();
    if (!name) { svcMsg = { text: t("servicer_svc_empty_name"), kind: "error" }; return renderPicker(); }
    if (nameTaken(name)) { svcMsg = { text: t("servicer_svc_exists"), kind: "error" }; return renderPicker(); }
    try {
      const ref = await addDoc(catalogRef(), { name, category, createdAt: serverTimestamp() });
      customServices.push({ id: ref.id, name, category });
      selected.add("c:" + ref.id);          // odmah čekirano kod servisera koji se uređuje
      openCats.add(category);
      addingCat = null;
      svcMsg = { text: t("servicer_svc_added"), kind: "ok" };
    } catch (e) {
      svcMsg = { text: `${t("error")}: ${e.message}`, kind: "error" };
    }
    renderPicker();
  }

  async function renameCustomService(id, rawName) {
    const name = rawName.trim();
    const c = customServices.find(x => x.id === id);
    if (!c) { renamingId = null; return renderPicker(); }
    if (!name) { svcMsg = { text: t("servicer_svc_empty_name"), kind: "error" }; return renderPicker(); }
    if (nameTaken(name, id)) { svcMsg = { text: t("servicer_svc_exists"), kind: "error" }; return renderPicker(); }
    try {
      if (name !== c.name) {
        await updateDoc(doc(db, "companies", S.companyId, "serviceCatalog", id), { name, updatedAt: serverTimestamp() });
        c.name = name;
      }
      renamingId = null;
      svcMsg = { text: t("servicer_svc_renamed"), kind: "ok" };
    } catch (e) {
      svcMsg = { text: `${t("error")}: ${e.message}`, kind: "error" };
    }
    renderPicker();
  }

  async function deleteCustomService(id) {
    const c = customServices.find(x => x.id === id);
    if (!c) return;
    try {
      // Sveže stanje iz baze: brisanje je blokirano dok ijedan serviser koristi uslugu
      const users = (await getServiceProviders()).filter(p => Array.isArray(p.services) && p.services.includes("c:" + id));
      if (users.length) {
        const names = users.slice(0, 5).map(u => u.name).join(", ") + (users.length > 5 ? "…" : "");
        svcMsg = { text: t("servicer_svc_in_use", { name: c.name, n: users.length, list: names }), kind: "error" };
        return renderPicker();
      }
      if (!window.confirm(t("servicer_svc_delete_confirm", { name: c.name }))) return;
      await deleteDoc(doc(db, "companies", S.companyId, "serviceCatalog", id));
      customServices = customServices.filter(x => x.id !== id);
      selected.delete("c:" + id);
      svcMsg = { text: t("servicer_svc_deleted"), kind: "ok" };
    } catch (e) {
      svcMsg = { text: `${t("error")}: ${e.message}`, kind: "error" };
    }
    renderPicker();
  }

  function wirePicker() {
    const host = picker();
    if (!host) return;

    // Otvorene/zatvorene kategorije se pamte da preživе ponovno crtanje
    host.addEventListener("toggle", (e) => {
      const d = e.target;
      if (!d.matches?.("details.svc-cat")) return;
      if (d.open) openCats.add(d.dataset.cat); else openCats.delete(d.dataset.cat);
    }, true);

    host.addEventListener("change", (e) => {
      const cb = e.target.closest?.("input[type=checkbox][data-key]");
      if (!cb) return;
      if (cb.checked) selected.add(cb.dataset.key); else selected.delete(cb.dataset.key);
      const details = cb.closest("details.svc-cat");
      const n = details.querySelectorAll("input[type=checkbox]:checked").length;
      details.querySelector(".svc-cat__count").textContent = n ? t("servicer_svc_selected", { n }) : "";
    });

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      const cat = btn.dataset.cat;
      const id = btn.dataset.id;
      svcMsg = null;
      if (act === "add-open")      { addingCat = cat; renamingId = null; renderPicker(); }
      else if (act === "add-cancel")    { addingCat = null; renderPicker(); }
      else if (act === "add-save")      { addCustomService(cat, host.querySelector(".svc-add-input")?.value || ""); }
      else if (act === "rename")        { renamingId = id; addingCat = null; renderPicker(); }
      else if (act === "rename-cancel") { renamingId = null; renderPicker(); }
      else if (act === "rename-save")   { renameCustomService(id, host.querySelector(".svc-rename-input")?.value || ""); }
      else if (act === "delete")        { deleteCustomService(id); }
    });

    host.addEventListener("keydown", (e) => {
      const input = e.target.closest?.(".svc-add-input, .svc-rename-input");
      if (!input) return;
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        svcMsg = null;
        if (input.classList.contains("svc-add-input")) addCustomService(addingCat, input.value);
        else renameCustomService(input.dataset.id, input.value);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        addingCat = null; renamingId = null; svcMsg = null; renderPicker();
      }
    });
  }

  openModal(
    isEdit ? `${t("edit")}: ${s.name}` : t("servicer_add"),
    bodyHTML,
    async () => {
      const name = document.getElementById("sf-name")?.value.trim();
      if (!name) {
        document.getElementById("servicer-form-error").textContent = t("servicer_name_required");
        document.getElementById("servicer-form-error").classList.remove("hidden");
        throw new Error("validation");
      }

      // Ako katalog nije učitan, ne filtriramo (da se ne izgube sačuvane dodate usluge)
      const validKey = (k) => !catalogLoaded || (k.startsWith("c:")
        ? customServices.some(c => "c:" + c.id === k)
        : BASE_SERVICE_KEYS.has(k));

      const data = {
        name,
        address: document.getElementById("sf-address")?.value.trim() || null,
        phone:   document.getElementById("sf-phone")?.value.trim() || null,
        email:   document.getElementById("sf-email")?.value.trim() || null,
        pib:     document.getElementById("sf-pib")?.value.trim() || null,
        mbr:     document.getElementById("sf-mbr")?.value.trim() || null,
        account: document.getElementById("sf-account")?.value.trim() || null,
        services: [...selected].filter(validKey),
        servicesOther: document.getElementById("sf-services-other")?.value.trim() || null,
        notes:   document.getElementById("sf-notes")?.value.trim() || null,
      };

      let newId = null;
      if (isEdit) {
        await updateDoc(doc(db, "companies", S.companyId, "serviceProviders", servicer.id), {
          ...data, updatedAt: serverTimestamp()
        });
      } else {
        newId = (await addDoc(collection(db, "companies", S.companyId, "serviceProviders"), {
          ...data, createdAt: serverTimestamp()
        })).id;
      }

      showToast(t("success"), "success");
      // Lista servisera postoji na ekranu samo kad je otvoren tab "Serviseri"
      if (document.getElementById("servicers-list")) await loadServicers();
      if (opts.onSaved) await opts.onSaved(isEdit ? servicer.id : newId, data);
    }
  );

  // Početni prikaz: osnovne usluge odmah, dodate čim se učita katalog
  SERVICER_SERVICE_CATALOG.forEach(cat => {
    if (cat.items.some(k => selected.has(k))) openCats.add(cat.key);
  });
  wirePicker();
  renderPicker();
  loadCatalog().then((ok) => {
    catalogLoaded = ok;
    customServices.forEach(c => { if (selected.has("c:" + c.id)) openCats.add(c.category); });
    if (!ok) svcMsg = { text: t("servicer_svc_catalog_error"), kind: "error" };
    renderPicker();
  });
}

// ── BRISANJE ──────────────────────────────────────────────────
async function deleteServicer(id) {
  const s = allServicers.find(x => x.id === id);
  if (!s) return;

  const bodyHTML = `<p>${t("servicer_delete_confirm")} <strong>${esc(s.name)}</strong>?</p>`;
  openModal(t("delete") + " " + t("tab_servicers").toLowerCase(), bodyHTML, async () => {
    await deleteDoc(doc(db, "companies", S.companyId, "serviceProviders", id));
    showToast(t("servicer_deleted"), "success");
    openIds.delete(id);
    await loadServicers();
  });
}

// ── EXPORT ZA OSTALE MODULE ───────────────────────────────────
export async function getServiceProviders() {
  if (!S.companyId) return [];
  try {
    const snap = await getDocs(
      query(collection(db, "companies", S.companyId, "serviceProviders"), orderBy("name", "asc"))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}
