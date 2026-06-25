// ============================================================
//  vehicles.js  —  Fleet Manager
//  Tab: Vozila — lista, kartica, forma za unos/editovanje
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast, openModal, closeModal } from "./app.js";

// ── STANJE MODULA ─────────────────────────────────────────────
let allVehicles = [];
let currentFilter = "all";
let searchTerm = "";
let currentVehicleId = null; // za detail pogled

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderVehicles(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_vehicles")}</h2>
      ${canEdit ? `<button id="btn-add-vehicle" class="btn btn--primary btn--sm">+ ${t("vehicle_add")}</button>` : ""}
    </div>

    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="vehicle-search" type="text" class="search-bar__input form-input"
          placeholder="${t("search")}..." />
      </div>
      <div class="filter-chips" id="filter-chips">
        <button class="chip chip--active" data-filter="all">${t("company_all")}</button>
        <button class="chip" data-filter="active">${t("vehicle_status_active")}</button>
        <button class="chip" data-filter="service">${t("vehicle_status_service")}</button>
        <button class="chip" data-filter="broken">${t("vehicle_status_broken")}</button>
        <button class="chip" data-filter="unregistered">${t("vehicle_status_unregistered")}</button>
      </div>
    </div>

    <div id="vehicles-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-vehicle")?.addEventListener("click", () => openVehicleForm());
  }

  document.getElementById("vehicle-search")?.addEventListener("input", (e) => {
    searchTerm = e.target.value.toLowerCase();
    renderList();
  });

  document.getElementById("filter-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("chip--active"));
    chip.classList.add("chip--active");
    currentFilter = chip.dataset.filter;
    renderList();
  });

  await loadVehicles();
}

// ── UČITAJ VOZILA ─────────────────────────────────────────────
async function loadVehicles() {
  try {
    const snap = await getDocs(
      query(collection(db, "companies", S.companyId, "vehicles"), orderBy("createdAt", "desc"))
    );
    allVehicles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    document.getElementById("vehicles-list").innerHTML =
      `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── RENDER LISTA ──────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("vehicles-list");
  if (!list) return;

  let filtered = allVehicles;
  if (currentFilter !== "all") filtered = filtered.filter(v => v.status === currentFilter);
  if (searchTerm) {
    filtered = filtered.filter(v =>
      `${v.brand} ${v.model} ${v.plate} ${v.vin}`.toLowerCase().includes(searchTerm)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🚗</div><p>${t("no_data")}</p></div>`;
    return;
  }

  list.innerHTML = `
    <div class="vehicle-grid">
      ${filtered.map(v => vehicleCard(v)).join("")}
    </div>
  `;

  list.querySelectorAll(".vehicle-card").forEach(card => {
    card.addEventListener("click", () => openVehicleDetail(card.dataset.id));
  });
}

// ── VEHICLE CARD (lista) ──────────────────────────────────────
function vehicleCard(v) {
  const today = new Date();
  const regDate = v.regExpiry ? (v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry)) : null;
  const daysToReg = regDate ? Math.ceil((regDate - today) / 86400000) : null;
  const regWarning = daysToReg !== null && daysToReg <= 30;

  return `
    <div class="vehicle-card" data-id="${v.id}">
      <div class="vehicle-card__header">
        <div class="vehicle-card__info">
          <div class="vehicle-card__name">${v.brand} ${v.model}</div>
          <div class="vehicle-card__plate">${v.plate}</div>
        </div>
        <span class="badge badge--${v.status || 'active'}">${t("vehicle_status_" + (v.status || "active"))}</span>
      </div>
      <div class="vehicle-card__details">
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">VIN</span>
          <span class="vehicle-card__detail-value mono">${v.vin || "—"}</span>
        </div>
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">${t("vehicle_current_km")}</span>
          <span class="vehicle-card__detail-value">${v.currentKm ? v.currentKm.toLocaleString() + " km" : "—"}</span>
        </div>
        <div class="vehicle-card__detail ${regWarning ? "vehicle-card__detail--warn" : ""}">
          <span class="vehicle-card__detail-label">${t("vehicle_reg_expiry")}</span>
          <span class="vehicle-card__detail-value">
            ${regDate ? regDate.toLocaleDateString("sr-RS") : "—"}
            ${regWarning ? ` <span class="reg-warn">(${daysToReg}d)</span>` : ""}
          </span>
        </div>
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">${t("vehicle_year")}</span>
          <span class="vehicle-card__detail-value">${v.year || "—"}</span>
        </div>
      </div>
      ${v.assignedDriverName ? `
        <div class="vehicle-card__driver">
          <span>👤</span> ${v.assignedDriverName}
        </div>
      ` : ""}
    </div>
  `;
}

