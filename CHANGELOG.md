# Changelog

Alle nennenswerten Änderungen an Nula.

## [2.5.0] - 2026-08-23

### Neu
- **Nula aktualisiert sich selbst.** Beim Start und alle sechs Stunden wird der Release-Feed
  geprüft, eine gefundene Version im Hintergrund geladen und unter **Einstellungen → Updates**
  gemeldet. Installiert wird ausschließlich auf Knopfdruck
- Vor dem Update-Neustart wird der Vault weggeschrieben. `quitAndInstall()` ersetzt den Prozess
  und geht am normalen Beenden-Weg vorbei; ohne diesen Schritt wäre alles seit dem letzten Push
  verloren, weil der Vault nur im Arbeitsspeicher liegt. Scheitert das Sichern, bricht das
  Update ab
- Schalter **Automatisch nach Updates suchen**. Jede Abfrage verrät GitHub die IP dieser
  Installation, deshalb ist sie abschaltbar. Die Einstellung liegt in `config.json` und nicht im
  Vault, sonst wäre sie im gesperrten Zustand nicht lesbar
- macOS wird jetzt bei jedem Release mitgebaut, als eine universelle `.dmg` für Intel und Apple
  Silicon

### Korrekturen
- **Im gesperrten Zustand fehlten die Fensterknöpfe.** Der Sperrbildschirm liegt als Overlay
  (`z-index: 100`) über der Chrome-Leiste (`z-index: 10`) und verdeckte damit Minimieren,
  Maximieren und Schließen vollständig — auf Windows und Linux blieb dort nur Alt+F4. Der
  Sperrbildschirm hat jetzt einen eigenen Satz Knöpfe
- Der Screenshot-Test trug die echte Sync-Adresse und den echten Gerätenamen des Entwicklers als
  Demodaten; beides sind jetzt Platzhalter wie im übrigen Projekt
- `.gitignore` schließt `*.nula-backup.json` aus. Das ist die Exportdatei der App selbst, sie
  enthält den kompletten Vault samt privatem Inbox-Schlüssel, und der Speichern-Dialog startet
  leicht im Projektordner

## [2.4.1] - 2026-08-23

Reine Verpackung. Am Programm selbst ändert sich nichts.

### Korrekturen
- **Der Windows-Installer wurde beim Bauen überschrieben.** `nsis` und `portable` trugen
  denselben `artifactName`, also blieb nach `npm run dist:win` genau eine Datei übrig — das
  Portable. Beide Ziele haben jetzt eigene Namen: `Nula-Setup-<version>-x64.exe` und
  `Nula-<version>-x64-portable.exe`
- Die Zeile in `files`, die nur den Schriftschnitt „regular" der Icons einpacken sollte, hatte
  keine Wirkung: positive Muster schränken Produktions-Dependencies nicht ein. Mit einem
  negativen Muster fliegen die anderen fünf Schnitte tatsächlich raus, das spart 11 MB

### Neu
- Eigenes App-Icon statt des Electron-Standards, gezeichnet aus demselben Markenzeichen wie in
  der Oberfläche: ein Ring in der Akzentfarbe mit diagonalem Strich. Als `.ico` mit sieben
  Größen von 16 bis 256 Pixeln
- `author` und `homepage` in `package.json`, damit Windows im Installer und unter „Apps &
  Features" einen Herausgeber anzeigt
- Der Dateiname des AppImage im README war seit jeher falsch: er trägt keinen `-x86_64`-Zusatz,
  wie der erste echte Release-Build gezeigt hat
- `.github/workflows/release.yml`: Ein Push auf `main`, der die Version anhebt, baut Installer
  für Windows und Linux, lässt auf Windows die Testsuite laufen und veröffentlicht das Ergebnis
  als GitHub-Release mit den Release-Notes aus diesem Changelog. Ohne Versionswechsel endet der
  Lauf sofort, macOS ist wegen der zehnfachen Runner-Minuten nur auf Zuruf dabei

## [2.4.0] - 2026-08-23

### Neu
- **Backup importieren** in den Einstellungen. Eine `.nula-backup.json` lässt sich wieder
  einlesen, solange dasselbe Master-Passwort entsperrt ist; damit ist der Export aus 2.3
  erstmals ein vollständiger Wiederherstellungsweg
- Der Import führt zusammen statt zu ersetzen: gleiche IDs gewinnen nach Zeitstempel, hier
  gelöschte Einträge bleiben gelöscht, und ein zweiter Import derselben Datei ändert nichts.
  Tombstones laufen nach 30 Tagen ab; ein älteres Backup kann davor gelöschte Lesezeichen
  deshalb zurückbringen, was README und Import-Dialog jetzt auch so sagen
- Verschlüsselte Inbox-Einträge, die beim Export noch offen waren, werden beim Import
  entsiegelt und mit übernommen
- Vor dem Zusammenführen fragt Nula, ob auch die Einstellungen aus dem Backup gelten sollen

