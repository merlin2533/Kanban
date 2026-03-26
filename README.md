# Kanban Board

Einfaches, selbst-gehostetes Kanban Board (Trello-Alternative). Node.js, SQLite, kein Build-Step.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Boards, Spalten, Karten** mit Drag & Drop (auch Touch/Mobile)
- **Checklisten** mit Fortschrittsbalken
- **Datei-/Bild-Upload** mit Thumbnails
- **Labels** mit Farben
- **Beschreibungen** mit Markdown-Support
- **Fälligkeitsdatum** mit visueller Warnung
- **Priorität** (Hoch/Mittel/Niedrig) mit farbiger Markierung
- **Kommentare** mit Markdown
- **Karten-Zuweisung** an Benutzer mit Avataren
- **Aktivitäts-Feed** ("Was ist neu")
- **Echtzeit-Sync** via SSE (mehrere User gleichzeitig)
- **Presence-Anzeige** (wer ist online)
- **Suche, Sortierung, Label-Filter**
- **Archivierung** (Karten archivieren statt löschen)
- **WIP-Limits** auf Spalten
- **Export/Import** (JSON)
- **Board-Vorlagen** (Templates)
- **Webhooks** (HTTP Callbacks bei Board-Änderungen)
- **DB-Backup** als Download
- **Undo, Keyboard-Shortcuts** (`n` neue Karte, `f` Suche, `Esc` Schliessen, `Ctrl+Z` Undo, `?` Hilfe)
- **PWA** (installierbar auf Handy/Desktop)
- **Dark Mode** (automatisch via System-Einstellung)

## Quick Start

### Node.js (lokal)

```bash
git clone https://github.com/merlin2533/Kanban.git
cd Kanban
npm install
npm start
```

Offne http://localhost:3000

### Docker Compose

```bash
git clone https://github.com/merlin2533/Kanban.git
cd Kanban
cp .env.example .env
# .env anpassen (ADMIN_PASSWORD!)
docker compose up -d
```

### Docker (direkt)

```bash
docker run -d \
  -p 3000:3000 \
  -v kanban-data:/data \
  -v kanban-uploads:/app/uploads \
  -e ADMIN_PASSWORD=dein-sicheres-passwort \
  merlin2539/kanban:latest
```

### Docker Swarm

```bash
docker stack deploy -c docker-stack.yml kanban
```

## Login

| | Standard |
|---|---|
| **URL** | http://localhost:3000/login.html |
| **Benutzername** | `admin` |
| **Passwort** | `admin` |

**Bitte sofort nach dem ersten Login das Passwort andern!** (Einstellungen -> Passwort andern, oder direkt /settings.html)

### Benutzer-Konzept

- **Admin** - Kann alles: Boards erstellen, Benutzer verwalten, Zugriffs-Links erstellen, Templates, Webhooks, DB-Backup
- **Benutzer** - Kann Boards sehen und bearbeiten (wenn berechtigt)
- **Zugriffs-Link** - Jedes Board kann Zugriffs-Links haben:
  - **Nur lesen** - Board anschauen, aber nichts andern
  - **Bearbeiten** - Board anschauen und Karten bearbeiten

### Zugriffs-Links erstellen

1. Board offnen
2. Schluessel-Icon im Header klicken (nur Admins)
3. Berechtigung wahlen (Nur lesen / Bearbeiten)
4. Link kopieren und teilen

Der Link sieht so aus: `http://deine-domain:3000/board/ABC123?token=XYZ789`

### Passwort-Erinnerung

Nach 14 Tagen wird beim Login automatisch an die Passwort-Anderung erinnert.

## Konfiguration

Alle Einstellungen via Environment-Variablen:

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `PORT` | `3000` | Server-Port |
| `DB_PATH` | `./kanban.db` | Pfad zur SQLite-Datenbank |
| `NODE_ENV` | - | `production` aktiviert Secure-Cookie |
| `BASE_URL` | `http://localhost:3000` | Externe URL |
| `ADMIN_USER` | `admin` | Standard-Admin Benutzername (nur beim ersten Start) |
| `ADMIN_PASSWORD` | `admin` | Standard-Admin Passwort (nur beim ersten Start) |

## Benutzerverwaltung

1. Einloggen als Admin
2. http://localhost:3000/settings.html offnen
3. Unter "Benutzerverwaltung":
   - Neue Benutzer anlegen (mit/ohne Admin-Rechte)
   - Benutzer loschen

## Keyboard-Shortcuts

| Taste | Aktion |
|-------|--------|
| `n` | Neue Karte (fokussiert erstes Input) |
| `f` | Suche fokussieren |
| `Esc` | Modal/Panel schliessen |
| `Ctrl+Z` | Ruckgangig |
| `?` | Hilfe anzeigen |

## Tech Stack

- **Backend**: Node.js + Express
- **Datenbank**: SQLite (better-sqlite3) - eine Datei, kein DB-Server notig
- **Frontend**: Vanilla HTML/CSS/JS - kein Framework, kein Build-Step
- **Auth**: scrypt-Passwort-Hashing (Node.js crypto, keine Extra-Dependency)
- **Echtzeit**: Server-Sent Events (SSE)
- **Dependencies**: 4 Stuck (express, better-sqlite3, nanoid, multer)

## API

Alle Endpunkte unter `/api/`. Authentifizierung via Session-Cookie oder `?token=` Query-Parameter.

### Boards
- `GET /api/boards` - Alle Boards auflisten
- `POST /api/boards` - Neues Board erstellen
- `GET /api/boards/:id` - Board mit allen Daten laden
- `PATCH /api/boards/:id` - Board umbenennen
- `DELETE /api/boards/:id` - Board loschen
- `GET /api/boards/:id/export` - Board als JSON exportieren
- `POST /api/boards/import` - Board aus JSON importieren

### Spalten
- `POST /api/boards/:id/columns` - Spalte hinzufugen
- `PATCH /api/columns/:id` - Spalte andern (Titel, WIP-Limit)
- `DELETE /api/columns/:id` - Spalte loschen
- `PUT /api/columns/:id/move` - Spalte verschieben

### Karten
- `POST /api/columns/:id/cards` - Karte erstellen
- `PATCH /api/cards/:id` - Karte andern (Text, Beschreibung, Falligkeitsdatum, Prioritat)
- `DELETE /api/cards/:id` - Karte loschen
- `PUT /api/cards/:id/move` - Karte verschieben
- `PUT /api/cards/:id/archive` - Karte archivieren
- `PUT /api/cards/:id/restore` - Karte wiederherstellen

### Checklisten, Labels, Kommentare, Dateien, Webhooks, Templates
Siehe `server.js` fur die vollstandige API-Dokumentation.

## Entwicklung

```bash
npm run dev   # Startet mit --watch (auto-restart bei Anderungen)
```

## Lizenz

MIT
