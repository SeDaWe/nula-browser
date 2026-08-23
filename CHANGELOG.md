# Changelog

Alle nennenswerten Änderungen an Nula.

## [2.2.0] - 2026-08-23

### Sicherheit
- Frische Server werden mit `NULA_SETUP_TOKEN` aus der Serverkonfiguration geschützt; der
  Browser sendet den Code nur für Setup oder bewusste Identitätsreparatur und speichert ihn nie
- Sync-Zugangsdaten werden nicht über HTTP außerhalb von localhost oder über Redirects gesendet
- Vom Server gelieferte Argon2id-Parameter haben clientseitige Obergrenzen gegen Speicher-DoS
- Navigation ist auf HTTP(S) und die interne New-Tab-Seite begrenzt; `file://`, `javascript://`
  und andere Fremdschemata werden als Suchtext behandelt, während `localhost:PORT` weiterhin
  korrekt als lokale Adresse erkannt wird
- Die Inbox-Identität kann nur mit Master-Key plus Setup-Code bewusst rotiert werden

### Zuverlässigkeit
- Inbox-Einträge werden erst nach einem erfolgreichen Vault-Upload gelöscht und über ihre ID
  idempotent übernommen; Notizen bleiben verschlüsselt im Vault statt verworfen zu werden
- Gleichzeitige Pushes werden zusammengeführt und von `flush()` abgewartet; fehlgeschlagene
  Live-Pushes werden erneut versucht
- Auch „Beenden“ aus dem App-Menü wartet auf den letzten Sync
- Fehlgeschlagene Unlocks räumen abgeleitete Schlüssel, Sync-Timer und Teilzustände vollständig auf

### Dokumentation und Tests
- README an den Caddy-freien Serverbetrieb und das tatsächliche Verhalten lokaler Metadaten angepasst
- Paketversion im Lockfile korrigiert und Navigationstests für gefährliche URL-Schemata ergänzt

## [2.1.0] - 2026-08-22

### Neu
- Checkbox **"URL merken"** im Sperrbildschirm. Bisher wurde die Server-Adresse immer in
  `~/.nula/config.json` geschrieben; jetzt ist das eine bewusste Entscheidung
- Die Entscheidung selbst wird gemerkt, damit der Haken beim nächsten Start richtig steht.
  Ist er entfernt, wird eine bereits gespeicherte Adresse beim nächsten Entsperren gelöscht
- Der Hinweistext unter dem Feld sagt jeweils, was passiert: gespeichert wird in
  `~/.nula/config.json`, oder die Adresse bleibt nur im Arbeitsspeicher
- Die Geräte-ID bleibt in jedem Fall erhalten. Ohne sie sähe jeder Start wie ein neues
  Gerät aus und es würden sich verwaiste Tabs ansammeln
- `NULA_CONFIG_DIR` verlegt die Konfiguration an einen anderen Ort. Nützlich für portable
  Installationen und dafür, dass die Tests nicht das echte Benutzerverzeichnis anfassen

### Behoben
- Die neue Checkbox stand zunächst über statt neben ihrem Text, weil die allgemeine Regel
  für Formular-Labels spezifischer war und das Flex-Layout überstimmt hat

### Tests
- Integrationstest auf 38 Prüfungen: sieben davon decken ab, dass mit Haken gespeichert
  wird, ohne Haken nichts in der Datei landet und die Geräte-ID beides überlebt
- Zusätzlicher Screenshot im Oberflächentest mit abgewähltem Haken

## [2.0.0] - 2026-08-22

Kryptographie auf BSI TR-02102-1 in der Fassung 2026-01 gebracht und alle Pakete aktualisiert.

> **Bricht bestehende Konten.** Vault-Format und Inbox-Format sind neu, eine Migration gibt es
> nicht. Wer schon ein Konto hat, muss das Datenverzeichnis des Servers löschen und neu anlegen.

### Kryptographie
- Passwortableitung von scrypt auf **Argon2id** umgestellt (256 MiB, 3 Durchläufe). scrypt und
  PBKDF2 kommen in der aktuellen TR-02102-1 nicht mehr vor, Argon2id ist die genannte Empfehlung
- Argon2id läuft als WebAssembly, weil Electrons BoringSSL kein Argon2 anbietet. Die Testsuite
  vergleicht die Ausgabe Byte für Byte mit Nodes nativer OpenSSL-Implementierung
- Inbox-Versiegelung von reinem X25519 auf **hybrid X25519 + ML-KEM-1024** umgestellt. Die
  Richtlinie empfiehlt den alleinigen Einsatz klassischer Verfahren nur noch bis Ende 2031,
  Begründung ist "Store Now, Decrypt Later"