// ── DETAIL POGLED ─────────────────────────────────────────────
async function openVehicleDetail(vehicleId) {
  currentVehicleId = vehicleId;
  const vehicle = allVehicles.find(v => v.id === vehicleId);
  if (!vehicle) return;

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";
  const container = document.getElementById("content");

  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn--ghost btn--sm" id="btn-back">← Nazad</button>
      <div class="detail-header__title">
        <h2>${vehicle.brand} ${vehicle.model}</h2>
        <span class="badge badge--${vehicle.status || 'active'}">${t("vehicle_status_" + (vehicle.status || "active"))}</span>
      </div>
      ${canEdit ? `
        <div class="detail-header__actions">
          <button class="btn btn--secondary btn--sm" id="btn-edit-vehicle">✏️ ${t("edit")}</button>
          <button class="btn btn--danger btn--sm" id="btn-delete-vehicle">🗑️ ${t("delete")}</button>
        </div>
      ` : ""}
    </div>

    <div class="tab-strip" id="vehicle-tabs">
      <button class="tab-strip__btn tab-strip__btn--active" data-vtab="tech">${t("vehicle_tab_tech")}</button>
      <button class="tab-strip__btn" data-vtab="finance">${t("vehicle_tab_finance")}</button>
      <button class="tab-strip__btn" data-vtab="service">${t("vehicle_tab_service")}</button>
      <button class="tab-strip__btn" data-vtab="assignments">${t("vehicle_tab_assignments")}</button>
    </div>

    <div id="vehicle-tab-content"></div>
  `;

  document.getElementById("btn-back")?.addEventListener("click", () => renderVehicles(container));
  if (canEdit) {
    document.getElementById("btn-edit-vehicle")?.addEventListener("click", () => openVehicleForm(vehicle));
    document.getElementById("btn-delete-vehicle")?.addEventListener("click", () => confirmDeleteVehicle(vehicle));
  }

  document.getElementById("vehicle-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-strip__btn");
    if (!btn) return;
    document.querySelectorAll(".tab-strip__btn").forEach(b => b.classList.remove("tab-strip__btn--active"));
    btn.classList.add("tab-strip__btn--active");
    renderVehicleTab(btn.dataset.vtab, vehicle);
  });

  renderVehicleTab("tech", vehicle);
}

// ── VEHICLE TABOVI ────────────────────────────────────────────
function renderVehicleTab(tab, vehicle) {
  const content = document.getElementById("vehicle-tab-content");
  if (!content) return;

  switch (tab) {
    case "tech":     content.innerHTML = renderTechTab(vehicle); break;
    case "finance":  content.innerHTML = renderFinanceTab(vehicle); break;
    case "service":  loadServiceTab(content, vehicle); break;
    case "assignments": loadAssignmentsTab(content, vehicle); break;
  }
}

function renderTechTab(v) {
  const rows = [
    [t("vehicle_brand"),      v.brand],
    [t("vehicle_model"),      v.model],
    [t("vehicle_type"),       v.vehicleType],
    [t("vehicle_plate"),      v.plate],
    [t("vehicle_vin"),        v.vin],
    [t("vehicle_year"),       v.year],
    [t("vehicle_first_reg"),  formatDate(v.firstRegDate)],
    [t("vehicle_engine_cc"),  v.engineCc ? v.engineCc + " cm³" : null],
    [t("vehicle_power_kw"),   v.powerKw ? v.powerKw + " kW" : null],
    [t("vehicle_seats"),      v.seats],
    [t("vehicle_payload"),    v.payload ? v.payload + " kg" : null],
    [t("vehicle_fuel_type"),  v.fuelType ? t("fuel_" + v.fuelType) : null],
    [t("vehicle_color"),      v.color],
    [t("vehicle_current_km"), v.currentKm ? v.currentKm.toLocaleString() + " km" : null],
    [t("vehicle_reg_expiry"), formatDate(v.regExpiry)],
    [t("vehicle_insurance_company"), v.insuranceCompany],
    [t("vehicle_insurance_policy"),  v.insurancePolicy],
    [t("vehicle_insurance_expiry"),  formatDate(v.insuranceExpiry)],
  ];
  return detailTable(rows);
}

function renderFinanceTab(v) {
  const rows = [
    [t("vehicle_purchase_date"),  formatDate(v.purchaseDate)],
    [t("vehicle_purchase_type"),  v.purchaseType],
    [t("vehicle_purchase_value"), v.purchaseValue ? Number(v.purchaseValue).toLocaleString() + " RSD" : null],
  ];
  return detailTable(rows);
}

async function loadServiceTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  const canEdit = S.profile?.role !== "driver";
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "services"),
        where("vehicleId", "==", vehicle.id),
        orderBy("serviceDate", "desc")
      )
    );
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    container.innerHTML = `
      ${canEdit ? `<div style="margin-bottom:12px"><button class="btn btn--primary btn--sm" id="btn-add-service">+ ${t("service_add")}</button></div>` : ""}
      ${services.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">🔧</div><p>${t("no_data")}</p></div>`
        : `<div class="service-list">${services.map(s => serviceItem(s)).join("")}</div>`
      }
    `;

    if (canEdit) {
      document.getElementById("btn-add-service")?.addEventListener("click", () => openServiceForm(vehicle));
    }
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

async function loadAssignmentsTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "assignments"),
        where("vehicleId", "==", vehicle.id),
        orderBy("startDate", "desc")
      )
    );
    const assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    container.innerHTML = assignments.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">🔑</div><p>${t("no_data")}</p></div>`
      : `<div class="assignment-list">${assignments.map(a => assignmentItem(a)).join("")}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── FORMA ZA DODAVANJE / EDITOVANJE ──────────────────────────
function openVehicleForm(vehicle = null) {
  const isEdit = !!vehicle;
  const v = vehicle || {};

  const bodyHTML = `
    <div class="form-section-title">${t("vehicle_tab_tech")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_brand")} *</label>
        <input id="f-brand" class="form-input" type="text" value="${v.brand || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_model")} *</label>
        <input id="f-model" class="form-input" type="text" value="${v.model || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_type")}</label>
        <input id="f-vehicleType" class="form-input" type="text" value="${v.vehicleType || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_plate")} *</label>
        <input id="f-plate" class="form-input" type="text" value="${v.plate || ""}" style="text-transform:uppercase" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_vin")}</label>
      <input id="f-vin" class="form-input" type="text" value="${v.vin || ""}" style="text-transform:uppercase" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_year")}</label>
        <input id="f-year" class="form-input" type="number" min="1990" max="2030" value="${v.year || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_first_reg")}</label>
        <input id="f-firstRegDate" class="form-input" type="date" value="${toDateInput(v.firstRegDate)}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_engine_cc")}</label>
        <input id="f-engineCc" class="form-input" type="number" value="${v.engineCc || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_power_kw")}</label>
        <input id="f-powerKw" class="form-input" type="number" value="${v.powerKw || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_seats")}</label>
        <input id="f-seats" class="form-input" type="number" min="1" max="60" value="${v.seats || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_payload")}</label>
        <input id="f-payload" class="form-input" type="number" value="${v.payload || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_fuel_type")}</label>
        <select id="f-fuelType" class="form-select">
          <option value="">—</option>
          ${["petrol","diesel","lpg","electric","hybrid"].map(ft =>
            `<option value="${ft}" ${v.fuelType === ft ? "selected" : ""}>${t("fuel_" + ft)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_color")}</label>
        <input id="f-color" class="form-input" type="text" value="${v.color || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_status")}</label>
        <select id="f-status" class="form-select">
          ${["active","service","broken","unregistered","inactive"].map(s =>
            `<option value="${s}" ${(v.status || "active") === s ? "selected" : ""}>${t("vehicle_status_" + s)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_current_km")}</label>
        <input id="f-currentKm" class="form-input" type="number" value="${v.currentKm || ""}" />
      </div>
    </div>

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_reg_expiry")} / ${t("vehicle_insurance_company")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_reg_expiry")}</label>
        <input id="f-regExpiry" class="form-input" type="date" value="${toDateInput(v.regExpiry)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_expiry")}</label>
        <input id="f-insuranceExpiry" class="form-input" type="date" value="${toDateInput(v.insuranceExpiry)}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_company")}</label>
        <input id="f-insuranceCompany" class="form-input" type="text" value="${v.insuranceCompany || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_policy")}</label>
        <input id="f-insurancePolicy" class="form-input" type="text" value="${v.insurancePolicy || ""}" />
      </div>
    </div>

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_tab_finance")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_purchase_date")}</label>
        <input id="f-purchaseDate" class="form-input" type="date" value="${toDateInput(v.purchaseDate)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_purchase_type")}</label>
        <input id="f-purchaseType" class="form-input" type="text" value="${v.purchaseType || ""}" placeholder="kupovina, lizing..." />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_purchase_value")}</label>
      <input id="f-purchaseValue" class="form-input" type="number" value="${v.purchaseValue || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="f-notes" class="form-textarea">${v.notes || ""}</textarea>
    </div>
    <p id="vehicle-form-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit ? `${t("edit")}: ${v.brand} ${v.model}` : t("vehicle_add"),
    bodyHTML,
    async () => saveVehicle(vehicle?.id || null)
  );
}

