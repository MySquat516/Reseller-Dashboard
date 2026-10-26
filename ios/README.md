# Reseller – iOS/iPadOS-App (SwiftUI)

Native App für iPhone und iPad. Sie ist ein Client für den bestehenden Reseller-Dashboard-Server
(Node + SQLite): Die Daten bleiben auf dem Server, die App ruft die REST-API auf.
Unterwegs wie bei der Webapp zuerst das VPN verbinden.

**Stand:** Phase 0–2 (Gerüst, API-Schicht, Artikelliste mit Suche, Filter, Anlegen, Bearbeiten, Löschen).
Fotos, Dashboard, Versandvorlagen und CSV folgen in den nächsten Phasen.

## Voraussetzungen

- Mac mit **Xcode 16 oder neuer**
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- iPhone/iPad mit iOS bzw. iPadOS 17 oder neuer (Entwicklermodus eingeschaltet:
  Einstellungen → Datenschutz & Sicherheit → Entwicklermodus)
- Eine Apple-ID (die kostenlose reicht zum Ausprobieren, siehe unten)

## Projekt erzeugen und starten

```bash
git clone https://github.com/MySquat516/Reseller-Dashboard.git
cd Reseller-Dashboard/ios
xcodegen generate          # erzeugt ResellerApp.xcodeproj aus project.yml
open ResellerApp.xcodeproj
```

In Xcode:

1. Links das Projekt **ResellerApp** wählen → Target **ResellerApp** → **Signing & Capabilities**.
2. **Team** auswählen (Apple-ID unter Xcode → Settings → Accounts anmelden).
3. **Bundle Identifier** ändern, z. B. `de.deinname.reseller` (muss weltweit eindeutig sein).
   Dasselbe in `project.yml`, damit es nach einem neuen `xcodegen generate` erhalten bleibt.
4. iPhone oder iPad per Kabel anschließen, oben als Ziel auswählen, **Run** (⌘R).
5. Beim ersten Start auf dem Gerät: Einstellungen → Allgemein → VPN & Geräteverwaltung →
   Entwicklerzertifikat vertrauen.
6. In der App im Tab **Einstellungen** die Serveradresse eintragen (z. B. `http://192.168.1.20:3000`)
   und **Verbindung testen**.

Tests: ⌘U in Xcode oder

```bash
xcodebuild test -project ResellerApp.xcodeproj -scheme ResellerApp \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```

### Ohne XcodeGen

In Xcode ein neues Projekt „App“ (SwiftUI, Swift) anlegen, den Ordner `ResellerApp/` hineinziehen
(Standard-`ContentView` und -`App`-Datei löschen), iOS 17 als Mindestversion und iPhone+iPad als Geräte
einstellen. Zusätzlich in den Target-Einstellungen unter **Info**:
`App Transport Security Settings → Allow Arbitrary Loads = YES` und
`Privacy – Local Network Usage Description` setzen.

## Hinweise

- **HTTP:** Der Server läuft im Heimnetz ohne HTTPS. Die App erlaubt deshalb unverschlüsselte Verbindungen
  (App Transport Security, siehe `project.yml`). Vor einer Veröffentlichung auf HTTPS umstellen und die
  Ausnahme entfernen.
- **Kostenlose Apple-ID:** Die App läuft 7 Tage und muss dann neu aus Xcode installiert werden.
  Mit dem Apple Developer Program (99 $/Jahr) gibt es TestFlight: Updates ohne Kabel, Builds halten 90 Tage.
- **Kein Login:** Wie die Webapp hat auch die App keinen eigenen Login. Der Server gehört nur ins Heimnetz/VPN.

## Aufbau

```
ios/
├── project.yml              XcodeGen-Konfiguration
├── ResellerApp/
│   ├── ResellerApp.swift    App-Einstieg (ResellerAppMain)
│   ├── Models/              Item, ItemStatus, ItemInput (JSON ↔ Swift)
│   ├── Services/            APIClient (REST), ItemStore (Zustand)
│   ├── Support/             Zahlen-, Währungs- und Datumshilfen
│   ├── Views/               Oberfläche
│   └── Assets.xcassets/     App-Icon, Akzentfarbe
└── ResellerAppTests/        Unit-Tests (Modelle, API-Client mit Stub)
```
