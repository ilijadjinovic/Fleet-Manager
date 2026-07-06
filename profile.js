// ============================================================
//  profile.js  —  Fleet Manager
//  Tab: Profil — podaci korisnika, podešavanja, jezik
// ============================================================

import { db, auth, logout, linkLocalCredential } from "./firebase.js";
import {
  doc, getDoc, updateDoc, serverTimestamp, collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, loadLanguage, getCurrentLang, SUPPORTED_LANGS } from "./i18n.js";
import { S, showToast, openModal, buildNav, rerenderCurrentTab } from "./app.js";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderProfile(container) {
  const profile = S.profile;
  const user    = S.user;
  if (!profile || !user) return;

  const role        = profile.role;
  const isDriver    = role === "driver";
  const isFleetAdmin= role === "fleet_admin";
  const isMaster    = role === "master_admin";

  // Dohvati podatke o firmi
  let company = null;
  if (S.companyId) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId));
      if (snap.exists()) company = { id: snap.id, ...snap.data() };
    } catch (e) { /* ignoriši */ }
  }

  // Dohvati driver dokument ako je vozač
  let driverDoc = null;
  if (isDriver && profile.driverId) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId, "drivers", profile.driverId));
      if (snap.exists()) driverDoc = { id: snap.id, ...snap.data() };
    } catch (e) { /* ignoriši */ }
  }

  const displayName = profile.displayName
    || `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
    || user.displayName
    || user.email;

  const initials = displayName
    .split(" ").slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";

  container.innerHTML = `
    <!-- PROFIL HEADER -->
    <div class="profile-header">
      <div class="profile-avatar">${initials}</div>
      <div class="profile-header__info">
        <div class="profile-header__name">${displayName}</div>
        <div class="profile-header__role">
          <span class="badge badge--info">${t("role_" + role)}</span>
          ${company ? `<span class="profile-header__company">🏢 ${company.name}</span>` : ""}
        </div>
        <div class="profile-header__email">${user.email || ""}</div>
      </div>
    </div>

    <!-- TABOVI -->
    <div class="tab-strip" id="profile-tabs">
      <button class="tab-strip__btn tab-strip__btn--active" data-ptab="info">${t("profile_my_data")}</button>
      ${company ? `<button class="tab-strip__btn" data-ptab="company">${t("profile_company_tab")}</button>` : ""}
      <button class="tab-strip__btn" data-ptab="settings">${t("profile_settings_tab")}</button>
    </div>

    <div id="profile-tab-content"></div>
  `;

  document.getElementById("profile-tabs")?.addEventListener("click", (e) => {