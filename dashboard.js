// ============================================================
//  dashboard.js  —  Fleet Manager
//  Tab: Pregled / Dashboard
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, orderBy
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, setActiveCompany, navigateTo } from "./app.js";
import { getCompanies } from "./firebase.js";
import { isVehicleRegistered, openVehicleDetail } from "./vehicles.js";
import { mountPendingBanner } from "./pending-requests.js";
import { effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS } from "./service-status.js";

export async function renderDashboard(container) {
  const isMasterAdmin = S.profile?.role === "master_admin";

  // Master admin company switcher
  let companySwitcherHTML = "";
  if (isMasterAdmin) {
    try {
      S.companies = await getCompanies();
      companySwitcherHTML = `
        <div class="company-switcher">
          <label class="form-label" data-i18n="company_select">${t("company_select")}</label>
          <select id="company-select" class="form-select">
            <option value="" ${!S.companyId ? "selected" : ""}>${t("company_all")}</option>
            ${S.companies.map(c => `
              <option value="${c.id}" ${S.companyId === c.id ? "selected" : ""}>${c.name}</option>
            `).join("")}
          </select>
        </div>
      `;
    } catch (e) {
      console.error("Error loading companies:", e);
    }
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title" data-i18n="tab_dashboard">${t("tab_dashboard")}</h2>
      ${companySwitcherHTML}
    </div>
    ${isMasterAdmin ? `<div id="pending-banner-section"></div>` : ""}
    <div id="dashboard-content">
      <div class="loading">${t("loading")}</div>
    </div>
  `;

  // Company switcher event
  if (isMasterAdmin) {
    document.getElementById("company-select")?.addEventListener("change", (e) => {
      setActiveCompany(e.target.value || null);
    });
    // Baner "Zahtevi za pristup" — nezavisan od izabrane firme,
    // pending zahtevi mogu biti za bilo koju firmu.
    mountPendingBanner(document.getElementById("pending-banner-section"), { compact: true });
  }

  if (!S.companyId) {
    if (isMasterAdmin && S.companies.length > 0) {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">🏢</div>
          <p>${t("company_select")}</p>
        </div>
      `;
    } else {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">⚠️</div>
          <p>${t("no_data")}</p>
        </div>
      `;
    }
    return;
  }

  await loadDashboardData();
}

async function loadDashboardData() {
  const cid = S.companyId;
  const role = S.profile?.role;
  const content = document.getElementById("dashboard-content");
  if (!content) return;

  try {
    // Dohvati vozila
    const vehiclesSnap = await getDocs(collection(db, "companies", cid, "vehicles"));
    const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Arhivirana vozila se ne računaju u statistiku aktivne flote —
    // imaju sopstvenu karticu i filter u tabu "Vozila".
    const activeVehicles = vehicles.filter(v => v.archived !== true);
    const archivedCount = vehicles.length - activeVehicles.length;

    // Statistika
    const total = activeVehicles.length;
    const active = activeVehicles.filter(v => v.status === "active").length;
    const inService = activeVehicles.filter(v => v.status === "service").length;
    const unregistered = activeVehicles.filter(v => isVehicleRegistered(v) === false).length;
    const broken = activeVehicles.filter(v => v.status === "broken").length;
    const inactive = activeVehicles.filter(v => v.status === "inactive").length;

    // Nadolazeće registracije (u sledećih 30 dana)
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingReg = activeVehicles
      .filter(v => {
        if (!v.regExpiry) return false;
        const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
        return d >= today && d <= in30;
      })
      .sort((a, b) => {
        const da = a.regExpiry.toDate ? a.regExpiry.toDate() : new Date(a.regExpiry);
        const db2 = b.regExpiry.toDate ? b.regExpiry.toDate() : new Date(b.regExpiry);
        return da - db2;
      });

    // Danas — početak dana u lokalnom vremenu (ponoć)
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Aktivna zaduženja
    let assignmentsSnap;
    if (role === "driver") {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("driverUid", "==", S.user.uid),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    } else {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    }
    const assignedCount = assignmentsSnap?.docs?.length || 0;

    // Vozač: SVA njegova zaduženja (za istoriju) + SVI njegovi unosi
    // (gorivo/troškovi/prijave) — jedan upit za sve, grupiše se lokalno
    // po zaduženju umesto da se pita baza posebno za svaku vožnju.
    //
    // Zaduženja: driverUid je primarni ključ (uvek pouzdan — direktan Auth
    // UID), sa driverId fallback-om (isti obrazac kao u trips.js) za
    // slučaj da driverUid na starijim zapisima nije popunjen (npr. Google
    // login vozači kod kojih se driverUid ne postavlja automatski).
    //
    // tripEntries: ovde je driverUid UVEK pouzdano popunjen (postavlja se
    // direktno iz trenutno ulogovanog korisnika pri svakom unosu, ne
    // zavisi od profila), pa driverId fallback ovde uopšte nije potreban.
    let allAssignmentsSnap = { docs: [] };
    let allEntriesSnap     = { docs: [] };
    if (role === "driver") {
      allAssignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("driverUid", "==", S.user.uid),
          orderBy("startDate", "desc")
        )
      ).catch(() => ({ docs: [] }));

      if (allAssignmentsSnap.docs.length === 0 && S.profile?.driverId) {
        allAssignmentsSnap = await getDocs(
          query(
            collection(db, "companies", cid, "assignments"),
            where("driverId", "==", S.profile.driverId),
            orderBy("startDate", "desc")
          )
        ).catch(() => ({ docs: [] }));
      }

      allEntriesSnap = await getDocs(
        query(
          collection(db, "companies", cid, "tripEntries"),
          where("driverUid", "==", S.user.uid),
          orderBy("createdAt", "asc")
        )
      ).catch(() => ({ docs: [] }));
    }

    // Zakazani servisi = unosi u "Servisna istorija" koji još nisu rešeni
    // (planned/in_progress). Dohvatamo u dva dela:
    //  1) propušteni (serviceDate < danas) — moraju da ostanu vidljivi dok
    //     ih neko ne potvrdi ili otkaže, bez obzira koliko kasne;
    //  2) nadolazeći u narednih 30 dana (uključujući danas).
    // Oba upita sortirana rastuće po datumu, pa spojena zadržavaju ispravan
    // redosled: najzakasneliji prvi, pa dalje ka budućnosti.
    const overdueServicesSnap = await getDocs(
      query(
        collection(db, "companies", cid, "services"),
        where("serviceDate", "<", todayStart),
        where("status", "in", [SERVICE_STATUS.PLANNED, SERVICE_STATUS.IN_PROGRESS]),
        orderBy("serviceDate", "asc")
      )
    ).catch(() => ({ docs: [] }));

    const servicesSnap = await getDocs(
      query(
        collection(db, "companies", cid, "services"),
        where("serviceDate", ">=", todayStart),
        where("serviceDate", "<=", in30),
        orderBy("serviceDate", "asc")
      )
    ).catch(() => ({ docs: [] }));

    const mapService = (d) => {
      const s = { id: d.id, ...d.data() };
      const veh = vehicles.find(v => v.id === s.vehicleId);
      return {
        ...s,
        vehicleBrand: veh?.brand || "",
        vehicleModel: veh?.model || "",
      };
    };

    const upcomingScheduled = [
      ...overdueServicesSnap.docs.map(mapService),
      ...servicesSnap.docs.map(mapService),
    ]
      // Servisi koji su u međuvremenu završeni ili otkazani ne treba
      // više da se prikazuju kao "nadolazeći"/"propušteni". Servisi vozila
      // koja su u međuvremenu arhivirana takođe se ne prikazuju — arhivirano
      // vozilo je van aktivne flote i ne zahteva dalju pažnju na dashboardu.
      .filter(s => {
        const st = effectiveServiceStatus(s);
        if (st === SERVICE_STATUS.DONE || st === SERVICE_STATUS.CANCELLED) return false;
        const veh = vehicles.find(v => v.id === s.vehicleId);
        return veh?.archived !== true;
      });

    const isDriver = role === "driver";

    content.innerHTML = `
      ${isDriver ? renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap) : renderAdminDashboard({
        total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount
      })}
    `;

    // Event listeneri (kartice admina, klikabilne stat-kartice vozača,
    // i proširivanje kartica istorije vožnji)
    attachDashboardEvents();
    if (isDriver) attachDriverHistoryEvents();

  } catch (e) {
    console.error("Dashboard load error:", e);
    content.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

function renderAdminDashboard({ total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // lokalna ponoć

  return `
    <div class="stats-grid">
      <div class="stat-card stat-card--total" data-nav="vehicles">
        <div class="stat-card__value">${total}</div>
        <div class="stat-card__label" data-i18n="dashboard_total_vehicles">${t("dashboard_total_vehicles")}</div>
      </div>
      <div class="stat-card stat-card--active" data-nav="vehicles" data-filter="active">
        <div class="stat-card__value">${active}</div>
        <div class="stat-card__label" data-i18n="dashboard_active">${t("dashboard_active")}</div>
      </div>
      <div class="stat-card stat-card--service" data-nav="vehicles" data-filter="service">
        <div class="stat-card__value">${inService}</div>
        <div class="stat-card__label" data-i18n="dashboard_in_service">${t("dashboard_in_service")}</div>
      </div>
      <div class="stat-card stat-card--unreg" data-nav="vehicles" data-filter="unregistered">
        <div class="stat-card__value">${unregistered}</div>
        <div class="stat-card__label" data-i18n="dashboard_unregistered">${t("dashboard_unregistered")}</div>
      </div>
      ${broken > 0 ? `
      <div class="stat-card stat-card--broken" data-nav="vehicles" data-filter="broken">
        <div class="stat-card__value">${broken}</div>
        <div class="stat-card__label">${t("vehicle_status_broken")}</div>
      </div>
      ` : ""}
      ${inactive > 0 ? `
      <div class="stat-card stat-card--inactive" data-nav="vehicles" data-filter="inactive">
        <div class="stat-card__value">${inactive}</div>
        <div class="stat-card__label">${t("vehicle_status_inactive")}</div>
      </div>
      ` : ""}
      ${archivedCount > 0 ? `
      <div class="stat-card stat-card--archived" data-nav="vehicles" data-filter="archived">
        <div class="stat-card__value">${archivedCount}</div>
        <div class="stat-card__label">${t("dashboard_archived")}</div>
      </div>
      ` : ""}
      <div class="stat-card stat-card--assigned" data-nav="assignments">
        <div class="stat-card__value">${assignedCount}</div>
        <div class="stat-card__label" data-i18n="dashboard_assigned">${t("dashboard_assigned")}</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="dashboard_upcoming_reg">${t("dashboard_upcoming_reg")}</h3>
        ${upcomingReg.length === 0
          ? `<p class="empty-text" data-i18n="dashboard_no_upcoming">${t("dashboard_no_upcoming")}</p>`
          : upcomingReg.map(v => {
              const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const urgency = daysLeft <= 7 ? "urgent" : daysLeft <= 14 ? "warning" : "ok";
              return `
                <div class="upcoming-item upcoming-item--${urgency}">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${v.brand} ${v.model}</span>
                    <span class="upcoming-item__plate">${v.plate}</span>
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">${formatDate(d)}</span>
                    <span class="upcoming-item__days">${daysLeft} ${t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>

      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="schedule_panel_title">📅 ${t("schedule_panel_title")}</h3>
        ${!upcomingScheduled || upcomingScheduled.length === 0
          ? `<p class="empty-text">${t("schedule_no_data")}</p>`
          : upcomingScheduled.map(s => {
              const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const today_ = isServiceToday(s);
              const overdue = isServiceOverdue(s);
              const urgency = overdue ? "urgent" : today_ ? "today" : daysLeft <= 2 ? "urgent" : daysLeft <= 7 ? "warning" : "ok";
              const dateStr = formatDate(d);
              const status = effectiveServiceStatus(s);
              const inProgressBadge = status === SERVICE_STATUS.IN_PROGRESS
                ? `<span class="today-badge" style="background:var(--color-warning)">${t("service_status_in_progress")}</span>` : "";
              const overdueBadge = overdue
                ? `<span class="today-badge" style="background:var(--color-danger)">⚠️ ${t("service_status_overdue")} — ${t("service_overdue_days", { n: overdueDays(s) })}</span>`
                : "";
              return `
                <div class="upcoming-item upcoming-item--${urgency}" data-vehicle-id="${s.vehicleId}" style="cursor:pointer">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${s.vehicleBrand} ${s.vehicleModel}</span>
                    <span class="upcoming-item__plate">${s.vehiclePlate}</span>
                    ${s.workshop ? `<span class="upcoming-item__plate">🔧 ${s.workshop}</span>` : ""}
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">
                      ${dateStr}
                      ${today_ ? `<span class="today-badge">${t("dashboard_today")}</span>` : ""}
                      ${overdueBadge}
                      ${inProgressBadge}
                    </span>
                    <span class="upcoming-item__days">${daysLeft <= 0 ? "" : daysLeft + " " + t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>
    </div>
  `;
}

function renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap) {
  const activeAssignments = assignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];
  const allAssignments    = allAssignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];
  const allEntries        = allEntriesSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];

  // Grupiši sve unose po zaduženju (jedan upit, lokalno grupisanje)
  const entriesByAssignment = {};
  allEntries.forEach(e => {
    if (!e.assignmentId) return;
    (entriesByAssignment[e.assignmentId] ||= []).push(e);
  });
  // Upit je učitan rastuće po datumu (radi ponovne upotrebe postojećeg
  // indeksa) — okreni svaku grupu da bude najnovije prvo, radi prikaza.
  Object.values(entriesByAssignment).forEach(list => list.reverse());

  const pastAssignments = allAssignments.filter(a => a.status === "closed");

  let html = "";

  // ── Aktivno vozilo + informativne kartice ──────────────────
  if (activeAssignments.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <p>${t("no_data")}</p>
      </div>
    `;
  } else {
    html += activeAssignments
      .map(a => renderActiveAssignmentBlock(a, entriesByAssignment[a.id] || []))
      .join("");
  }

  // ── Istorija vožnji, grupisana po mesecu započinjanja ──────
  if (pastAssignments.length > 0) {
    html += renderHistorySection(pastAssignments, entriesByAssignment);
  }

  return html;
}

// ── AKTIVNO ZADUŽENJE: kartica vozila + 4 informativne kartice ─
function renderActiveAssignmentBlock(a, entries) {
  const fuelL   = entries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const costRSD = entries.reduce((s, e) => {
    if (e.type === "fuel") return s + (e.fuelCost || 0);
    if (["toll", "parking", "washing", "other_cost"].includes(e.type)) return s + (e.amount || 0);
    return s;
  }, 0);
  const incidentsCount = entries.filter(e => ["fault", "damage", "accident"].includes(e.type)).length;

  return `
    <div class="vehicle-card-preview">
      <div class="vehicle-card-preview__header">
        <span class="vehicle-card-preview__icon">🚗</span>
        <div>
          <div class="vehicle-card-preview__title">${a.vehicleBrand} ${a.vehicleModel}</div>
          <div class="vehicle-card-preview__plate">${a.vehiclePlate}</div>
        </div>
      </div>
      <div class="vehicle-card-preview__km">
        <span>${t("assignment_start_km")}:</span>
        <strong>${a.startKm?.toLocaleString() || "—"} km</strong>
      </div>
      <div class="vehicle-card-preview__actions">
        <button class="btn btn--primary btn--sm" onclick="import('./app.js').then(m => m.navigateTo('trips'))">
          ${t("trip_add")}
        </button>
        <button class="btn btn--warning btn--sm" onclick="import('./app.js').then(m => m.navigateTo('incidents'))">
          ${t("incident_add")}
        </button>
      </div>
    </div>

    <div class="stats-grid" style="margin-top:14px">
      <div class="stat-card" data-nav="trips">
        <div class="stat-card__value">${fuelL.toFixed(1)} L</div>
        <div class="stat-card__label">${t("trip_stats_fuel")}</div>
      </div>
      <div class="stat-card" data-nav="trips">
        <div class="stat-card__value">${costRSD.toLocaleString()} RSD</div>
        <div class="stat-card__label">${t("trip_stats_cost")}</div>
      </div>
      <div class="stat-card ${incidentsCount > 0 ? "stat-card--warn" : ""}" data-nav="incidents">
        <div class="stat-card__value">${incidentsCount}</div>
        <div class="stat-card__label">${t("trip_stats_incidents")}</div>
      </div>
      <div class="stat-card" data-nav="trips">
        <div class="stat-card__value">${entries.length}</div>
        <div class="stat-card__label">${t("trip_stats_entries")}</div>
      </div>
    </div>
  `;
}

// ── ISTORIJA VOŽNJI — grupisano po mesecu, na osnovu startDate ──
function renderHistorySection(pastAssignments, entriesByAssignment) {
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";

  // Grupiši po mesecu/godini početka vožnje (startDate)
  const groups = new Map(); // "YYYY-MM" -> { date, items: [] }
  pastAssignments.forEach(a => {
    const d = toJsDate(a.startDate);
    const key = d ? `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}` : "unknown";
    if (!groups.has(key)) groups.set(key, { date: d, items: [] });
    groups.get(key).items.push(a);
  });

  // Meseci od najnovijeg ka najstarijem ("unknown" ide na kraj)
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return b.localeCompare(a);
  });

  return `
    <div class="trip-history-header" style="margin-top:28px">
      <h3>${t("trip_history_title")}</h3>
    </div>
    ${sortedKeys.map(key => {
      const group = groups.get(key);
      const monthLabel = group.date
        ? capitalizeFirst(group.date.toLocaleDateString(locale, { month: "long", year: "numeric" }))
        : t("no_data");
      // Unutar meseca, sortiraj od najnovije ka najstarijoj vožnji
      const items = [...group.items].sort((x, y) => {
        const dx = toJsDate(x.startDate), dy = toJsDate(y.startDate);
        return (dy?.getTime() || 0) - (dx?.getTime() || 0);
      });
      return `
        <div class="trip-history-month">
          <div class="trip-history-month__label">${monthLabel}</div>
          <div class="trip-history-list">
            ${items.map(a => historyAssignmentCard(a, entriesByAssignment[a.id] || [])).join("")}
          </div>
        </div>
      `;
    }).join("")}
  `;
}

function capitalizeFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ── ISTORIJA — kartica jedne vožnje (klik = detalji) ───────────
function historyAssignmentCard(a, entries) {
  const km = (a.endKm != null && a.startKm != null) ? (a.endKm - a.startKm) : null;

  const fuelEntries = entries.filter(e => e.type === "fuel");
  const costEntries  = entries.filter(e => ["toll", "parking", "washing", "other_cost"].includes(e.type));
  const incEntries   = entries.filter(e => ["fault", "damage", "accident", "other"].includes(e.type));

  const badges = [
    fuelEntries.length > 0 ? `<span class="trip-history-badge">⛽ ${fuelEntries.length}</span>` : "",
    costEntries.length > 0 ? `<span class="trip-history-badge">🛣️ ${costEntries.length}</span>` : "",
    incEntries.length > 0 ? `<span class="trip-history-badge trip-history-badge--warn">⚠️ ${incEntries.length}</span>` : "",
  ].filter(Boolean).join("");

  return `
    <div class="trip-history-card">
      <div class="trip-history-card__header" data-toggle-history>
        <div>
          <div class="trip-history-card__vehicle">
            🚗 <strong>${a.vehicleBrand || ""} ${a.vehicleModel || ""}</strong> — ${a.vehiclePlate || ""}
          </div>
          <div class="trip-history-card__dates">📅 ${formatDate(a.startDate)} → ${formatDate(a.endDate)}</div>
        </div>
        <div class="trip-history-card__summary">
          ${badges}
          <span class="trip-history-card__chevron">▾</span>
        </div>
      </div>

      <div class="trip-history-card__details hidden">
        <div class="trip-history-card__km">
          🛣️ ${a.startKm?.toLocaleString() ?? "—"} → ${a.endKm?.toLocaleString() ?? "—"} km
          ${km != null ? `<strong> (${km.toLocaleString()} km)</strong>` : ""}
        </div>
        ${a.tripType === "intercity" && a.destination ? `<div class="trip-history-card__dest">📍 ${a.destination}</div>` : ""}
        ${a.reason ? `<div class="trip-history-card__reason">${a.reason}</div>` : ""}
        ${a.unassignNotes ? `<div class="trip-history-card__notes">${a.unassignNotes}</div>` : ""}

        ${entries.length === 0
          ? `<p class="trip-history-card__empty">${t("trip_no_entries")}</p>`
          : `<div class="trip-history-card__entries">${entries.map(e => historyEntryItem(e)).join("")}</div>`
        }
      </div>
    </div>
  `;
}

// ── Pojedinačan unos unutar razvijene kartice istorije ─────────
function historyEntryItem(entry) {
  if (entry.type === "fuel") {
    return `
      <div class="trip-history-entry">
        <span>⛽ ${entry.fuelAmount ?? "—"} L${entry.fuelCost ? ` / ${entry.fuelCost.toLocaleString()} RSD` : ""}</span>
        ${entry.fuelStation ? `<span>🏪 ${entry.fuelStation}</span>` : ""}
        ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
        <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
      </div>
    `;
  }
  if (["toll", "parking", "washing", "other_cost"].includes(entry.type)) {
    return `
      <div class="trip-history-entry">
        <span><strong>${entry.amount?.toLocaleString() ?? "—"} RSD</strong></span>
        ${entry.location ? `<span>📍 ${entry.location}</span>` : ""}
        ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
        <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
      </div>
    `;
  }
  // fault / damage / accident / other
  const typeIcons = { fault: "🔧", damage: "💥", accident: "🚨", other: "📋" };
  return `
    <div class="trip-history-entry">
      <span>${typeIcons[entry.type] || "⚠️"} ${t("incident_" + entry.type) || entry.type}</span>
      ${entry.description ? `<span>${entry.description}</span>` : ""}
      ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
      <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
    </div>
  `;
}

// Klik na header kartice istorije → toggluje prikaz detalja
function attachDriverHistoryEvents() {
  document.querySelectorAll("[data-toggle-history]").forEach(header => {
    header.addEventListener("click", () => {
      const details = header.parentElement.querySelector(".trip-history-card__details");
      details?.classList.toggle("hidden");
      header.classList.toggle("trip-history-card__header--open");
    });
  });
}

function attachDashboardEvents() {
  document.querySelectorAll(".stat-card[data-nav]").forEach(card => {
    card.style.cursor = "pointer";
    card.addEventListener("click", () => {
      const filter = card.dataset.filter || null;
      if (filter) {
        // Navigiraj na tab i primeni filter
        import("./vehicles.js").then(({ renderVehicles }) => {
          S.activeTab = "vehicles";
          document.querySelectorAll(".nav-btn").forEach(btn => {
            btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
          });
          const content = document.getElementById("content");
          if (content) renderVehicles(content, filter);
        });
      } else {
        navigateTo(card.dataset.nav);
      }
    });
  });

  // Klik na zakazani servis u panelu → detalji vozila, tab "Servisna istorija"
  document.querySelectorAll("[data-vehicle-id]").forEach(item => {
    item.addEventListener("click", () => {
      const vehicleId = item.dataset.vehicleId;
      if (!vehicleId) return;
      S.activeTab = "vehicles";
      document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
      });
      openVehicleDetail(vehicleId, "service");
    });
  });
}

function formatDate(date) {
  if (!date) return "—";
  const d = date.toDate ? date.toDate() : (date instanceof Date ? date : new Date(date));
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

function toJsDate(val) {
  if (!val) return null;
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d) ? null : d;
}
