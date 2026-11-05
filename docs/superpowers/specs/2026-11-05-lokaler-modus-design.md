# Lokaler Modus und Fotos in der iOS-App (Teil 1 und 2)

Stand: 05.11.2026 · Status: Entwurf zur Prüfung
Grundlage: Brainstorming vom 05.11.2026 (Notizen im claude.ai-Projekt „Reseller-Dashboard“)

## Ziel

Die iOS-App soll später veröffentlicht werden können. Wer keinen eigenen Server hat, nutzt sie lokal: Alle Daten
liegen nur auf dem Gerät. Wer einen Server hat (Docker im Homelab), verbindet die App damit und arbeitet auf allen
Geräten mit denselben Daten.

Dieses Konzept deckt die ersten beiden Teile ab: das Fundament (Speicher-Schicht und lokaler Modus) und Fotos in
beiden Modi.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Normalfall | Lokal. Der Server ist die Option für mehrere Geräte. |
| Lokal → Server | Einmal hochladen, danach ist die App reiner Server-Client. Kein dauerhafter Abgleich. (Teil 3) |
| Server → lokal | Rückweg wird eingebaut. (Teil 3) |
| Doppelte beim Hochladen | Werden über die UUID erkannt und übersprungen. (Teil 3) |
| Nach dem Umzug | Die App fragt, ob der lokale Stand gelöscht wird. (Teil 3) |
| Lokale Speicherung | SQLite mit denselben Tabellen und Spalten wie der Server, über SQLiteData (Point-Free). |
| IDs | UUID als Primärschlüssel lokal. Voraussetzung für den iCloud-Abgleich von SQLiteData. |
| iCloud | Später als eigener Teil. Braucht das bezahlte Apple-Entwicklerkonto. |
| Server-Modus ohne Verbindung | Meldung und „Erneut“ wie heute, keine Zwischenspeicherung. |
| Kamera in der App | Vorerst nicht. Fotos kommen über Apples Foto-Auswahl. |

## Umfang

**In diesem Konzept**

1. Server: UUID für Artikel und Bilder.
2. iOS: Speicher-Schicht mit Server- und lokaler Variante, Modus-Wahl in den Einstellungen.
3. iOS: Fotos in beiden Modi.

**Nicht in diesem Konzept (spätere Teile)**

- Teil 3: Umzug lokal ↔ Server, Sicherungsdatei für den lokalen Modus.
- Teil 4: Dashboard, Verkäufe, CSV und Versandvorlagen in beiden Modi.
- Teil 5: Veröffentlichung (Login in der App, HTTPS, Datenschutzerklärung, Entwicklerkonto, Bundle-ID).
- Teil 6: iCloud-Abgleich im lokalen Modus.

Bis Teil 3 sind lokale Daten nur über das iCloud-Geräte-Backup geschützt. Das ist in Ordnung, solange die App nicht
veröffentlicht ist.

## 1. Server: UUID für Artikel und Bilder

Eigener Pull Request, aufbauend auf `main` nach dem Merge von #7 bis #16 (braucht die Testsuite aus #15).

- Neue Spalte `uuid TEXT` in `items` und `images`, jeweils mit eindeutigem Index.
- Beim Start bekommen bestehende Zeilen ohne UUID eine (UUID v4, direkt in SQL aus `randomblob` erzeugt).
- Ein Trigger nach jedem `INSERT` ohne UUID vergibt eine. Damit sind alle Wege abgedeckt: `POST /api/items`,
  „Als Kopie anlegen“, CSV-Import, Bild-Upload und das Einspielen alter Backups ohne `uuid`-Spalte.
- `POST /api/items` nimmt optional `uuid` an (Format UUID, wird klein geschrieben gespeichert).
  Ungültiges Format → 400. Schon vergeben → 409 mit `{ error, id }` (Nummer des vorhandenen Artikels).
- `PUT /api/items/:id` ändert die UUID nie (`uuid` steht nicht in `FIELDS`).
- API-Antworten enthalten `uuid` je Artikel und `{ id, uuid, url }` je Bild.
- Web-App, CSV-Export und CSV-Import bleiben unverändert.

## 2. Datenmodell in der App

