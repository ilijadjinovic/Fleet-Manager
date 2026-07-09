// ============================================================
//  trips.js  —  Fleet Manager
//  Tab: Moje vožnje (vozački tab)
//  Prikazuje aktivno zaduženje i sve unose tokom njega
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc,
  addDoc, updateDoc, serverTimestamp, where, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { openIncidentForm } from "./incidents.js";

// ── STANJE MODULA ─────────────────────────────────────────────
let activeAssignment = null;
let activeVehicle    = null;
let tripEntries      = []; // svi unosi tokom zaduženja

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderTrips(container) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;

  // Fleet admin / master admin vide sve vožnje
  if (S.profile?.role !== "driver") {
    await renderAdminView(container);
    return;
  }

  // Vozač vidi samo svoje aktivno zaduženje (istorija je na tabu "Pregled")
  await loadActiveAssignment();

  if (!activeAssignment) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <h3>${t("trip_no_assignment")}</h3>
        <p>${t("trip_no_assignment_sub")}</p>
      </div>
    `;
    return;
  }

  renderDriverView(container);
}

// ── UČITAJ AKTIVNO ZADUŽENJE ──────────────────────────────────
async function loadActiveAssignment() {
  activeAssignment = null;
  activeVehicle    = null;
  tripEntries      = [];

  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverUid", "==", S.user.uid),
      where("status", "==", "active")
    ));

    if (snap.empty) {
      // Pokušaj po driverId
      const profile = S.profile;
      if (profile?.driverId) {
        const snap2 = await getDocs(query(
          collection(db, "companies", S.companyId, "assignments"),
          where("driverId", "==", profile.driverId),
          where("status", "==", "active")
        ));
        if (!snap2.empty) {
          activeAssignment = { id: snap2.docs[0].id, ...snap2.docs[0].data() };
        }
      }
    } else {
      activeAssignment = { id: snap.docs[0].id, ...snap.docs[0].data() };
    }

    if (!activeAssignment) return;

    // Učitaj vozilo
    const vehicleSnap = await getDoc(
      doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId)
    );
    activeVehicle = vehicleSnap.exists()
      ? { id: vehicleSnap.id, ...vehicleSnap.data() }
      : null;

    // Učitaj sve unose za ovo zaduženje
    const entriesSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "tripEntries"),
      where("assignmentId", "==", activeAssignment.id),
      orderBy("createdAt", "desc")
    ));
    tripEntries = entriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  } catch (e) {
    console.error("loadActiveAssignment error:", e);
  }
}

// ── VOZAČKI PRIKAZ ────────────────────────────────────────────
function renderDriverView(container) {
  const a = activeAssignment;
  const v = activeVehicle;

  // Sumarne statistike (samo za aktivno zaduženje)
  const totalFuel    = tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalFuelCost= tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelCost || 0), 0);
  const totalTolls   = tripEntries.filter(e => e.type === "toll").reduce((s, e) => s + (e.amount || 0), 0);
  const totalOther   = tripEntries.filter(e => e.type === "other_cost").reduce((s, e) => s + (e.amount || 0), 0);
  const incidents    = tripEntries.filter(e => ["fault","damage","accident"].includes(e.type));

  const activeSectionHTML = a ? `
    <!-- HEADER VOZILA -->
    <div class="trip-vehicle-card">
      <div class="trip-vehicle-card__header">
        <div class="trip-vehicle-card__title">
          <span class="trip-vehicle-card__icon">🚗</span>
          <div>
            <div class="trip-vehicle-card__name">${a.vehicleBrand} ${a.vehicleModel}</div>
            <div class="trip-vehicle-card__plate">${a.vehiclePlate}</div>
          </div>
        </div>
        <span class="badge badge--active">${t("trip_active_badge")}</span>
      </div>
      <div class="trip-vehicle-card__details">
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_assigned_label")}</span>
          <span>${formatDate(a.startDate)}</span>
        </div>
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_start_km_label")}</span>
          <span><strong>${a.startKm?.toLocaleString() || "—"} km</strong></span>
        </div>
        ${a.tripType === "intercity" ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_destination_label")}</span>
          <span>📍 ${a.destination || "—"}</span>
        </div>
        ` : ""}
        ${a.reason ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_reason_label")}</span>
          <span>${a.reason}</span>
        </div>
        ` : ""}
      </div>

      <!-- KM POTVRDA -->
      <div class="km-confirm-box" id="km-confirm-box">
        ${kmConfirmBoxContent(a, v)}
      </div>
    </div>

    <!-- STATISTIKE -->
    <div class="trip-stats">
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div>
        <div class="trip-stat-box__label">${t("trip_stats_fuel")}</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${(totalFuelCost + totalTolls + totalOther).toLocaleString()} RSD</div>
        <div class="trip-stat-box__label">${t("trip_stats_cost")}</div>
      </div>
      <div class="trip-stat-box ${incidents.length > 0 ? "trip-stat-box--warn" : ""}">
        <div class="trip-stat-box__value">${incidents.length}</div>
        <div class="trip-stat-box__label">${t("trip_stats_incidents")}</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${tripEntries.length}</div>
        <div class="trip-stat-box__label">${t("trip_stats_entries")}</div>
      </div>
    </div>

    <!-- AKCIJE -->
    <div class="trip-actions">
      <button class="btn btn--primary" id="btn-add-fuel">⛽ ${t("trip_fuel_btn")}</button>
      <button class="btn btn--secondary" id="btn-add-toll">🛣️ ${t("trip_cost_btn")}</button>
      <button class="btn btn--warning" id="btn-add-incident">⚠️ ${t("trip_incident_btn")}</button>
      <button class="btn btn--danger" id="btn-unassign">🔓 ${t("trip_unassign_btn")}</button>
    </div>

    <!-- LISTA UNOSA -->
    <div class="trip-entries-header">
      <h3>${t("trip_entries_header")}</h3>
    </div>
    <div id="trip-entries-list">
      ${tripEntries.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
        : tripEntries.map(e => tripEntryCard(e)).join("")
      }
    </div>
  ` : `
    <div class="empty-state">
      <div class="empty-state__icon">🚗</div>
      <h3>${t("trip_no_assignment")}</h3>
      <p>${t("trip_no_assignment_sub")}</p>
    </div>
  `;

  container.innerHTML = activeSectionHTML;

  // ── Bind events (samo ako postoji aktivno zaduženje) ──────
  if (a) {
    bindKmConfirm();
    document.getElementById("btn-add-fuel")?.addEventListener("click", () => openFuelForm());
    document.getElementById("btn-add-toll")?.addEventListener("click", () => openCostForm());
    document.getElementById("btn-add-incident")?.addEventListener("click", () => openIncidentForm(null, refreshEntries));
    document.getElementById("btn-unassign")?.addEventListener("click", () => openDriverUnassignForm());
  }
}

// ── KM POTVRDA — sadržaj boksa (potvrđeno vs. forma) ───────────
function kmConfirmBoxContent(a, v) {
  const systemKm = v?.currentKm ?? a.startKm;

  if (a.kmConfirmed) {
    const val = a.kmConfirmedValue ?? systemKm;
    return `
      <div class="km-confirmed">
        ✅ ${t("trip_km_confirmed")}: <strong>${val?.toLocaleString()} km</strong>
        ${a.kmMismatch ? `<span class="km-mismatch-note">${t("trip_km_mismatch_reported")}</span>` : ""}
      </div>
    `;
  }

  return `
    <div class="km-confirm-box__label">${t("trip_km_system")}</div>
    <div class="km-confirm-box__value">${systemKm?.toLocaleString() || "—"} km</div>
    <div class="km-confirm-box__hint">${t("trip_km_confirm_hint")}</div>
    <div class="km-confirm-box__actions">
      <button class="btn btn--primary btn--sm" id="btn-confirm-km">✓ ${t("trip_km_confirm")}</button>
      <button class="btn btn--secondary btn--sm" id="btn-correct-km">✏️ ${t("trip_km_enter_actual")}</button>
    </div>
    <div id="km-correct-form" class="hidden" style="margin-top:10px">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("trip_km_actual_ph")}</label>
          <input id="input-actual-km" class="form-input" type="number"
            placeholder="${systemKm || ""}" />
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn--primary btn--sm" id="btn-submit-km">${t("trip_km_confirm")}</button>
        </div>
      </div>
    </div>
  `;
}

// ── POSLEDNJA VAŽEĆA KILOMETRAŽA (referenca za validaciju) ─────
// Sve od ovog trenutka nadalje (gorivo, troškovi, prijave, razduženje)
// mora biti >= od ove vrednosti. Ažurira se na vehicle.currentKm
// posle svakog unosa koji sadrži km.
function getLastKnownKm() {
  return activeVehicle?.currentKm ?? activeAssignment?.startKm ?? 0;
}

// Validira uneti km string: obavezan je i mora biti >= poslednje važeće.
// Vraća broj ili null (i ispisuje grešku) ako validacija ne prođe.
function validateKmInput(rawValue, errorElId) {
  const km = parseFloat(rawValue);
  if (!rawValue || isNaN(km) || km <= 0) {
    showEntryError(errorElId, t("required_field") + ": " + t("trip_current_km"));
    return null;
  }
  const lastKm = getLastKnownKm();
  if (km < lastKm) {
    showEntryError(errorElId, `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`);
    return null;
  }
  return km;
}

// Upisuje novu km na vozilo (Firestore) i ažurira lokalno stanje.
async function bumpVehicleKm(newKm) {
  await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), {
    currentKm: newKm,
    updatedAt: serverTimestamp(),
  });
  if (activeVehicle) activeVehicle.currentKm = newKm;
  else activeVehicle = { id: activeAssignment.vehicleId, currentKm: newKm };
}

// ── KM POTVRDA ────────────────────────────────────────────────
function bindKmConfirm() {
  const systemKm = activeVehicle?.currentKm ?? activeAssignment?.startKm;

  document.getElementById("btn-confirm-km")?.addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), {
        kmConfirmed:      true,
        kmConfirmedValue: systemKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      });
      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = systemKm;
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">✅ ${t("trip_km_confirmed")}: <strong>${systemKm?.toLocaleString()} km</strong></div>
    `;
  });

  document.getElementById("btn-correct-km")?.addEventListener("click", () => {
    document.getElementById("km-correct-form").classList.remove("hidden");
  });

  document.getElementById("btn-submit-km")?.addEventListener("click", async () => {
    const actualKm = Number(document.getElementById("input-actual-km")?.value);
    if (!actualKm || actualKm <= 0) return;

    const mismatch = actualKm !== systemKm;

    try {
      const updateData = {
        kmConfirmed:      true,
        kmConfirmedValue: actualKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      };

      if (mismatch) {
        updateData.kmMismatch    = true;
        updateData.driverStartKm = actualKm;

        // Snimi neslaganje i pošalji notifikaciju fleet adminu
        await addDoc(collection(db, "companies", S.companyId, "notifications"), {
          type:         "km_mismatch",
          assignmentId: activeAssignment.id,
          vehicleId:    activeAssignment.vehicleId,
          vehiclePlate: activeAssignment.vehiclePlate,
          driverId:     S.profile.driverId,
          driverName:   activeAssignment.driverName,
          systemKm,
          driverKm:     actualKm,
          status:       "unread",
          createdAt:    serverTimestamp(),
        });
      }

      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), updateData);

      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = actualKm;
      if (mismatch) activeAssignment.kmMismatch = true;

      if (mismatch) showToast(t("trip_km_mismatch_reported"), "warning");
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    // Ažuriraj prikaz
    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">
        ✅ Unesena km: <strong>${actualKm.toLocaleString()} km</strong>
        ${mismatch ? `<span class="km-mismatch-note">(razlika: ${(actualKm - systemKm).toLocaleString()} km)</span>` : ""}
      </div>
    `;
  });
}

// ── FORMA ZA TOČENJE GORIVA ───────────────────────────────────
function openFuelForm() {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_fuel_header")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_type")} *</label>
        <select id="tf-fuelType" class="form-select">
          <option value="diesel">${t("fuel_diesel")}</option>
          <option value="petrol">${t("fuel_petrol")}</option>
          <option value="lpg">${t("fuel_lpg")}</option>
          <option value="electric">${t("fuel_electric")}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_amount")} (L) *</label>
        <input id="tf-fuelAmount" class="form-input" type="number" step="0.01" min="0" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price")} (RSD) *</label>
        <input id="tf-fuelCost" class="form-input" type="number" min="0" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price_per_l")}</label>
        <input id="tf-pricePerL" class="form-input" type="number" step="0.01" min="0"
          placeholder="${t("trip_fuel_price_per_l_ph")}" readonly />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_station")} *</label>
        <input id="tf-fuelStation" class="form-input" type="text" placeholder="npr. NIS Petrol" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt")}</label>
        <input id="tf-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_current_km")} *</label>
      <input id="tf-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}"
        placeholder="${t('trip_current_km')}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="tf-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="fuel-form-error" class="login-error hidden"></p>
  `;

  openModal(t("trip_with_fueling"), bodyHTML, () => saveFuelEntry());

  // Auto-izračun cene po litru
  const calcPrice = () => {
    const amount = parseFloat(document.getElementById("tf-fuelAmount")?.value);
    const cost   = parseFloat(document.getElementById("tf-fuelCost")?.value);
    if (amount > 0 && cost > 0) {
      document.getElementById("tf-pricePerL").value = (cost / amount).toFixed(2);
    }
  };
  setTimeout(() => {
    document.getElementById("tf-fuelAmount")?.addEventListener("input", calcPrice);
    document.getElementById("tf-fuelCost")?.addEventListener("input", calcPrice);
  }, 100);
}