// ── FIELD ERROR HELPER ───────────────────────────────────────
function fieldError(inputId, msg) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.add("input--error");
  el.parentElement.querySelectorAll(".field-error-msg").forEach(e => e.remove());
  const hint = document.createElement("span");
  hint.className = "field-error-msg";
  hint.textContent = msg;
  el.parentElement.appendChild(hint);
  el.addEventListener("input", () => {
    el.classList.remove("input--error");
    hint.remove();
  }, { once: true });
}

function clearFieldErrors() {
  document.querySelectorAll(".input--error").forEach(el => el.classList.remove("input--error"));
  document.querySelectorAll(".field-error-msg").forEach(el => el.remove());
}

// ── SNIMI VOZILO ──────────────────────────────────────────────
async function saveVehicle(vehicleId) {
  clearFieldErrors();

  const brand = document.getElementById("f-brand")?.value.trim();
  const model = document.getElementById("f-model")?.value.trim();
  const plate = document.getElementById("f-plate")?.value.trim().toUpperCase();
  const vin   = document.getElementById("f-vin")?.value.trim().toUpperCase() || null;

  // ── OSNOVNA VALIDACIJA ────────────────────────────────────────
  let valid = true;
  if (!brand) { fieldError("f-brand", "Marka je obavezna"); valid = false; }
  if (!model) { fieldError("f-model", "Model je obavezan"); valid = false; }
  if (!plate) { fieldError("f-plate", "Tablice su obavezne"); valid = false; }
  if (!valid) throw new Error("validation");

  try {
    // ── JEDINSTVENOST TABLICE ─────────────────────────────────
    const plateSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "vehicles"),
      where("plate", "==", plate)
    ));
    const plateConflict = plateSnap.docs.find(d => d.id !== vehicleId);
    if (plateConflict) {
      const v = plateConflict.data();
      fieldError("f-plate", `Tablice već postoje: ${v.brand} ${v.model}`);
      throw new Error("validation");
    }

    // ── JEDINSTVENOST VIN ─────────────────────────────────────
    if (vin) {
      const vinSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "vehicles"),
        where("vin", "==", vin)
      ));
      const vinConflict = vinSnap.docs.find(d => d.id !== vehicleId);
      if (vinConflict) {
        const v = vinConflict.data();
        fieldError("f-vin", `VIN već postoji: ${v.brand} ${v.model} (${v.plate})`);
        throw new Error("validation");
      }
    }

    const data = {
      brand, model, plate, vin,
      vehicleType:      document.getElementById("f-vehicleType")?.value.trim() || null,
      year:             numOrNull("f-year"),
      firstRegDate:     dateOrNull("f-firstRegDate"),
      engineCc:         numOrNull("f-engineCc"),
      powerKw:          numOrNull("f-powerKw"),
      seats:            numOrNull("f-seats"),
      payload:          numOrNull("f-payload"),
      fuelType:         document.getElementById("f-fuelType")?.value || null,
      color:            document.getElementById("f-color")?.value.trim() || null,
      status:           document.getElementById("f-status")?.value || "active",
      currentKm:        numOrNull("f-currentKm"),
      regExpiry:        dateOrNull("f-regExpiry"),
      insuranceExpiry:  dateOrNull("f-insuranceExpiry"),
      insuranceCompany: document.getElementById("f-insuranceCompany")?.value.trim() || null,
      insurancePolicy:  document.getElementById("f-insurancePolicy")?.value.trim() || null,
      purchaseDate:     dateOrNull("f-purchaseDate"),
      purchaseType:     document.getElementById("f-purchaseType")?.value.trim() || null,
      purchaseValue:    numOrNull("f-purchaseValue"),
      notes:            document.getElementById("f-notes")?.value.trim() || null,
    };

    if (vehicleId) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId), {
        ...data, updatedAt: serverTimestamp()
      });
    } else {
      await addDoc(collection(db, "companies", S.companyId, "vehicles"), {
        ...data, createdAt: serverTimestamp()
      });
    }

    showToast(t("success"), "success");
    await loadVehicles();
    const container = document.getElementById("content");
    if (container) renderVehicles(container);

  } catch (e) {
    if (e.message === "validation") throw e;
    showToast(`${t("error")}: ${e.message}`, "error");
    throw e;
  }
}

