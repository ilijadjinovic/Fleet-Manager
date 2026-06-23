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
import { t } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";

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

  // Vozač vidi samo svoje aktivno zaduženje
  await loadActiveAssignment();

  if (!activeAssignment) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <h3>Nemate aktivno zaduženje</h3>
        <p>Kada vam fleet administrator dodeli vozilo, ovde ćete moći da unosite podatke o vožnji.</p>
      </div>
    `;
    return;
  }

  renderDriverView(container);
}

// ── UČITAJ AKTIVNO ZADUŽENJE ──────────────────────────────────
async function loadActiveAssignment() {
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

  // Sumarne statistike
  const totalFuel    = tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalFuelCost= tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelCost || 0), 0);
  const totalTolls   = tripEntries.filter(e => e.type === "toll").reduce((s, e) => s + (e.amount || 0), 0);
  const totalOther   = tripEntries.filter(e => e.type === "other_cost").reduce((s, e) => s + (e.amount || 0), 0);
  const incidents    = tripEntries.filter(e => ["fault","damage","accident"].includes(e.type));

  container.innerHTML = `
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
        <span class="badge badge--active">Aktivno</span>
      </div>
      <div class="trip-vehicle-card__details">
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">Zaduženo</span>
          <span>${formatDate(a.startDate)}</span>
        </div>
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">Početna km</span>
          <span><strong>${a.startKm?.toLocaleString() || "—"} km</strong></span>
        </div>
        ${a.tripType === "intercity" ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">Destinacija</span>
          <span>📍 ${a.destination || "—"}</span>
        </div>
        ` : ""}
        ${a.reason ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">Razlog</span>
          <span>${a.reason}</span>
        </div>
        ` : ""}
      </div>

      <!-- KM POTVRDA -->
      <div class="km-confirm-box" id="km-confirm-box">
        <div class="km-confirm-box__label">Trenutna km na vozilu</div>
        <div class="km-confirm-box__value">${v?.currentKm?.toLocaleString() || a.startKm?.toLocaleString() || "—"} km</div>
        <div class="km-confirm-box__hint">Da li se ovo slaže sa stanjem na brzinomeru?</div>
        <div class="km-confirm-box__actions">
          <button class="btn btn--primary btn--sm" id="btn-confirm-km">✓ Potvrđujem</button>
          <button class="btn btn--secondary btn--sm" id="btn-correct-km">✏️ Unesite tačnu vrednost</button>
        </div>
        <div id="km-correct-form" class="hidden" style="margin-top:10px">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Tačna km na brzinomeru</label>
              <input id="input-actual-km" class="form-input" type="number"
                placeholder="${v?.currentKm || a.startKm || ""}" />
            </div>
            <div style="display:flex;align-items:flex-end">
              <button class="btn btn--primary btn--sm" id="btn-submit-km">Potvrdi</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- STATISTIKE -->
    <div class="trip-stats">
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div>
        <div class="trip-stat-box__label">Gorivo</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${(totalFuelCost + totalTolls + totalOther).toLocaleString()} RSD</div>
        <div class="trip-stat-box__label">Ukupni troškovi</div>
      </div>
      <div class="trip-stat-box ${incidents.length > 0 ? "trip-stat-box--warn" : ""}">
        <div class="trip-stat-box__value">${incidents.length}</div>
        <div class="trip-stat-box__label">Prijave</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${tripEntries.length}</div>
        <div class="trip-stat-box__label">Unosa</div>
      </div>
    </div>

    <!-- AKCIJE -->
    <div class="trip-actions">
      <button class="btn btn--primary" id="btn-add-fuel">⛽ Točenje goriva</button>
      <button class="btn btn--secondary" id="btn-add-toll">🛣️ Putarina / trošak</button>
      <button class="btn btn--warning" id="btn-add-incident">⚠️ Prijava</button>
      <button class="btn btn--danger" id="btn-unassign">🔓 Razduženje</button>
    </div>

    <!-- LISTA UNOSA -->
    <div class="trip-entries-header">
      <h3>Evidencija</h3>
    </div>
    <div id="trip-entries-list">
      ${tripEntries.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>Nema unosa</p></div>`
        : tripEntries.map(e => tripEntryCard(e)).join("")
      }
    </div>
  `;

  // ── Bind events ───────────────────────────────────────────
  bindKmConfirm();
  document.getElementById("btn-add-fuel")?.addEventListener("click", () => openFuelForm());
  document.getElementById("btn-add-toll")?.addEventListener("click", () => openCostForm());
  document.getElementById("btn-add-incident")?.addEventListener("click", () => openIncidentForm());
  document.getElementById("btn-unassign")?.addEventListener("click", () => openDriverUnassignForm());
}

