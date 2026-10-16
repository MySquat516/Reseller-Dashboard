# Reseller Dashboard

Artikelverwaltung mit Bild-Upload und Finanz-Dashboard für Reseller.
Stack: Node.js, Express, SQLite (better-sqlite3), Chart.js, Vanilla-JS-Frontend.

> **Hinweis:** Diese App wurde mit Hilfe von KI (Claude von Anthropic) entwickelt.
> Idee, Anforderungen und Tests kommen vom Projektinhaber, der Code wurde KI-gestützt geschrieben.
> Bitte vor dem produktiven Einsatz selbst prüfen.

## Starten mit Docker

```bash
docker compose up -d --build
```

Danach erreichbar unter `http://<server>:3000`.

Alle Daten (Datenbank `reseller.db` und Bilder in `uploads/`) liegen im Ordner `./data`.
Backup = diesen Ordner kopieren.

## Starten ohne Docker

```bash
npm install
npm start
```

## Funktionen

- Artikel mit Titel, Beschreibung, Größe, Kategorie, Marke, Zustand und Notizen
- Bis zu 60 Bilder pro Artikel: Drag-and-drop, Einfügen per Strg+V oder Auswählen (am Handy auch direkt Kamera),
  Sortieren per Ziehen, Titelbild per Stern, Großansicht mit Pfeiltasten und Wischen.
  Große Fotos werden vor dem Upload im Browser auf max. 1800 px verkleinert (spart Speicher und Zeit).
- Status: Lager, Online, Verkauft, Versendet
- Preise: Einkauf, Einstellpreis, Verkaufspreis, Gebühren, Versandkosten, Daten
- Verkaufsdetails: Plattform, Käufer, Zahlungsart, Zahlungsstatus
- Dashboard: Gewinn, Umsatz, Marge, ROI, Lagerwert, Standzeit, Preisabschlag, offene Zahlungen,
  Auswertung nach Monat, Plattform, Zahlungsart, Kategorie und Marke, Ladenhüter

## Hinweis

Die App hat keinen Login. Betreibe sie nur im Heimnetz oder hinter einem Reverse Proxy mit Authentifizierung
(z. B. Authelia, Basic Auth in Nginx Proxy Manager oder Traefik).

## API

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/items` | alle Artikel inkl. Bilder |
| POST | `/api/items` | Artikel anlegen |
| PUT | `/api/items/:id` | Artikel ändern |
| DELETE | `/api/items/:id` | Artikel samt Bildern löschen |
| POST | `/api/items/:id/images` | Bilder hochladen (multipart, Feld `images`) |
| DELETE | `/api/images/:id` | einzelnes Bild löschen |
| GET | `/api/stats` | alle Kennzahlen fürs Dashboard |