- Hybridisierung im CatKDF-Stil nach Abschnitt 2.2: beide Secrets verkettet, der gesamte
  öffentliche Kontext als SHA-256-Digest in die Ableitung gebunden
- Vault-Verschlüsselung leitet jetzt pro Schreibvorgang einen **frischen Schlüssel** aus einem
  zufälligen 32-Byte-Salt ab. Damit ist die Grenze von 2^32 GCM-Aufrufen pro Schlüssel
  strukturell nicht erreichbar
- Vault-Blob trägt eine Formatversion im ersten Byte
- Der private ML-KEM-Schlüssel liegt im verschlüsselten Vault, weil Node ML-KEM-Schlüssel nicht
  deterministisch aus einem Seed erzeugen kann. Bei konkurrierenden Identitäten gewinnt die ältere

### Abhängigkeiten
- Electron von 33 auf **43.4.1** angehoben. Das bringt Node 24 mit, und damit ML-KEM im Kern
- electron-builder auf 26.15.3, @phosphor-icons/web auf 2.1.2
- `hash-wasm` als einzige neue Laufzeit-Abhängigkeit, reines WebAssembly ohne nativen Build

### Oberfläche
- Der Entsperr-Knopf meldet "Schlüssel werden abgeleitet", solange Argon2id rechnet

### Tests
- Protokoll- und Kryptotest von 34 auf **58 Prüfungen**, darunter der Byte-Vergleich von
  WASM-Argon2id gegen OpenSSL und der Nachweis, dass **beide** Hälften der hybriden
  Verschlüsselung nötig sind
- Ablauftest auf 39 Prüfungen, inklusive Weitergabe der Inbox-Identität an ein zweites Gerät
- Electron-Integrationstest auf 31 Prüfungen, jetzt mit einem eigenen Kryptoblock, der Argon2id,
  ML-KEM und die hybride Versiegelung **unter Electron** nachweist

### Behoben
- Beim Tab-Wechsel konnte die Seite unsichtbar bleiben: die View wurde nach dem Setzen der Größe
  neu in den Baum gehängt, was die Bounds zurücksetzte
- HKDF begrenzt das Feld `info` auf 1024 Byte; der rohe Hybrid-Kontext lag darüber und ließ jede
  Versiegelung scheitern

## [1.0.0] - 2026-08-22

Erste Fassung.

### Datenschutz
- Browsing-Sitzung läuft in einer nicht-persistenten Partition: Verlauf, Cookies,
  Cache und Storage existieren nur im Arbeitsspeicher
- Chromium-Profil liegt in einem zufällig benannten Temp-Ordner und wird beim Beenden
  gelöscht; ein abgekoppelter Aufräumprozess erledigt die Reste, die Chromium beim
  Herunterfahren noch gesperrt hält
- Beim Start werden Profile weggeräumt, die ein abgestürzter Vorlauf hinterlassen hat
- DNS-over-HTTPS über Quad9 und Cloudflare
- Tracker-Blocker mit kuratierter Hostliste, ohne Nachladen externer Listen
- Referrer wird auf den Origin gekürzt, der Header X-Client-Data entfernt
- Berechtigungsanfragen werden bis auf Vollbild abgelehnt
- Downloads fragen immer nach dem Speicherort
- Einzige Datei auf der Platte: ~/.nula/config.json mit Server-Adresse und Geräte-ID

### Sicherheit
- Sperren schließt alle Tabs, leert die Sitzung und entfernt die Schlüssel
- Automatisches Sperren nach einstellbarer Zeit ohne Eingabe
- Globales Kürzel Strg/Cmd + Umschalt + L zum Sofortsperren
- Renderer läuft mit Context-Isolation ohne Node-Zugriff, Seiten zusätzlich sandboxed

### Sync
- Live-Sync mit 2,5 Sekunden Debounce plus Pull alle 20 Sekunden
- Blockierender Push beim Schließen des Fensters
- Optimistische Nebenläufigkeit: Konflikte werden zusammengeführt und erneut versucht
- Tabs sind pro Gerät getrennt, Lesezeichen werden nach Zeitstempel zusammengeführt
- Löschungen laufen über Tombstones mit 30 Tagen Lebensdauer

### API
- Inbox-Endpunkt für externe Programme, abgesichert über widerrufbare Tokens
- Tokens dürfen ausschließlich schreiben, nicht lesen
- Token-Verwaltung direkt im Browser

### Oberfläche
- Dunkles und helles Design, umschaltbar in den Einstellungen
- Sperrbildschirm im asymmetrischen Split-Layout
- Panel für Lesezeichen, Geräte, Einstellungen und API-Tokens
- Leer-, Lade- und Fehlerzustände in allen Listen
- Bewegung respektiert prefers-reduced-motion
- Kein Build-Schritt, keine Netzwerk-Requests beim Start