// ── KM POTVRDA ────────────────────────────────────────────────
function bindKmConfirm() {
  const systemKm = activeVehicle?.currentKm || activeAssignment?.startKm;

  document.getElementById("btn-confirm-km")?.addEventListener("click", async () => {
    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">✅ Kilometraža potvrđena: <strong>${systemKm?.toLocaleString()} km</strong></div>
    `;
  });

  document.getElementById("btn-correct-km")?.addEventListener("click", () => {
    document.getElementById("km-correct-form").classList.remove("hidden");
  });

  document.getElementById("btn-submit-km")?.addEventListener("click", async () => {
    const actualKm = Number(document.getElementById("input-actual-km")?.value);
    if (!actualKm || actualKm <= 0) return;

    if (actualKm !== systemKm) {
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

      // Ažuriraj assignment sa flagom
      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), {
        kmMismatch:    true,
        driverStartKm: actualKm,
        updatedAt:     serverTimestamp(),
      });

      showToast("Neslaganje prijavljeno fleet administratoru", "warning");
    }

    // Ažuriraj prikaz
    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">
        ✅ Unesena km: <strong>${actualKm.toLocaleString()} km</strong>
        ${actualKm !== systemKm ? `<span class="km-mismatch-note">(razlika: ${(actualKm - systemKm).toLocaleString()} km)</span>` : ""}
      </div>
    `;
  });
}

