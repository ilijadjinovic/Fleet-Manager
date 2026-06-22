// ============================================================
//  app.js  —  Fleet Manager
//  Glavni modul: auth state, routing, tab switching
// ============================================================

import { auth, db, getUserProfile, logout } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { loadLanguage, t, applyTranslations } from "./i18n.js";
import { renderDashboard } from "./dashboard.js";
import { renderVehicles } from "./vehicles.js";
import { renderDrivers } from "./drivers.js";
import { renderAssignments } from "./assignments.js";
import { renderTrips } from "./trips.js";
import { renderIncidents } from "./incidents.js";
import { renderReports } from "./reports.js";
import { renderProfile } from "./profile.js";
import { renderLogin } from "./login.js";

// ── GLOBALNI STATE ────────────────────────────────────────────
export const S = {
  user: null,           // Firebase Auth user
  profile: null,        // Firestore user profil
  companyId: null,      // Aktivna kompanija (za master admin biraju)
  companies: [],        // Lista svih kompanija (master admin)
  activeTab: "dashboard",
};

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  await loadLanguage(localStorage.getItem("fm_lang") || "sr");

  onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      S.user = firebaseUser;
      S.profile = await getUserProfile(firebaseUser.uid);

      if (!S.profile) {
        // Novi Google korisnik bez profila — prikaži "pristup nije odobren"
        showAccessDenied();
        return;
      }

      // Postavi companyId
      if (S.profile.role === "master_admin") {
        // Master admin: defaultno prva kompanija ili null (vidi sve)
        S.companyId = S.profile.lastCompanyId || null;
      } else {
        S.companyId = S.profile.companyId;
      }

      showApp();
    } else {
      S.user = null;
      S.profile = null;
      S.companyId = null;
      showLogin();
    }
  });
}

// ── PRIKAZ LOGIN ──────────────────────────────────────────────
function showLogin() {
  document.getElementById("app").innerHTML = "";
  document.getElementById("login-screen").classList.remove("hidden");
  renderLogin();
}

// ── PRIKAZ APP ────────────────────────────────────────────────
function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  buildNav();
  navigateTo(S.activeTab);
}

// ── PRISTUP NIJE ODOBREN ──────────────────────────────────────
function showAccessDenied() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").innerHTML = `
    <div class="access-denied">
      <div class="access-denied__icon">🚫</div>
      <h2>${t("access_denied_title")}</h2>
      <p>${t("access_denied_msg")}</p>
      <button onclick="import('./app.js').then(m => m.doLogout())" class="btn btn--secondary">
        ${t("logout")}
      </button>
    </div>
  `;
  document.getElementById("app").classList.remove("hidden");
}

// ── NAVIGACIJA ────────────────────────────────────────────────
const TAB_CONFIG = {
  master_admin: ["dashboard", "vehicles", "drivers", "assignments", "reports", "profile"],
  fleet_admin:  ["dashboard", "vehicles", "drivers", "assignments", "reports", "profile"],
  driver:       ["dashboard", "trips", "incidents", "profile"],
};

const TAB_ICONS = {
  dashboard:   "📊",
  vehicles:    "🚗",
  drivers:     "👤",
  assignments: "🔑",
  trips:       "🛣️",
  incidents:   "⚠️",
  reports:     "📄",
  profile:     "⚙️",
};

const TAB_RENDERERS = {
  dashboard:   renderDashboard,
  vehicles:    renderVehicles,
  drivers:     renderDrivers,
  assignments: renderAssignments,
  trips:       renderTrips,
  incidents:   renderIncidents,
  reports:     renderReports,
  profile:     renderProfile,
};

export function buildNav() {
  const role = S.profile?.role || "driver";
  const tabs = TAB_CONFIG[role] || TAB_CONFIG.driver;
  const nav = document.getElementById("main-nav");
  if (!nav) return;

  nav.innerHTML = tabs
    .map(
      (tab) => `
    <button
      class="nav-btn ${S.activeTab === tab ? "nav-btn--active" : ""}"
      data-tab="${tab}"
      title="${t("tab_" + tab)}"
    >
      <span class="nav-btn__icon">${TAB_ICONS[tab]}</span>
      <span class="nav-btn__label" data-i18n="tab_${tab}">${t("tab_" + tab)}</span>
    </button>
  `
    )
    .join("");

  nav.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.tab));
  });
}

export function navigateTo(tab) {
  S.activeTab = tab;

  // Ažuriraj active klasu
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("nav-btn--active", btn.dataset.tab === tab);
  });

  // Renderuj sadržaj
  const content = document.getElementById("content");
  if (!content) return;
  content.innerHTML = `<div class="loading">${t("loading")}</div>`;

  const renderer = TAB_RENDERERS[tab];
  if (renderer) {
    renderer(content);
  } else {
    content.innerHTML = `<p>${t("no_data")}</p>`;
  }
}

// ── COMPANY SWITCHER (master admin) ──────────────────────────
export function setActiveCompany(companyId) {
  S.companyId = companyId;
  // Sačuvaj poslednju izabranu kompaniju
  import("./firebase.js").then(({ setUserProfile }) => {
    setUserProfile(S.user.uid, { lastCompanyId: companyId });
  });
  navigateTo(S.activeTab);
}

// ── LOGOUT ────────────────────────────────────────────────────
export async function doLogout() {
  await logout();
}

// ── TOAST NOTIFIKACIJE ────────────────────────────────────────
export function showToast(message, type = "info", duration = 3500) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("toast--visible"));

  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── MODAL HELPER ──────────────────────────────────────────────
export function openModal(title, bodyHTML, onConfirm = null) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHTML;

  const confirmBtn = document.getElementById("modal-confirm");
  const cancelBtn = document.getElementById("modal-cancel");

  confirmBtn.style.display = onConfirm ? "inline-flex" : "none";

  const closeModal = () => {
    document.getElementById("modal-overlay").classList.add("hidden");
  };

  if (onConfirm) {
    confirmBtn.onclick = () => {
      onConfirm();
      closeModal();
    };
  }
  cancelBtn.onclick = closeModal;
  document.getElementById("modal-overlay").classList.remove("hidden");
}

export function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

// ── START ─────────────────────────────────────────────────────
init();