// ── BRISANJE VOZILA ───────────────────────────────────────────
function confirmDeleteVehicle(vehicle) {
  if (!confirm(t("confirm_delete"))) return;
  deleteDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id))
    .then(() => {
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) renderVehicles(container);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

// ── SERVIS FORMA ──────────────────────────────────────────────
function openServiceForm(vehicle) {
  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_type")} *</label>
        <select id="sf-type" class="form-select">
          ${["regular","tech","tires","repair","other"].map(st =>
            `<option value="${st}">${t("service_type_" + st)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_date")} *</label>
        <input id="sf-date" class="form-input" type="date" value="${new Date().toISOString().split("T")[0]}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_km")}</label>
        <input id="sf-km" class="form-input" type="number" value="${vehicle.currentKm || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_cost")}</label>
        <input id="sf-cost" class="form-input" type="number" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_workshop")}</label>
      <input id="sf-workshop" class="form-input" type="text" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_description")}</label>
      <textarea id="sf-desc" class="form-textarea"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_next_date")}</label>
        <input id="sf-nextDate" class="form-input" type="date" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_next_km")}</label>
        <input id="sf-nextKm" class="form-input" type="number" />
      </div>
    </div>
  `;

  openModal(t("service_add"), bodyHTML, async () => {
    const dateVal = document.getElementById("sf-date")?.value;
    if (!dateVal) return;
    try {
      await addDoc(collection(db, "companies", S.companyId, "services"), {
        vehicleId:   vehicle.id,
        vehiclePlate: vehicle.plate,
        serviceType: document.getElementById("sf-type")?.value,
        serviceDate: new Date(dateVal),
        km:          numOrNull("sf-km"),
        cost:        numOrNull("sf-cost"),
        workshop:    document.getElementById("sf-workshop")?.value.trim() || null,
        description: document.getElementById("sf-desc")?.value.trim() || null,
        nextDate:    dateOrNull("sf-nextDate"),
        nextKm:      numOrNull("sf-nextKm"),
        createdBy:   S.user.uid,
        createdAt:   serverTimestamp(),
      });
      showToast(t("success"), "success");
      // reload service tab
      const content = document.getElementById("vehicle-tab-content");
      if (content) loadServiceTab(content, vehicle);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── HELPERS ───────────────────────────────────────────────────
function detailTable(rows) {
  return `
    <div class="detail-table">
      ${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([label, value]) => `
        <div class="detail-row">
          <div class="detail-row__label">${label}</div>
          <div class="detail-row__value">${value}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function serviceItem(s) {
  return `
    <div class="service-item">
      <div class="service-item__header">
        <span class="badge badge--info">${t("service_type_" + s.serviceType) || s.serviceType}</span>
        <span class="service-item__date">${formatDate(s.serviceDate)}</span>
      </div>
      ${s.description ? `<div class="service-item__desc">${s.description}</div>` : ""}
      <div class="service-item__meta">
        ${s.km ? `<span>📍 ${s.km.toLocaleString()} km</span>` : ""}
        ${s.cost ? `<span>💰 ${s.cost.toLocaleString()} RSD</span>` : ""}
        ${s.workshop ? `<span>🔧 ${s.workshop}</span>` : ""}
      </div>
      ${s.nextDate ? `<div class="service-item__next">Sledeći: ${formatDate(s.nextDate)}${s.nextKm ? " / " + s.nextKm.toLocaleString() + " km" : ""}</div>` : ""}
    </div>
  `;
}

function assignmentItem(a) {
  return `
    <div class="assignment-item">
      <div class="assignment-item__header">
        <span class="badge badge--${a.status === 'active' ? 'active' : 'inactive'}">
          ${t("assignment_status_" + a.status)}
        </span>
        <span class="assignment-item__dates">
          ${formatDate(a.startDate)} ${a.endDate ? "→ " + formatDate(a.endDate) : ""}
        </span>
      </div>
      <div class="assignment-item__driver">👤 ${a.driverName || "—"}</div>
      <div class="assignment-item__km">
        ${a.startKm ? a.startKm.toLocaleString() + " km" : ""}
        ${a.endKm ? " → " + a.endKm.toLocaleString() + " km" : ""}
      </div>
      ${a.reason ? `<div class="assignment-item__reason">${a.reason}</div>` : ""}
      ${a.tripType === "intercity" && a.destination ? `<div class="assignment-item__dest">📍 ${a.destination}</div>` : ""}
    </div>
  `;
}

function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d) ? "—" : d.toLocaleDateString("sr-RS");
}

function toDateInput(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  return d.toISOString().split("T")[0];
}

function numOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? Number(val) : null;
}

function dateOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? new Date(val) : null;
}