async function saveFuelEntry() {
  const fuelAmount  = parseFloat(document.getElementById("tf-fuelAmount")?.value);
  const fuelCost    = parseFloat(document.getElementById("tf-fuelCost")?.value);
  const fuelStation = document.getElementById("tf-fuelStation")?.value.trim();

  if (!fuelAmount || !fuelCost || !fuelStation) {
    showEntryError("fuel-form-error", t("required_field"));
    return;
  }

  const currentKm = validateKmInput(document.getElementById("tf-currentKm")?.value, "fuel-form-error");
  if (currentKm === null) return;

  try {
    await addDoc(collection(db, "companies", S.companyId, "tripEntries"), {
      type:         "fuel",
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      fuelType:     document.getElementById("tf-fuelType")?.value,
      fuelAmount,
      fuelCost,
      pricePerL:    fuelAmount > 0 ? fuelCost / fuelAmount : null,
      fuelStation,
      receiptNo:    document.getElementById("tf-receiptNo")?.value.trim() || null,
      currentKm,
      notes:        document.getElementById("tf-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("fuel-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── FORMA ZA PUTARINU / TROŠAK ────────────────────────────────
function openCostForm() {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_cost_header")}</div>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_type")}</label>
      <select id="tc-type" class="form-select">
        <option value="toll">🛣️ ${t("trip_cost_toll")}</option>
        <option value="parking">🅿️ ${t("trip_cost_parking")}</option>
        <option value="washing">🚿 ${t("trip_cost_washing")}</option>
        <option value="other_cost">📋 ${t("trip_cost_other")}</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_cost_amount")}</label>
        <input id="tc-amount" class="form-input" type="number" min="0" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_cost_receipt")}</label>
        <input id="tc-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_location")}</label>
      <input id="tc-location" class="form-input" type="text" placeholder="${t("trip_cost_location_ph")}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_current_km")} *</label>
      <input id="tc-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}"
        placeholder="${t('trip_current_km')}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="tc-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="cost-form-error" class="login-error hidden"></p>
  `;

  openModal(t("trip_cost_add"), bodyHTML, () => saveCostEntry());
}

async function saveCostEntry() {
  const amount = parseFloat(document.getElementById("tc-amount")?.value);
  if (!amount || amount <= 0) {
    showEntryError("cost-form-error", t("required_field"));
    return;
  }

  const currentKm = validateKmInput(document.getElementById("tc-currentKm")?.value, "cost-form-error");
  if (currentKm === null) return;

  try {
    await addDoc(collection(db, "companies", S.companyId, "tripEntries"), {
      type:         document.getElementById("tc-type")?.value || "other_cost",
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      amount,
      receiptNo:    document.getElementById("tc-receiptNo")?.value.trim() || null,
      location:     document.getElementById("tc-location")?.value.trim() || null,
      currentKm,
      notes:        document.getElementById("tc-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("cost-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── FORMA ZA RAZDUŽENJE (VOZAČ) ───────────────────────────────
function openDriverUnassignForm() {
  const bodyHTML = `
    <div class="unassign-info">
      <div>🚗 <strong>${activeAssignment.vehicleBrand} ${activeAssignment.vehicleModel}</strong> — ${activeAssignment.vehiclePlate}</div>
      <div>📅 ${t("trip_assigned_label")}: ${formatDate(activeAssignment.startDate)}</div>
      ${activeAssignment.startKm ? `<div>🛣️ ${t("assignment_start_km")}: ${activeAssignment.startKm.toLocaleString()}</div>` : ""}
    </div>

    <div class="form-section-title" style="margin-top:12px">${t("assignment_unassign_title")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("assignment_unassign_date_label")}</label>
        <input id="du-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_end_km")}</label>
        <input id="du-endKm" class="form-input" type="number"
          value="${activeVehicle?.currentKm || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="du-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="unassign-form-error" class="login-error hidden"></p>
  `;

  openModal(t("assignment_unassign") + " " + t("assignment_vehicle").toLowerCase(), bodyHTML, () => processDriverUnassign());
  attachDateMask("du-endDate");
}

async function processDriverUnassign() {
  const endDate = document.getElementById("du-endDate")?.value;
  const endKm   = parseFloat(document.getElementById("du-endKm")?.value);
  const notes   = document.getElementById("du-notes")?.value.trim();

  if (!endDate) {
    showEntryError("unassign-form-error", t("assignment_unassign_date_required"));
    return;
  }
  const endDateObj = parseDMY(endDate);
  if (!endDateObj) {
    showEntryError("unassign-form-error", t("assignment_unassign_date_required"));
    return;
  }
  if (!endKm || endKm <= 0) {
    showEntryError("unassign-form-error", t("assignment_unassign_endkm_required"));
    return;
  }

  const lastKm = getLastKnownKm();
  if (endKm < lastKm) {
    showEntryError("unassign-form-error", `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`);
    return;
  }

  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "assignments", activeAssignment.id),
      {
        status:        "closed",
        endDate:       endDateObj,
        endKm,
        unassignNotes: notes || null,
        closedByDriver: true,
        updatedAt:     serverTimestamp(),
      }
    );

    await updateDoc(
      doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId),
      {
        currentKm:          endKm,
        assignedDriverName: null,
        updatedAt:          serverTimestamp(),
      }
    );

    showToast(t("unassign_success"), "success");
    activeAssignment = null;
    activeVehicle    = null;
    tripEntries      = [];

    const container = document.getElementById("content");
    if (container) renderTrips(container);
  } catch (e) {
    showEntryError("unassign-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── ENTRY CARD ────────────────────────────────────────────────
function tripEntryCard(entry) {
  const typeConfig = {
    fuel:       { icon: "⛽", label: t("trip_entry_fuel"),   color: "info" },
    toll:       { icon: "🛣️", label: t("trip_entry_toll"),   color: "inactive" },
    parking:    { icon: "🅿️", label: t("trip_entry_parking"), color: "inactive" },
    washing:    { icon: "🚿", label: t("trip_entry_washing"), color: "inactive" },
    other_cost: { icon: "📋", label: t("trip_entry_cost"),   color: "inactive" },
    fault:      { icon: "🔧", label: t("incident_fault"),   color: "service" },
    damage:     { icon: "💥", label: t("incident_damage"),  color: "broken" },
    accident:   { icon: "🚨", label: t("incident_accident"),color: "broken" },
    other:      { icon: "📋", label: t("incident_other"),   color: "inactive" },
  };

  const cfg = typeConfig[entry.type] || { icon: "📋", label: entry.type, color: "inactive" };

  return `
    <div class="trip-entry-card">
      <div class="trip-entry-card__type">
        <span class="trip-entry-card__icon">${cfg.icon}</span>
        <span class="badge badge--${cfg.color}">${cfg.label}</span>
      </div>
      <div class="trip-entry-card__content">
        ${entry.type === "fuel" ? `
          <div class="trip-entry-card__main">
            <strong>${entry.fuelAmount} L</strong> ${entry.fuelType ? t("fuel_" + entry.fuelType) : ""}
            — <strong>${entry.fuelCost?.toLocaleString()} RSD</strong>
            ${entry.pricePerL ? `(${entry.pricePerL.toFixed(2)} RSD/L)` : ""}
          </div>
          <div class="trip-entry-card__sub">
            🏪 ${entry.fuelStation}
            ${entry.receiptNo ? ` · ${t("trip_fuel_receipt")}: ${entry.receiptNo}` : ""}
            ${entry.currentKm ? ` · ${entry.currentKm.toLocaleString()} km` : ""}
          </div>
        ` : entry.type === "toll" || entry.type === "parking" || entry.type === "washing" || entry.type === "other_cost" ? `
          <div class="trip-entry-card__main">
            <strong>${entry.amount?.toLocaleString()} RSD</strong>
          </div>
          ${entry.location ? `<div class="trip-entry-card__sub">📍 ${entry.location}</div>` : ""}
          ${entry.receiptNo ? `<div class="trip-entry-card__sub">${t("trip_fuel_receipt")}: ${entry.receiptNo}</div>` : ""}
          ${entry.currentKm ? `<div class="trip-entry-card__sub">🛣️ ${entry.currentKm.toLocaleString()} km</div>` : ""}
        ` : `
          <div class="trip-entry-card__main">${entry.description || ""}</div>
          ${entry.location ? `<div class="trip-entry-card__sub">📍 ${entry.location}</div>` : ""}
          ${entry.currentKm ? `<div class="trip-entry-card__sub">🛣️ ${entry.currentKm.toLocaleString()} km</div>` : ""}
        `}
        ${entry.notes ? `<div class="trip-entry-card__notes">${entry.notes}</div>` : ""}
      </div>
      <div class="trip-entry-card__date">${formatDate(entry.createdAt)}</div>
    </div>
  `;
}

// ── ADMIN PRIKAZ ──────────────────────────────────────────────
async function renderAdminView(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("trip_admin_title")}</h2>
    </div>
    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="admin-trips-search" type="text" class="search-bar__input form-input"
          placeholder="${t('search')}..." />
      </div>
      <div class="filter-chips">
        <button class="chip chip--active" data-afilter="all">${t("company_all")}</button>
        <button class="chip" data-afilter="fuel">⛽ ${t("trip_filter_fuel")}</button>
        <button class="chip" data-afilter="toll">🛣️ ${t("trip_filter_tolls")}</button>
        <button class="chip" data-afilter="incident">⚠️ ${t("trip_filter_incidents")}</button>
      </div>
    </div>
    <div id="admin-trips-list"><div class="loading">${t("loading")}</div></div>
  `;

  let allEntries = [];
  let adminFilter = "all";
  let adminSearch = "";

  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "tripEntries"),
      orderBy("createdAt", "desc")
    ));
    allEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminList(allEntries, adminFilter, adminSearch);
  } catch (e) {
    document.getElementById("admin-trips-list").innerHTML =
      `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }

  document.getElementById("admin-trips-search")?.addEventListener("input", (e) => {
    adminSearch = e.target.value.toLowerCase();
    renderAdminList(allEntries, adminFilter, adminSearch);
  });

  document.querySelectorAll("[data-afilter]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-afilter]").forEach(c => c.classList.remove("chip--active"));
      chip.classList.add("chip--active");
      adminFilter = chip.dataset.afilter;
      renderAdminList(allEntries, adminFilter, adminSearch);
    });
  });
}

function renderAdminList(entries, filter, search) {
  const list = document.getElementById("admin-trips-list");
  if (!list) return;

  let filtered = entries;
  if (filter === "fuel")     filtered = filtered.filter(e => e.type === "fuel");
  if (filter === "toll")     filtered = filtered.filter(e => e.type === "toll" || e.type === "parking");
  if (filter === "incident") filtered = filtered.filter(e => ["fault","damage","accident"].includes(e.type));
  if (search) filtered = filtered.filter(e =>
    `${e.vehiclePlate} ${e.driverName} ${e.fuelStation || ""} ${e.location || ""} ${e.description || ""}`
      .toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("no_data")}</p></div>`;
    return;
  }

  list.innerHTML = `<div class="trip-entries-admin">${filtered.map(e => `
    <div class="trip-entry-admin">
      <div class="trip-entry-admin__meta">
        <span class="trip-entry-admin__plate">${e.vehiclePlate}</span>
        <span class="trip-entry-admin__driver">👤 ${e.driverName}</span>
        <span class="trip-entry-admin__date">${formatDate(e.createdAt)}</span>
      </div>
      ${tripEntryCard(e)}
    </div>
  `).join("")}</div>`;
}