Datei `reseller.sqlite` im Ordner *Application Support* der App, angebunden über SQLiteData (mindestens 1.9,
unterstützt iOS 16 und neuer; die App zielt auf iOS 17). Schema-Änderungen laufen über den Migrator der Bibliothek,
eine Migration pro Änderung.

**`items`**: `id TEXT PRIMARY KEY` (UUID) und dieselben Spalten wie auf dem Server: `title`, `description`, `size`,
`category`, `brand`, `condition`, `status`, `purchase_price`, `purchase_date`, `listing_price`, `listed_date`,
`sold_price`, `sold_date`, `platform`, `buyer`, `payment_method`, `payment_status`, `fees`, `shipping_cost`,
`carrier`, `tracking_number`, `notes`, `created_at`. Neu: `updated_at`.

**`images`**: `id TEXT PRIMARY KEY` (UUID), `item_id TEXT REFERENCES items(id) ON DELETE CASCADE`, `filename`,
`position`.

Außer den Primärschlüsseln gibt es keine eindeutigen Felder. Bekannt ist bisher nur die iCloud-Regel zu eindeutigen
Primärschlüsseln; weitere Regeln des Abgleichs werden in Teil 6 geprüft.

**Swift-Modelle**

- `Item.id` wird zur `UUID` (lokal der Primärschlüssel, im Server-Modus die `uuid` vom Server).
  Neu ist `serverID: Int?`, nur im Server-Modus gesetzt und für die API-Pfade gebraucht.
- `ItemImage` bekommt ebenso `id: UUID` und `serverID: Int?`.
- Neue Artikel bekommen ihre UUID in der App, in beiden Modi. Im Server-Modus wird sie beim Anlegen mitgeschickt.
- `ItemDraft` und die Statuswerte bleiben unverändert. `ItemInput` wird beim Anlegen um die UUID ergänzt.
- Kennt ein Server noch keine `uuid` (alte Version), meldet die App: „Der Server ist zu alt. Bitte aktualisieren.“

## 3. Speicher-Schicht

Der `ItemStore` spricht nicht mehr direkt mit dem `APIClient`, sondern mit einer Schnittstelle:

```swift
protocol ItemRepository {
    func loadItems() async throws -> [Item]
    func createItem(id: UUID, _ input: ItemInput) async throws
    func updateItem(_ item: Item, _ input: ItemInput) async throws
    func deleteItem(_ item: Item) async throws
    func addImages(to item: Item, jpegs: [Data]) async throws -> [ItemImage]
    func deleteImage(_ image: ItemImage) async throws
    func reorderImages(of item: Item, _ order: [ItemImage]) async throws
    func imageURL(_ image: ItemImage) -> URL?
}
```

Die Methoden bekommen das ganze Modell statt nur der ID, damit die Server-Variante die `serverID` daraus lesen kann.

- **`ServerRepository`**: nutzt den heutigen `APIClient`, ergänzt um Bild-Upload, Bild-Löschen und Reihenfolge.
- **`LocalRepository`**: SQLite-Datei und Fotoordner. Schreibvorgänge laufen in Transaktionen und setzen `updated_at`.
- **`ItemStore`**: hält genau eine Variante, je nach Modus. Die Views nutzen weiter `store.items`, `save`, `delete`
  und `imageURL` und ändern sich nur beim ID-Typ.

## 4. Modus und Einstellungen

- Gespeichert in `@AppStorage("storageMode")` mit den Werten `local` und `server`.
- **Bestandsnutzer:** Ist beim ersten Start nach dem Update noch kein Modus gesetzt, aber eine Serveradresse
  eingetragen, wird `server` gewählt. Sonst `local`.
- **Einstellungen**, neuer Abschnitt „Speicherort“ mit der Wahl „Auf diesem Gerät“ oder „Mein Server“.
  Adresse und „Verbindung testen“ erscheinen nur bei „Mein Server“. Umgeschaltet wird erst nach einem erfolgreichen
  Verbindungstest.
- Hinweis unter der Wahl: „Bis zur Umzugs-Funktion sind die Daten auf dem Gerät und auf dem Server getrennt.“
- **Start-Tab:** Die App öffnet die Einstellungen nur noch, wenn der Modus `server` ist und keine Adresse eingetragen
  ist. Im lokalen Modus startet sie in der Artikelliste.