### Korrekturen
- **Tombstones vervielfachten sich bei jedem Sync.** `mergeVaults()` hängte beide Listen
  aneinander, ohne nach ID zu deduplizieren, also `|lokal| + |remote|` bei jedem Merge. Bei
  zwei aktiven Geräten genügte **ein** gelöschtes Lesezeichen: die Liste wuchs Fibonacci-artig
  auf fünfstellige Kopien derselben ID, der Vault-Blob überschritt das 8-MB-Limit des Servers,
  und der `413` ließ das Gerät nie wieder pushen — bei einem Vault, der nur im RAM liegt, sind
  die Änderungen beim Beenden weg. Betraf den normalen Sync, nicht nur den Import
- Ein gelöschter Eintrag kommt über die Inbox nicht mehr zurück. Die Tombstone-Prüfung fehlte
  beim Übernehmen von Inbox-Einträgen ganz, betraf also auch den normalen Sync, wenn das
  serverseitige Löschen eines bereits übernommenen Eintrags fehlgeschlagen war
- Ein Backup-Eintrag ohne brauchbares `updatedAt` überschreibt keinen neueren lokalen mehr;
  der Zeitstempelvergleich ist bei `NaN` immer falsch und hätte den Import gewinnen lassen
- Ein Tab ohne `deviceId` aus einem fremden Backup lässt die Geräteliste nicht mehr auflaufen
- Die aktuelle Inbox-Identität wird beim Import nie durch eine ältere aus dem Backup ersetzt.
  Die allgemeine Merge-Regel bevorzugt die ältere Identität, was hier alle seither
  versiegelten Inbox-Einträge unlesbar gemacht hätte
- Tabs, die ein Backup für dieses Gerät enthält, laufen jetzt als eigenes Gerät `backup` mit,
  statt bei der nächsten Tab-Erfassung wieder zu verschwinden
- Tombstones werden beim Import zusammengefasst; wiederholte Importe hatten die Liste und
  damit den verschlüsselten Vault sonst immer weiter wachsen lassen
- Der Export hängt `.nula-backup.json` nicht mehr stillschweigend an einen bereits bestätigten
  Dateinamen an. Traf der ergänzte Name eine vorhandene Datei, wurde sie ohne Rückfrage
  überschrieben, weil die Bestätigung des Speichern-Dialogs einem anderen Pfad galt
- Der letzte Sync beim Sperren, Schließen und Beenden wartet höchstens acht Sekunden. Bei
  nicht erreichbarem Server wirkte das Fenster vorher bis zu einer halben Minute eingefroren
- Fenster schließen und Beenden starten während eines laufenden Sperrvorgangs keinen zweiten
  Flush mehr; der Sperrvorgang erledigt ihn bereits
- Ein Import meldet keinen Erfolg mehr, wenn der Browser sich zwischendurch gesperrt und die
  zusammengeführte Sitzung damit verworfen hat
- Ein Backup bringt seine eigenen Löschungen mit, ein Import kann also auch lokale Einträge
  entfernen. Das steht jetzt im Dialog, im Hinweistext und in der Rückmeldung; vorher zeigte
  der Toast dafür eine negative Zahl an

### Tests
- Integrationstest auf 65 Prüfungen erweitert: Import-Roundtrip, Ablehnung eines fremden
  Master-Passworts, Tombstone-Schutz, Identitäts-Rückdrehung, Tab-Zuordnung, Tombstone-Dedup,
  Einstellungs-Wahl, wiederholter Import, ein strukturell kaputtes Backup und die
  Normalisierung von Einträgen ohne brauchbares `updatedAt` oder `deviceId`. Eine eigene
  Prüfung fährt vierzehn wechselseitige Merges und besteht darauf, dass am Ende genau ein
  Tombstone übrig ist

## [2.3.0] - 2026-08-23

### Neu
- Vollständiger verschlüsselter Datenexport direkt in den Einstellungen als portable
  `.nula-backup.json`
- Enthalten sind Vault, Tabs, Lesezeichen, Notizen, Einstellungen, Tombstones,
  Inbox-Identität, lokale Gerätekonfiguration, Sync-Status, API-Token-Metadaten und noch
  ausstehende verschlüsselte Inbox-Einträge
- Aktuelle Tabs werden vor dem Export erfasst; nicht erreichbare optionale Server-Metadaten
  verhindern keinen lokalen Vault-Export und werden im Ergebnis kenntlich gemacht

### Sicherheit
- Eigener HKDF-Kontext `nula-backup-v1`, frischer 256-Bit-Salt und AES-256-GCM mit
  authentifizierter Formatbindung statt Wiederverwendung eines normalen Vault-Chiffrats
- Master-Passwort, Auth-Key und API-Token-Geheimnisse werden nie exportiert; URLs, Notizen und
  private Inbox-Schlüssel erscheinen ausschließlich im verschlüsselten Payload
- Jedes Backup wird vor dem Schreiben entschlüsselt und verifiziert, auf 32 MiB begrenzt,
  atomisch geschrieben, gegen Symlink-Ziele geschützt und nach Möglichkeit auf `0600` gesetzt

### Dokumentation und Tests
- README dokumentiert Umfang, Grenzen, Kryptographie und den bewusst gewählten Speicherort;
  die Aussage zu dauerhaft geschriebenen Dateien berücksichtigt nun explizite Exporte
- Electron-Integrationstest auf 46 Prüfungen erweitert: Roundtrip, fehlender Klartext,
  Manipulationserkennung, sicheres Ersetzen und keine temporären Restdateien

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