// ── FORMA ZA TOČENJE GORIVA ───────────────────────────────────
function openFuelForm() {
  const bodyHTML = `
    <div class="form-section-title">Točenje goriva</div>
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
        <label class="form-label">Cena po litru (RSD)</label>
        <input id="tf-pricePerL" class="form-input" type="number" step="0.01" min="0"
          placeholder="Automatski ako unesete količinu i iznos" readonly />
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
      <label class="form-label">Trenutna km</label>
      <input id="tf-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}"
        placeholder="Km na brzinomeru pri točenju" />
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
    showEntryError("fuel-form-error", "Količina, iznos i naziv pumpe su obavezni");
    return;
  }

  const currentKm = parseFloat(document.getElementById("tf-currentKm")?.value) || null;

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

    // Ažuriraj currentKm na vozilu ako je unesena
    if (currentKm && activeVehicle) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), {
        currentKm, updatedAt: serverTimestamp()
      });
      if (activeVehicle) activeVehicle.currentKm = currentKm;
    }

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("fuel-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── FORMA ZA PUTARINU / TROŠAK ────────────────────────────────
function openCostForm() {
  const bodyHTML = `
    <div class="form-section-title">Trošak</div>
    <div class="form-group">
      <label class="form-label">Vrsta troška *</label>
      <select id="tc-type" class="form-select">
        <option value="toll">🛣️ Putarina</option>
        <option value="parking">🅿️ Parking</option>
        <option value="washing">🚿 Pranje vozila</option>
        <option value="other_cost">📋 Ostalo</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Iznos (RSD) *</label>
        <input id="tc-amount" class="form-input" type="number" min="0" />
      </div>
      <div class="form-group">
        <label class="form-label">Broj računa / priznanice</label>
        <input id="tc-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Lokacija / opis</label>
      <input id="tc-location" class="form-input" type="text" placeholder="npr. Naplatna rampa Batajnica" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="tc-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="cost-form-error" class="login-error hidden"></p>
  `;

  openModal("Dodaj trošak", bodyHTML, () => saveCostEntry());
}

async function saveCostEntry() {
  const amount = parseFloat(document.getElementById("tc-amount")?.value);
  if (!amount || amount <= 0) {
    showEntryError("cost-form-error", "Unesite iznos troška");
    return;
  }

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
      notes:        document.getElementById("tc-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("cost-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── FORMA ZA PRIJAVU ──────────────────────────────────────────
function openIncidentForm() {
  const bodyHTML = `
    <div class="form-section-title">Prijava</div>
    <div class="form-group">
      <label class="form-label">${t("incident_type")} *</label>
      <div class="radio-group" style="flex-direction:column;gap:8px">
        <label class="radio-label">
          <input type="radio" name="ti-type" value="fault" checked />
          🔧 ${t("incident_fault")}
        </label>
        <label class="radio-label">
          <input type="radio" name="ti-type" value="damage" />
          💥 ${t("incident_damage")}
        </label>
        <label class="radio-label">
          <input type="radio" name="ti-type" value="accident" />
          🚨 ${t("incident_accident")}
        </label>
        <label class="radio-label">
          <input type="radio" name="ti-type" value="other" />
          📋 ${t("incident_other")}
        </label>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("incident_description")} *</label>
      <textarea id="ti-description" class="form-textarea"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">${t("incident_location")}</label>
      <input id="ti-location" class="form-input" type="text" placeholder="Gde se dogodilo?" />
    </div>
    <div class="form-group">
      <label class="form-label">Trenutna km</label>
      <input id="ti-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}" />
    </div>
    <p id="incident-form-error" class="login-error hidden"></p>
  `;

  openModal(t("incident_add"), bodyHTML, () => saveIncidentEntry());
}

async function saveIncidentEntry() {
  const description = document.getElementById("ti-description")?.value.trim();
  const type = document.querySelector("input[name='ti-type']:checked")?.value || "fault";

  if (!description) {
    showEntryError("incident-form-error", "Opis je obavezan");
    return;
  }

  try {
    // Snimamo i u tripEntries i u incidents kolekciju
    const incidentData = {
      type,
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      description,
      location:     document.getElementById("ti-location")?.value.trim() || null,
      currentKm:    parseFloat(document.getElementById("ti-currentKm")?.value) || null,
      status:       "open",
      createdAt:    serverTimestamp(),
    };

    await Promise.all([
      addDoc(collection(db, "companies", S.companyId, "tripEntries"), incidentData),
      addDoc(collection(db, "companies", S.companyId, "incidents"), incidentData),
    ]);

    // Notifikacija fleet adminu
    await addDoc(collection(db, "companies", S.companyId, "notifications"), {
      type:         "incident",
      incidentType: type,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverName:   activeAssignment.driverName,
      description,
      status:       "unread",
      createdAt:    serverTimestamp(),
    });

    showToast("Prijava je poslata fleet administratoru", "warning");
    await refreshEntries();
  } catch (e) {
    showEntryError("incident-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── FORMA ZA RAZDUŽENJE (VOZAČ) ───────────────────────────────
function openDriverUnassignForm() {
  const today  = new Date().toISOString().split("T")[0];
  const bodyHTML = `
    <div class="unassign-info">
      <div>🚗 <strong>${activeAssignment.vehicleBrand} ${activeAssignment.vehicleModel}</strong> — ${activeAssignment.vehiclePlate}</div>
      <div>📅 Zaduženo: ${formatDate(activeAssignment.startDate)}</div>
      ${activeAssignment.startKm ? `<div>🛣️ Početna km: ${activeAssignment.startKm.toLocaleString()}</div>` : ""}
    </div>

    <div class="form-section-title" style="margin-top:12px">Razduženje</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Datum razduženja *</label>
        <input id="du-endDate" class="form-input" type="date" value="${today}" />
      </div>
      <div class="form-group">
        <label class="form-label">Krajnja kilometraža *</label>
        <input id="du-endKm" class="form-input" type="number"
          value="${activeVehicle?.currentKm || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Napomena</label>
      <textarea id="du-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="unassign-form-error" class="login-error hidden"></p>
  `;

  openModal("Razduženje vozila", bodyHTML, () => processDriverUnassign());
}

async function processDriverUnassign() {
  const endDate = document.getElementById("du-endDate")?.value;
  const endKm   = parseFloat(document.getElementById("du-endKm")?.value);
  const notes   = document.getElementById("du-notes")?.value.trim();

  if (!endDate) {
    showEntryError("unassign-form-error", "Unesite datum razduženja");
    return;
  }
  if (!endKm || endKm <= 0) {
    showEntryError("unassign-form-error", "Unesite krajnju kilometražu");
    return;
  }

  const startKm = activeAssignment.startKm || 0;
  if (endKm < startKm) {
    showEntryError("unassign-form-error", `Krajnja km (${endKm.toLocaleString()}) ne može biti manja od početne (${startKm.toLocaleString()})`);
    return;
  }

  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "assignments", activeAssignment.id),
      {
        status:        "closed",
        endDate:       new Date(endDate),
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

    showToast("Vozilo je razduže. Hvala!", "success");
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
    fuel:       { icon: "⛽", label: "Točenje goriva",  color: "info" },
    toll:       { icon: "🛣️", label: "Putarina",        color: "inactive" },
    parking:    { icon: "🅿️", label: "Parking",         color: "inactive" },
    washing:    { icon: "🚿", label: "Pranje",           color: "inactive" },
    other_cost: { icon: "📋", label: "Trošak",           color: "inactive" },
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
            ${entry.receiptNo ? ` · Račun: ${entry.receiptNo}` : ""}
            ${entry.currentKm ? ` · ${entry.currentKm.toLocaleString()} km` : ""}
          </div>
        ` : entry.type === "toll" || entry.type === "parking" || entry.type === "washing" || entry.type === "other_cost" ? `
          <div class="trip-entry-card__main">
            <strong>${entry.amount?.toLocaleString()} RSD</strong>
          </div>
          ${entry.location ? `<div class="trip-entry-card__sub">📍 ${entry.location}</div>` : ""}
          ${entry.receiptNo ? `<div class="trip-entry-card__sub">Račun: ${entry.receiptNo}</div>` : ""}
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
      <h2 class="page-title">Evidencija vožnji</h2>
    </div>
    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="admin-trips-search" type="text" class="search-bar__input form-input"
          placeholder="Pretraži po tablici, vozaču..." />
      </div>
      <div class="filter-chips">
        <button class="chip chip--active" data-afilter="all">${t("company_all")}</button>
        <button class="chip" data-afilter="fuel">⛽ Gorivo</button>
        <button class="chip" data-afilter="toll">🛣️ Putarine</button>
        <button class="chip" data-afilter="incident">⚠️ Prijave</button>
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
      ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>Nema unosa</p></div>`
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
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div><div class="trip-stat-box__label">Gorivo</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalCost.toLocaleString()} RSD</div><div class="trip-stat-box__label">Ukupni troškovi</div></div>
      <div class="trip-stat-box ${incidentCount > 0 ? "trip-stat-box--warn" : ""}"><div class="trip-stat-box__value">${incidentCount}</div><div class="trip-stat-box__label">Prijave</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${tripEntries.length}</div><div class="trip-stat-box__label">Unosa</div></div>
    `;
    return div;
  })());
}

// ── UTILS ─────────────────────────────────────────────────────
function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d) ? "—" : d.toLocaleDateString("sr-RS");
}

function showEntryError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