// ── REFRESH ENTRIES ───────────────────────────────────────────
async function refreshEntries() {
  if (!activeAssignment) return;
  const snap = await getDocs(query(
    collection(db, "companies", S.companyId, "tripEntries"),
    where("assignmentId", "==", activeAssignment.id),
    orderBy("createdAt", "desc")
  ));
  tripEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const listEl = document.getElementById("trip-entries-list");
  if (listEl) {
    listEl.innerHTML = tripEntries.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
      : tripEntries.map(e => tripEntryCard(e)).join("");
  }

  // Ažuriraj statistike
  const totalFuel     = tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalCost     = tripEntries.reduce((s, e) => s + (e.fuelCost || 0) + (e.amount || 0), 0);
  const incidentCount = tripEntries.filter(e => ["fault","damage","accident"].includes(e.type)).length;

  document.querySelector(".trip-stats")?.replaceWith((() => {
    const div = document.createElement("div");
    div.className = "trip-stats";
    div.innerHTML = `
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div><div class="trip-stat-box__label">${t("trip_stats_fuel")}</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalCost.toLocaleString()} RSD</div><div class="trip-stat-box__label">${t("trip_stats_cost")}</div></div>
      <div class="trip-stat-box ${incidentCount > 0 ? "trip-stat-box--warn" : ""}"><div class="trip-stat-box__value">${incidentCount}</div><div class="trip-stat-box__label">${t("trip_stats_incidents")}</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${tripEntries.length}</div><div class="trip-stat-box__label">${t("trip_stats_entries")}</div></div>
    `;
    return div;
  })());
}

// ── UTILS ─────────────────────────────────────────────────────
function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

function showEntryError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

// ── DATUMI: prikaz i unos u lokalnom formatu dd/mm/yyyy ──────
// <input type="date"> prikazuje kalendar u formatu koji zavisi od
// jezika/regije podešene u browseru korisnika, ne od jezika aplikacije,
// pa koristimo tekstualno polje sa maskom umesto toga.
function todayDMY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Placeholder prati jezik aplikacije (dd/mm ostaje fiksno — poslovno
// pravilo firme — menja se samo naziv za "godinu": yyyy (en) / gggg (sr)).
function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd/mm/yyyy" : "dd/mm/gggg";
}

function parseDMY(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function attachDateMask(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    el.value = out;
  });
}
