# Fleet Manager PWA

Evidencija i upravljanje voznim parkom — multi-tenant web aplikacija.

## Tehnologije
- Firebase Auth (Google + Email/Password)
- Firebase Firestore (baza podataka)
- Vanilla JS (ES modules)
- PWA (manifest + service worker)
- jsPDF (generisanje izveštaja)

## Setup

### 1. Firebase projekat
1. Kreiraj projekat na [console.firebase.google.com](https://console.firebase.google.com)
2. Authentication → Providers: omogući **Google** i **Email/Password**
3. Firestore → Create database → **Production mode** → `eur3 (europe-west)`
4. Project Settings → Add web app → kopiraj `firebaseConfig`

### 2. Konfiguracija
U `firebase.js`, zameni `firebaseConfig` objekat sa vrednostima iz tvog Firebase projekta:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

### 3. Firestore Rules
Kopiraj sadržaj `firestore.rules` u Firebase Console → Firestore → Rules.

### 4. GitHub Pages
1. Napravi GitHub repo
2. Push sve fajlove
3. Settings → Pages → Branch: `main`, folder: `/`

### 5. Firebase Auth — dodaj GitHub Pages URL
Firebase Console → Authentication → Settings → Authorized domains → dodaj `tvojnalog.github.io`

### 6. Prvi Master Admin nalog
Nakon deploy-a:
1. Uloguj se Google nalogom
2. U Firestore konzoli, ručno kreiraj dokument u kolekciji `users` sa ID = tvoj Firebase UID:
```json
{
  "role": "master_admin",
  "email": "tvoj@gmail.com",
  "createdAt": "<timestamp>"
}
```

## Struktura kolekcija

```
users/{uid}
  role: "master_admin" | "fleet_admin" | "driver"
  companyId: string (null za master_admin)
  displayName: string
  email: string

companies/{companyId}
  name: string
  createdAt: timestamp
  
  vehicles/{vehicleId}     ← kartice vozila
  drivers/{driverId}       ← evidencija vozača
  assignments/{id}         ← zaduženja vozila
  trips/{id}               ← evidencija vožnji
  fuelings/{id}            ← točenja goriva
  incidents/{id}           ← kvarovi, štete, nezgode
  services/{id}            ← servisna istorija
  notifications/{id}       ← sistemske notifikacije
```

## Uloge

| Uloga | Pristup |
|-------|---------|
| `master_admin` | Sve firme, CRUD sve |
| `fleet_admin` | Samo svoja firma, CRUD vozila/vozača/zaduženja |
| `driver` | Samo svoja firma, unos km/gorivo/prijave |

## Lokalni nalozi (Username/Password)
- Fleet admin kreira nalog kroz app (Dodaj vozača)
- Username se konvertuje u `username@fleetapp.internal` za Firebase Auth
- Korisnik vidi samo username, ne zna za email format
- Fleet admin može menjati password, vozač ne može
