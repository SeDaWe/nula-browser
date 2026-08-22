# Nula

Ein Browser, der auf dem Rechner nichts hinterlässt und trotzdem auf allen Geräten
dieselben Tabs und Lesezeichen hat.

Verlauf, Cookies und Cache existieren ausschließlich im Arbeitsspeicher. Was du behalten
willst, liegt Ende-zu-Ende verschlüsselt auf deinem eigenen Server. Ohne Master-Passwort
startet nichts, und es gibt lokal auch nichts, das man ohne dieses Passwort auslesen könnte.

Läuft auf **Windows, macOS und Linux**. Der zugehörige Server liegt in
[SeDaWe/nula-server](https://github.com/SeDaWe/nula-server).

---

## Inhalt

- [Wie es funktioniert](#wie-es-funktioniert)
- [Einrichten](#einrichten)
- [Installation unter Debian 13](#installation-unter-debian-13)
- [Installer bauen](#installer-bauen)
- [Tastenkürzel](#tastenkürzel)
- [Was beim Sperren passiert](#was-beim-sperren-passiert)
- [Sync-Verhalten](#sync-verhalten)
- [Von außen befüllen](#von-außen-befüllen)
- [Was Nula auf die Platte schreibt](#was-nula-auf-die-platte-schreibt)
- [Kryptographie](#kryptographie)
- [Tests](#tests)
- [Aufbau](#aufbau)

---

## Wie es funktioniert

```
   Windows-Rechner              dein Server                  MacBook
  ┌────────────────┐         ┌──────────────┐         ┌────────────────┐
  │  Nula          │         │ Nula Server  │         │  Nula          │
  │  Tabs im RAM   │◄───────►│              │◄───────►│  Tabs im RAM   │
  │  Schlüssel im  │  nur    │ nur Chiffrat │  nur    │  Schlüssel im  │
  │  RAM           │ Chiffrat│              │ Chiffrat│  RAM           │
  └────────────────┘         └──────┬───────┘         └────────────────┘
                                    │
                                    │  API-Token, darf nur schreiben
                             ┌──────┴───────┐
                             │ Skript, App, │
                             │ Handy        │
                             └──────────────┘
```

Das Master-Passwort erzeugt über **Argon2id** drei Schlüssel: einer authentifiziert dich
beim Server, einer verschlüsselt den Vault, einer ist die klassische Hälfte des
Schlüsselaustauschs für Einträge von außen. Nur der erste verlässt jemals das Gerät.

---

## Einrichten

**1. Server starten** (Anleitung in [nula-server](https://github.com/SeDaWe/nula-server)):

```bash
git clone https://github.com/SeDaWe/nula-server.git
cd nula-server
cp .env.example .env      # Domain eintragen
docker compose up -d --build
```

Der Stack bringt Caddy mit und holt sich das Zertifikat für deine Domain selbst.

**2. Browser starten:**

```bash
git clone https://github.com/SeDaWe/nula-browser.git
cd nula-browser
npm install
npm start
```

**3. Im Sperrbildschirm** die Server-Adresse und ein Master-Passwort eintragen. Beim ersten
Mal legt das Passwort das Konto an. Auf jedem weiteren Gerät dieselbe Adresse und dasselbe
Passwort eingeben, und alles ist da.

Das Entsperren dauert bewusst rund eine Sekunde: Argon2id rechnet mit 256 MiB Speicher,
damit Rateversuche auf Grafikkarten teuer werden.

Der Haken **URL merken** entscheidet, ob die Server-Adresse in `~/.nula/config.json` landet.
Ohne ihn bleibt sie nur im Arbeitsspeicher und das Feld ist beim nächsten Start wieder leer.
Das Passwort wird ohnehin nie gespeichert.

> Es gibt keine Wiederherstellung. Ist das Passwort weg, ist der Vault weg. Das ist der
> Preis dafür, dass der Server nichts entschlüsseln kann.

---

## Installation unter Debian 13

Nula ist eine Desktop-Anwendung. Für Debian 13 (Trixie) gibt es zwei Wege.

### Variante A: AppImage (empfohlen)

Ein einzelnes ausführbares Paket, keine Systemänderungen.

```bash
sudo apt update
sudo apt install -y libfuse2t64 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64
```

AppImage aus den [Releases](https://github.com/SeDaWe/nula-browser/releases) laden oder
selbst bauen (siehe unten), dann:

```bash
sudo mkdir -p /opt/nula
sudo mv Nula-2.1.0-x86_64.AppImage /opt/nula/nula.AppImage
sudo chmod +x /opt/nula/nula.AppImage
sudo ln -sf /opt/nula/nula.AppImage /usr/local/bin/nula
```

Startmenü-Eintrag:

```bash
sudo tee /usr/share/applications/nula.desktop > /dev/null <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Nula
Comment=Privacy-Browser ohne Spuren auf der Platte
Exec=/opt/nula/nula.AppImage %U
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=Nula
DESKTOP

sudo update-desktop-database
```

Starten mit `nula` oder über das Startmenü.

### Variante B: Aus dem Quelltext

Sinnvoll, wenn du am Code arbeiten willst.

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # muss v24 oder hoeher zeigen

git clone https://github.com/SeDaWe/nula-browser.git ~/nula-browser
cd ~/nula-browser
npm install
npm start
```

### Hinweise zu Debian

- **Wayland:** Läuft unter XWayland problemlos. Native Wayland-Unterstützung erzwingst du
  bei Bedarf mit `nula --ozone-platform-hint=auto`.
- **Kein Root:** Nula braucht keine erhöhten Rechte. Startest du es als `root`, verweigert
  Chromium die Sandbox. Falls das unumgänglich ist, hilft `--no-sandbox`, was aber die
  Isolation der Webseiten aufhebt und deshalb keine gute Idee ist.
- **Temp-Verzeichnis:** Das Chromium-Profil landet unter `/tmp`. Ist `/tmp` bei dir eine
  tmpfs im RAM, ist das für diesen Browser sogar der Idealfall, weil dann selbst
  theoretische Reste nie die Platte berühren.

---

## Installer bauen

```bash
npm run dist:win     # NSIS-Installer und portable EXE
npm run dist:mac     # DMG und ZIP
npm run dist:linux   # AppImage
```

Ergebnisse landen in `dist/`. Für macOS muss auf einem Mac gebaut werden.

---

## Tastenkürzel

| Kürzel | Wirkung |
|---|---|
| `Strg`/`Cmd` + `T` | Neuer Tab |
| `Strg`/`Cmd` + `W` | Tab schließen |
| `Strg`/`Cmd` + `L` | Adressleiste fokussieren |
| `Strg`/`Cmd` + `B` | Lesezeichen |
| `Strg`/`Cmd` + `R` | Neu laden |
| `Strg`/`Cmd` + `Tab` | Nächster Tab |
| `Strg`/`Cmd` + `Umschalt` + `L` | Sofort sperren |
| `Esc` | Panel schließen |

Das Sperr-Kürzel ist global registriert und wirkt auch, wenn Nula nicht im Vordergrund ist.

---

## Was beim Sperren passiert

1. Der aktuelle Stand wird ein letztes Mal zum Server geschrieben
2. Alle Tabs werden geschlossen
3. Cookies, Cache und Auth-Cache der Sitzung werden geleert
4. Die Schlüssel werden aus dem Speicher entfernt

Danach steht wieder der Sperrbildschirm da, und es gibt nichts mehr, worauf jemand ohne das
Passwort zugreifen könnte. Automatisch passiert das nach der in den Einstellungen gewählten
Zeit ohne Eingabe.

---

## Sync-Verhalten

- **Live:** Jede Änderung plant zweieinhalb Sekunden später einen Push ein
- **Regelmäßig:** Alle zwanzig Sekunden wird geprüft, ob ein anderes Gerät etwas geändert hat
- **Beim Schließen:** Vor dem Beenden wird der Stand blockierend weggeschrieben
- **Bei Konflikten:** Haben zwei Geräte gleichzeitig geschrieben, wird zusammengeführt und
  erneut versucht. Der jüngere Eintrag gewinnt, Löschungen werden 30 Tage als Tombstone
  geführt, damit ein lange offline gewesenes Gerät nichts wiederbelebt.

Tabs gehören jeweils einem Gerät. Dein Windows-Rechner überschreibt also nie die Tabs deines
MacBooks, sieht sie aber unter **Geräte** und kann sie mit einem Klick öffnen.

---

## Von außen befüllen

Im Panel unter **API** erstellst du ein Token. Damit können andere Programme Lesezeichen und
Tabs in dein Konto schieben, ohne irgendetwas lesen zu können:

```bash
curl -X POST https://sync.example.com/api/inbox \
  -H "Authorization: Bearer nula_..." \
  -H "Content-Type: application/json" \
  -d '{"type":"bookmark","url":"https://example.com","title":"Beispiel"}'
```

Der Server versiegelt den Eintrag sofort hybrid mit X25519 und ML-KEM-1024. Beim nächsten
Sync taucht er im Browser auf. Alle Details und Beispiele für PowerShell, Python, Node und
iOS-Kurzbefehle: **[API.md](https://github.com/SeDaWe/nula-server/blob/main/API.md)**.

---

## Was Nula auf die Platte schreibt

Genau eine Datei: `~/.nula/config.json`. Darin stehen ein Gerätename, eine zufällige
Geräte-ID und, falls du den Haken **URL merken** gesetzt lässt, die Adresse deines Servers.
Keine besuchten URLs, keine Schlüssel, keine Sitzungsdaten.

Die Geräte-ID bleibt in jedem Fall erhalten, auch ohne den Haken. Ohne sie sähe jeder Start
wie ein neues Gerät aus, und im Vault würden sich verwaiste Tab-Listen ansammeln.

Mit `NULA_CONFIG_DIR` lässt sich der Ort verlegen, etwa für eine portable Installation:

```bash
NULA_CONFIG_DIR=/pfad/zum/stick/nula npm start
```

Chromium legt beim Start unvermeidlich ein paar technische Dateien an. Die landen in einem
zufällig benannten Ordner im Temp-Verzeichnis und werden beim Beenden gelöscht. Bricht die
App hart ab, räumt der nächste Start die Reste weg.

### Wogegen das nicht schützt

Ehrlich gesagt gehört das dazu:

- **Das Betriebssystem** hinterlässt eigene Spuren. Windows cached DNS-Antworten, und
  Inhalte aus dem Arbeitsspeicher können in der Auslagerungsdatei landen. Dagegen hilft nur
  Festplattenverschlüsselung.
- **Dein Netzwerk** sieht weiterhin, mit welchen Servern du sprichst. Nula nutzt
  DNS-over-HTTPS, damit der Router und der Provider keine Namensauflösung mitlesen, aber die
  IP-Verbindungen selbst bleiben sichtbar. Dagegen hilft nur ein VPN oder Tor.
- **Forensik** mit vollem Zugriff auf die Festplatte könnte theoretisch Reste finden. Gegen
  einen Mitbewohner oder einen gestohlenen Laptop ist es dicht, gegen ein Labor nicht.
- **Fingerprinting** wird nur oberflächlich erschwert. Nula ist kein Tor Browser.

---

## Kryptographie

Alle Verfahren richten sich nach **BSI TR-02102-1 in der Fassung 2026-01**.

| Baustein | Verfahren |
|---|---|
| Passwortableitung | Argon2id, 256 MiB, 3 Durchläufe |
| Schlüsselableitung | HKDF-SHA256 |
| Vault | AES-256-GCM, frischer Schlüssel pro Schreibvorgang |
| Inbox | Hybrid X25519 + ML-KEM-1024 |

Zwei Entscheidungen, die Erklärung verdienen:

**Warum ein neuer Schlüssel bei jedem Schreibvorgang?** Die Richtlinie verlangt einen
Schlüsselwechsel nach spätestens 2^32 GCM-Aufrufen. Der Vault-Schlüssel bleibt aber
unverändert, solange das Passwort gleich bleibt. Bei einem Schlüssel pro Schreibvorgang ist
die Grenze strukturell unerreichbar.

**Warum Post-Quantum für die Inbox?** Die Fassung 2026-01 empfiehlt den alleinigen Einsatz
klassischer Schlüsselaustauschverfahren nur noch bis Ende 2031, begründet mit „Store Now,
Decrypt Later": Chiffrat wird heute gesammelt und später mit einem Quantencomputer geöffnet.
Genau das trifft auf einen Server zu, der jahrelang Daten vorhält.

Die Einzelheiten mit Fundstellen stehen in
[API.md, Kapitel 7](https://github.com/SeDaWe/nula-server/blob/main/API.md#7-krypto-details).

---

## Tests

```bash
npm test        # Electron: Sitzung, Tabs, Blocker, Spuren auf der Platte, Kryptographie
npm run test:ui # Rendert die Oberfläche, prüft auf Konsolenfehler, legt Screenshots ab
```

Der Integrationstest surft eine echte Seite an und durchsucht danach jede Datei im
Profilverzeichnis nach der besuchten Domain. Findet er sie, schlägt er fehl. Außerdem prüft
er die Kryptographie **unter Electron**, nicht nur unter Node: Electron bringt BoringSSL
mit, wo Argon2 fehlt, deshalb muss dort nachgewiesen werden, dass die WebAssembly-Variante
und ML-KEM tatsächlich laufen.

Die Server- und Protokolltests liegen im
[Server-Repository](https://github.com/SeDaWe/nula-server#tests) und erwarten dieses
Repository als Nachbarordner.

---

## Aufbau

```
src/
  main/
    main.js         Fenster, IPC, Sperrlogik, Aufräumen des Temp-Profils
    tabs.js         Tab-Verwaltung als WebContentsView
    sync.js         Live-Sync, Konfliktauflösung, Inbox
    vault.js        Datenformat und Merge-Regeln
    vaultcrypto.js  Argon2id, Vault-Verschlüsselung, hybrides Entsiegeln
    api.js          HTTP-Client zum Server
    blocker.js      Tracker-Blocker und Header-Bereinigung
    urls.js         Adresse oder Suche
    config.js       Die einzige Datei, die auf die Platte geht
    cleanup.js      Abgekoppelter Aufräumer für das Temp-Profil
  preload/
    chrome.js       Brücke zur Oberfläche
    page.js         Minimale Fingerprint-Reduktion in Webseiten
  renderer/         Die Oberfläche, ohne Framework und ohne Build-Schritt
  pages/            Interne Seiten unter nula://
```

Es gibt bewusst keinen Build-Schritt. `npm start` startet direkt, was im Ordner liegt.

Zwei Laufzeit-Abhängigkeiten, beide ohne nativen Build:

| Paket | Wofür |
|---|---|
| `hash-wasm` | Argon2id als WebAssembly, weil Electrons BoringSSL kein Argon2 kennt |
| `@phosphor-icons/web` | Die Icons, lokal statt vom CDN, damit beim Start kein Netzwerk-Request rausgeht |

Alles andere kommt aus Nodes Kryptomodul. ML-KEM-1024 ist ab Node 24 enthalten, das Electron
43 mitbringt.

---

## Lizenz

MIT