## 5. Fotos

**Auswahl:** Apples Foto-Auswahl (`PhotosPicker`), mehrere auf einmal, höchstens 60 pro Artikel. Sie braucht keine
Freigabe für die ganze Mediathek.

**Aufbereitung** (beide Modi gleich, außerhalb des Main Actors): Ausrichtung übernehmen, lange Kante höchstens
1800 px, JPEG mit Qualität 0,85. HEIC wird dabei zu JPEG, damit die Web-App die Fotos auch in Chrome anzeigen kann.
Kleinere Bilder werden nicht vergrößert.

**Lokal:** Datei `<UUID>.jpg` im Ordner `uploads/` unter *Application Support*, dazu eine Zeile in `images`.
Wird ein Bild gelöscht, gehen Zeile und Datei. Wird ein Artikel gelöscht, werden nach dem erfolgreichen Löschen in
der Datenbank auch seine Dateien entfernt.

**Server:** bestehende API. Upload in Paketen zu je 5 Fotos (`POST /api/items/:id/images`, Feld `images`), danach
Reihenfolge per `PUT /api/items/:id/images/order`, Löschen per `DELETE /api/images/:id`.

**Formular:** Galerie zum Hinzufügen, Entfernen und Sortieren per Ziehen. Das erste Foto ist das Titelbild.
Änderungen werden wie in der Web-App beim Speichern angewendet: erst den Artikel speichern, dann entfernte Fotos
löschen, dann neue hochladen, zuletzt die Reihenfolge speichern.

**Detailansicht:** Wischen durch alle Fotos, Vollbild mit Zoom. **Liste:** erstes Foto als Vorschaubild.

## 6. Fehlerverhalten

- **Server nicht erreichbar:** Meldung und „Erneut“ wie heute.
- **Upload bricht ab:** Der Artikel bleibt gespeichert, schon hochgeladene Fotos bleiben. Es gibt eine Meldung mit
  „Erneut versuchen“, die nur die fehlenden Fotos hochlädt.
- **Lokaler Schreibfehler** (z. B. Speicher voll): Meldung, die Transaktion wird zurückgerollt. Fotodateien, deren
  Datenbankzeile nicht gespeichert wurde, werden wieder entfernt.
- **Migration der Datenbank schlägt fehl:** Die App zeigt einen Fehler statt einer leeren Liste und lässt die Datei
  unangetastet.

## 7. Tests

**iOS** (XCTest, läuft im Workflow `ios.yml`):

- `LocalRepository` mit Datenbank im Arbeitsspeicher: Anlegen, Ändern, Löschen, Bilder werden mitgelöscht,
  Reihenfolge, `updated_at` wird gesetzt.
- Dateien: Beim Löschen von Bild und Artikel verschwinden die Dateien (temporärer Ordner).
- Modus-Wahl: Standard ist `local`, Bestandsnutzer mit Adresse landen in `server`.
- Aufbereitung: lange Kante höchstens 1800 px, Ergebnis ist JPEG, HEIC wird umgewandelt, kleine Bilder bleiben klein.
- `ServerRepository` gegen den nachgebauten Server (`StubURLProtocol`): Anlegen mit UUID, Upload in Paketen,
  Reihenfolge, Löschen über die `serverID`, Meldung bei Server ohne `uuid`.

**Server:** `npm test` mit neuen Fällen für das Nachtragen der UUIDs, den Trigger auf allen Anlege-Wegen,
`POST` mit UUID (neu, 400, 409) und `PUT`, das die UUID nicht ändert.

**Von Hand:** beide Modi auf dem iPhone, und das Update von der heutigen App-Version mit eingetragener Serveradresse.

## 8. Umsetzung in Pull Requests

Jeweils eigener Branch, ein Commit, ein Pull Request:

1. Server: UUID für Artikel und Bilder.
2. iOS: Speicher-Schicht und `ServerRepository`, `Item.id` wird UUID. Das Verhalten bleibt gleich. Braucht PR 1.
3. iOS: `LocalRepository` und Modus-Wahl.
4. iOS: Fotos in beiden Modi.
