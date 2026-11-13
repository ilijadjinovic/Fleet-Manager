// ============================================================
//  detail-registry.js  —  Fleet Manager
//  Mala "evidencija" objekata koji su prikazani na ekranu, da klik
//  na zaduženje / vožnju / unos može da otvori detalje bez novog
//  upita ka bazi. Nema uvoza drugih modula (izbegava kružne zavisnosti).
// ============================================================

const entries     = new Map();
const assignments = new Map();
const trips       = new Map();
const services    = new Map();
const incidents   = new Map();

export function rememberEntry(e)      { if (e?.id) entries.set(e.id, e); return e; }
export function rememberService(sv)   { if (sv?.id) services.set(sv.id, sv); return sv; }
export function rememberIncident(inc) { if (inc?.id) incidents.set(inc.id, inc); return inc; }
export function rememberAssignment(a) { if (a?.id) assignments.set(a.id, a); return a; }
export function rememberTrip(tr, assignmentId) {
  if (tr?.id) trips.set(tr.id, { ...tr, assignmentId: tr.assignmentId || assignmentId || null });
  return tr;
}

export const getRememberedEntry      = (id) => entries.get(id) || null;
export const getRememberedAssignment = (id) => assignments.get(id) || null;
export const getRememberedTrip       = (id) => trips.get(id) || null;
export const getRememberedService    = (id) => services.get(id) || null;
export const getRememberedIncident   = (id) => incidents.get(id) || null;
