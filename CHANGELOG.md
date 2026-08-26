# Changelog

Alle nennenswerten Änderungen an Nula.

## [2.16.0] - 2026-08-26

### Neu
- **Das Schloss in der Adressleiste ist anklickbar** und zeigt, was ein normaler Browser dort
  zeigt: Zustand der Verbindung, für wen das Zertifikat ausgestellt wurde, Aussteller,
  Laufzeit, Seriennummer, Fingerabdruck — dazu, wie viele Anfragen auf **genau dieser Seite**
  geblockt wurden. Bisher war es ein reines Symbol ohne Funktion
- Ein abgelaufenes Zertifikat wird als abgelaufen ausgewiesen, ein Aussteller außerhalb der
  anerkannten Zertifizierungsstellen wird gewarnt (beim eigenen Server mit selbst signiertem
  Zertifikat ist das der Normalfall), und HTTP bekommt eine deutliche Warnung samt rotem
  Schloss
- Chromium reicht Zertifikate nirgends nach außen; der einzige Weg ist
  `setCertificateVerifyProc`. Dessen Rückgabewert ist sicherheitskritisch: Nula gibt `-3`
  zurück — „nimm Chromiums eigenes Urteil". Mit `0` würde **jedes** Zertifikat angenommen,
  auch das selbst ausgestellte eines Angreifers. Die Stelle prüft nichts, sie schaut nur zu

### Korrekturen
- **Beim Schließen eines Tabs sprang der Fokus auf den letzten Tab**, nicht auf den Nachbarn:
  `close()` griff zu `order[order.length - 1]`. Bei drei Tabs fällt das kaum auf, bei dreißig
  liegt der letzte außerhalb des sichtbaren Bereichs der Leiste — es sah aus, als wäre gar
  nichts mehr ausgewählt. Jetzt übernimmt der rechte Nachbar, am Ende der linke
- **Wiederhergestellte Tabs laden erst beim Anklicken.** Bisher stieß das Entsperren mit
  dreißig Tabs dreißig Seitenladungen gleichzeitig an. Gemessen mit dem echten TabManager:
  nach drei Sekunden drehten sich 26 von 30 Tabs, alle erst nach 15 Sekunden fertig — auf
  einer langsamen Leitung entsprechend länger. Mit der Rückstellung: **null Spinner nach drei
  Sekunden**, 29 Tabs schlafend, und 37 statt 269 Statusmeldungen an die Oberfläche
- Was dabei ausdrücklich **nicht** kaputt war: die Ladeanzeige selbst. Gegengeprüft wurde bei
  allen 30 Tabs Nulas `loading`-Flag gegen `webContents.isLoading()` — kein einziger
  Unterschied. Der Spinner hat nicht gelogen, die Tabs haben wirklich noch geladen
- Schlafende Tabs behalten den Titel aus dem Vault, statt als Reihe gleicher „Neuer Tab"
  dazustehen, und sind etwas blasser gezeichnet

### Tests
- 28 neue Prüfungen, zusammen 183. Zertifikate werden gegen eine **echte** HTTPS-Verbindung
  geprüft: Aussteller, Laufzeit, Fingerabdruck, anerkannte Wurzel
- Das Fenster hinter dem Schloss wird an der echten Oberfläche gemessen — Inhalt der Zeilen,
  Datumsformat, Warnung bei abgelaufenem Zertifikat und unbekannter Wurzel, rotes Schloss bei
  HTTP, sowie Größe und Lage, damit es weder unsichtbar ist noch aus dem Fenster ragt
- Darunter eine Sicherheitsprüfung: Zertifikatsfelder kommen von der Gegenstelle und werden
  nie als HTML gedeutet. Ein `<img src=x onerror=...>` im Zertifikatsnamen bleibt Text und
  erzeugt kein Element
- Schlafende Tabs: laden nichts, drehen sich nicht, behalten Titel und Adresse für den Vault,
  und werden sowohl durch Anklicken als auch durch Navigieren geweckt
- Der Fokus beim Schließen in allen drei Fällen: rechter Nachbar, linker Nachbar am Ende, und
  ein Tab ohne Fokus verschiebt nichts

## [2.15.0] - 2026-08-26

### Korrekturen
- **Mit vielen Tabs war die Leiste nicht mehr bedienbar.** `.tab` hatte `width: 190px` und
  `min-width: 0`, und weil `flex-shrink` voreingestellt 1 ist, schrumpften die Tabs
  unbegrenzt: bei dreißig Tabs war jeder rund dreißig Pixel breit — kein lesbarer Titel, kein
  treffbares Schließkreuz, und ein Klick landete leicht auf dem Nachbarn. Es gab schlicht
  keine Untergrenze und keinen Überlauf
- Jetzt schrumpfen die Tabs bis **112 Pixel** und die Leiste **rollt** danach, so wie in
  Firefox und Chrome. Gerollt wird auf drei Wegen: Mausrad über der Leiste, Wischgeste am
  Trackpad, oder die beiden Pfeile, die nur erscheinen, wenn es etwas zu rollen gibt und am
  jeweiligen Ende ausgrauen
- Das Mausrad brauchte eigene Arbeit: eine Maus liefert nur `deltaY`, das wird auf die
  Waagerechte umgelegt. Eine Wischgeste liefert `deltaX` und läuft ohnehin direkt durch
- **Der aktive Tab wird von selbst in den Blick geholt** — aber nur beim echten Wechsel,
  sonst kämpft die Leiste gegen jeden, der von Hand woanders hinscrollt
- **Ein Neuzeichnen warf die Leiste an den Anfang zurück.** `renderTabs()` läuft bei jeder
  Titel- und Ladeänderung, und `innerHTML = ''` setzt `scrollLeft` auf null. Beim Tippen
  einer Adresse sprang die Leiste dadurch ständig zurück. Die Position wird jetzt gemerkt
- Die Rollleiste unter den Tabs ist ausgeblendet: in einer 40 Pixel hohen Leiste wäre sie nur
  im Weg

### Werkstatt
- **Der Listen-Download hält jetzt einen Netzwerkschluckauf aus.** Ein Release-Lauf starb an
  `assert(!this.paused)` aus undici heraus — geworfen in einem Socket-Handler, also nicht
  einmal von einem `try/catch` um das `await` zu fangen. `tools/build-filters.js` benutzt
  deshalb `node:https` statt `fetch`, mit vier Versuchen und wachsender Pause. Eine einzelne
  wackelige Verbindung kostet keinen Release mehr

### Tests
- 12 neue Prüfungen, zusammen 143. Gemessen wird die echte Oberfläche, nicht ein Bildschirm-
  foto: drei Tabs behalten ihre vollen 190 Pixel und brauchen keine Pfeile, dreißig Tabs
  bleiben alle mindestens 112 Pixel breit und machen die Leiste rollbar, der Vor-Knopf rollt
  wirklich, ein Neuzeichnen behält die Position, ein Wechsel ans Ende holt den letzten Tab in
  den Blick, und das Mausrad wird über ein echtes `sendInputEvent` geprüft
- Der Smoke-Test hält die volle Leiste in zwei Zuständen fest, am Anfang und ans Ende
  gerollt. Er ließ sich in dieser Sitzung auch wieder ausführen: der beschädigte
  GPU-Prozess, der ihn in 2.13 und 2.14 blockierte, hat sich erholt

## [2.14.0] - 2026-08-26

### Neu
- **Echte Filterlisten statt einer handgepflegten Hostliste.** EasyList, EasyPrivacy,
  EasyList Germany, uBlock Origins eigene Listen (Filters, Badware, Privacy, Quick Fixes,
  Unbreak) und Peter Lowes Serverliste — zusammen rund 160.000 Regeln, im Kern dieselbe
  Zusammenstellung, die uBlock Origin voreingestellt hat
- **Geladen wird beim Bauen, nicht beim Start.** `npm run filters` holt die Listen,
  übersetzt sie in eine Engine und legt sie als `src/main/filters/engine.bin` (4,9 MB) neben
  den Code; die Release-Werkstatt ruft das vor jedem Build auf. Zur Laufzeit stellt Nula für
  Filter keine einzige Netzwerkanfrage. Damit fällt die Begründung weg, mit der hier bisher
  auf Listen verzichtet wurde („müssten bei jedem Start nachgeladen werden, und genau dieser
  Request wäre die erste Spur") — sie galt für Laufzeit-Downloads, nicht für Bauzeit
- **Kosmetisches Filtern.** Reines Netzwerkblocken lässt leere Kästen stehen. Die Regeln
  dafür stammen aus denselben Listen und werden pro Seite einmal als CSS eingespritzt
- Die eingebaute Hostliste bleibt als Rückfallebene, wenn die Engine fehlt. Läuft Nula ohne
  Listen, steht das sichtbar unter Einstellungen; dort steht sonst, wie viele Regeln aus wie
  vielen Listen mit welchem Stand greifen

### Korrekturen
- **Der Popup-Wächter fragt jetzt die Listen, nicht nur die Hostliste.** Pop-under-Netze
  wechseln ihre Domains ständig — `salutetutortwiddling.com`, `hai8g.com`, `gamazi.com` sind
  echte Beispiele aus dem Alltag und stehen auf keiner handgepflegten Liste. Auf den
  Filterlisten stehen sie sehr wohl, alle drei
- **Ein Fenster ohne Größe löschte die Tab-Ansicht.** Meldet `getContentSize()` kurzzeitig
  0×0 — minimiert, verborgen, noch nicht vermessen — schrieb `layout()` diese Null in alle
  Views. Die Seite war damit weg und kam erst beim nächsten Größenwechsel zurück. Jetzt
  bleiben die alten Größen stehen. Die gewollte Null beim Sperren ist davon nicht betroffen
- Der Hauptframe wird nicht mehr über `webRequest` abgebrochen, sondern die Navigation
  angehalten: statt einer Fehlerseite bleibt die Seite einfach stehen

### Tests
- 131 Prüfungen, alle grün, dreimal hintereinander stabil. Darunter: die drei echten
  Pop-under-Adressen werden als Werbeziel erkannt **und** die Gegenprobe, dass keine davon in
  der eingebauten Hostliste steht — die Listen tun also wirklich die Arbeit
- Dazu die Null-Größe des Fensters: Fenster auf 0×0 setzen, layouten, prüfen, dass die
  Tab-Ansicht ihre Größe behält
- Eine Testdomain hieß `werbung.example.net` und wurde plötzlich von EasyList Germany
  getroffen, was die falsche Regel greifen ließ. Umbenannt, mit Notiz — als Beleg, dass die
  Listen tun, was sie sollen

## [2.13.0] - 2026-08-26

### Korrekturen
- **Die Popup-Sperre aus 2.12 hat den eigentlichen Pop-under nicht erwischt.** Der Entwurf
  hatte ein Loch, das erst im Alltag auffiel: die Klick-Berechtigung geht an das **erste**
  Fenster — und genau das ist bei einem Pop-under die Werbung. Der eigentliche Link ist gar
  kein zweites Fenster, sondern eine ganz normale Navigation im selben Tab. Die Regel
  „höchstens ein Fenster pro Klick" lief damit ins Leere: es gab ja nur eines
- Was den Fall wirklich verrät, ist die Gleichzeitigkeit — ein Fenster geht auf **und** der
  öffnende Tab navigiert im selben Wimpernschlag. Ein ehrliches `target="_blank"` tut das
  nicht, dort bleibt die Ausgangsseite stehen. Ein Fenster von einer noch unbekannten Seite
  wird deshalb 400 ms zurückgehalten. Navigiert der Opener in dieser Zeit, fällt es weg und
  die Seite ist für den Rest der Sitzung als Pop-under-Seite vermerkt, ab dann ohne
  Wartezeit. Bleibt der Opener stehen, gilt die Seite als unauffällig und öffnet ab dann
  sofort. Die 400 ms fallen also einmal pro Seite an, nicht bei jedem Fenster
- **Mittelklick und Strg-Klick sprangen in den neuen Tab.** `setWindowOpenHandler` bekommt
  von Chromium eine `disposition`, und die wurde schlicht ignoriert: jeder so geöffnete Tab
  ging über `create()` mit der Voreinstellung `activate: true`. Jetzt öffnet
  `background-tab` daneben und lässt den Fokus, wo er war
- Dieselbe Disposition ist nebenbei ein fälschungssicherer Beleg für eine bewusste
  Entscheidung: `window.open()` kann sie nicht erzeugen, es liefert immer `foreground-tab`
  oder `new-window`. Mittelklick und Strg-Klick brauchen deshalb weder Rückhalt noch
  Klick-Prüfung — nur ins Werbenetz kommen auch sie nicht
- Ein Hintergrund-Tab bekam seine Größe nie gesetzt, weil `layout()` bisher nur über
  `activate()` lief

### Tests
- 12 neue Prüfungen, zusammen 114. Darunter der vollständige Pop-under im echten Tab: ein per
  `sendInputEvent` wirklich zugestellter Klick auf einen echten Link, dessen Handler ein
  `window.open()` absetzt, während der Link selbst navigiert — das Werbefenster muss wegfallen
  und die Seite vermerkt werden. Dazu ein echter Mittelklick auf einen echten Link, der einen
  Tab im Hintergrund ergeben muss
- Der Integrationstest bricht jetzt sichtbar ab, wenn der Testcode selbst stolpert. Bis eben
  blieb er in so einem Fall stumm mit offenem Electron-Fenster stehen, was genau einmal
  passiert ist: `executeJavaScript` wertet im globalen Scope aus, ein zweites `const a` ist
  dort ein `SyntaxError`
- Der Smoke-Test läuft jetzt in einem eigenen Wegwerf-Profil statt im gemeinsamen
  Electron-Profil des Rechners (in diesem Projekt ein schlechter Witz), rendert in Software
  statt über die GPU, gibt `capturePage()` eine Frist von 15 Sekunden und hat eine Notbremse
  nach 90 Sekunden. **Ausgeführt werden konnte er in dieser Sitzung nicht:** der
  GPU-/Viz-Prozess dieses Rechners ist beschädigt (`UnknownVizError`), und auch die
  unveränderte Fassung aus 2.12 hängt darin. Die Änderungen dieser Version betreffen keine
  Datei der Oberfläche

## [2.12.0] - 2026-08-26

### Neu
- **Popup- und Pop-under-Sperre** (`src/main/popupguard.js`). Gegen das Muster „jeder Klick
  öffnet erst einen Werbe-Tab, danach erst der eigentliche Link". Bisher machte
  `setWindowOpenHandler` aus **jedem** `window.open()` einen Tab, ohne jede Prüfung — eine
  Seite konnte also beliebig viele Fenster aufmachen, und Nula hat gehorcht. Jetzt gilt, was
  Chromium *user activation* nennt: ein Klick oder Tastendruck berechtigt zu genau einem
  neuen Fenster, danach ist die Berechtigung verbraucht. Electron reicht diese Information
  nicht an den Handler durch, also führt Nula sie selbst — gespeist aus dem `input-event` der
  WebContents, das nur bei echter Eingabe feuert und bei einem per Skript ausgelösten
  `element.click()` nie ankommt. Vier Regeln: Werbenetz als Ziel → immer blockiert; Sperre
  aus oder Seite freigestellt → durchgelassen; kein Klick in der letzten Sekunde → blockiert;
  Klick hat sein Fenster schon bekommen → blockiert. Ein angeklicktes `target="_blank"` ist
  der dritte Fall mit genau einem Fenster und geht durch, Anmeldefenster von Banken und
  Single-Sign-On also auch
- **„Trotzdem öffnen".** Jedes blockierte Fenster meldet sich mit seiner Adresse und einem
  Knopf. Wer ihn drückt, bekommt das Fenster, und die öffnende Seite darf bis zum nächsten
  Sperren ohne Rückfrage weitere öffnen. Bekannte Werbenetze bleiben auch dann gesperrt:
  freigestellt wird die Seite, nicht ihr Werbepartner. Die Ausnahmeliste liegt nur im
  Arbeitsspeicher und wird beim Sperren geleert
- **Navigation im Hauptframe auf ein Werbenetz wird gestoppt.** Der zweite verbreitete Trick:
  nicht das neue Fenster trägt die Werbung, sondern der aktuelle Tab wird dorthin geschickt
  und das eigentliche Ziel daneben aufgemacht
- Neuer Schalter **Popups blockieren** unter Einstellungen, Voreinstellung an, wird wie alle
  Einstellungen mitsynchronisiert. Zweiter Zähler **Popups blockiert** in der Statistik

### Geändert
- **Der Blocker deckt jetzt Werbung ab, nicht nur Analyse.** Die Liste ist von 61 auf 176
  Hosts gewachsen und in drei Gruppen geteilt, weil die Popup-Sperre sie anders gewichtet
  als der Request-Filter: Pop-under-Netze (popads, propellerads, adsterra, exoclick, adcash,
  hilltopads, …), Anzeigenauslieferung und Auktionen (amazon-adsystem, adform, 3lift,
  indexww, media.net, mgid, revcontent, …) und Analyse. Dazu acht sehr eng gefasste
  Pfadmuster für Hosts, auf denen auch echte Inhalte liegen, etwa `/pagead/`. Weiterhin
  bewusst keine EasyList-Engine: Regellisten müssten bei jedem Start nachgeladen werden, und
  genau dieser Request wäre die erste Spur, die Nula hinterlässt
- Der Schalter heißt jetzt **Werbung und Tracker blockieren**, weil er genau das tut
- Die Statistik unter Einstellungen ist ein 2×2-Raster statt drei Kacheln nebeneinander. Bei
  384 Pixel Panelbreite bleibt der Servername damit lesbar
- Meldungen unten können einen Knopf tragen und stehen dann 8 statt 3,2 Sekunden

### Tests
- 24 neue Prüfungen: die Einstufung einzelner Adressen durch den Blocker samt Gegenprobe,
  dass „advertising" im Pfad **kein** Treffer ist, und der Wächter über eine eigene Uhr —
  ohne Klick, nach einem Klick, zweites Fenster zum selben Klick, abgelaufener Klick,
  Werbenetz trotz Klick, Sperre aus, Freistellung und ihre Grenzen
- Dazu sechs Prüfungen im echten Tab, die den Weg durch `setWindowOpenHandler` und
  `input-event` gehen statt nur die Entscheidungslogik: `window.open()` ohne Eingabe wird
  gestoppt, ein per `sendInputEvent` echt zugestellter Klick lässt genau ein Fenster durch,
  das zweite bleibt zu
- Der Smoke-Test zeigt die Sperrmeldung samt Knopf als eigenen Screenshot
- 102 Prüfungen im Integrationstest, alle grün, null Konsolenfehler im Smoke-Test

## [2.11.0] - 2026-08-23

### Korrekturen
- **Die Adressleiste hat noch nie funktioniert.** Der Fehler steckt seit dem ersten Commit
  (2.0.0) drin: Beim Druck auf Enter rief der Handler erst `omni.blur()` und las **danach**
  `omni.value`. `blur()` feuert den blur-Handler aber synchron, und der setzt das Feld über
  `renderToolbar()` auf die aktuelle Tab-URL zurück — beide Schutzbedingungen dort
  (`!ui.omniDirty` und `document.activeElement !== omni`) sind in genau diesem Moment offen.
  Gesendet wurde also nicht das Getippte, sondern die Adresse der Seite, auf der man schon war.
  Auf einem neuen Tab war das der leere String, und `resolveInput('')` ergibt `nula://newtab`:
  Nula lud die leere Neue-Tab-Seite neu, der Ladebalken lief einmal durch, sichtbar passierte
  nichts. Der Wert wird jetzt vor `blur()` gelesen
- Warum das keiner der bisherigen Tests fand: sie prüften `resolveInput()` und
  `TabManager.navigate()` direkt und nie die tatsächliche Reihenfolge Tastendruck → blur →
  lesen. Der Smoke-Test tippt jetzt wirklich in die Adressleiste, drückt Enter und besteht
  darauf, dass genau das Getippte im Hauptprozess ankommt — gegengeprüft daran, dass er ohne
  den Fix auch wirklich fehlschlägt

## [2.10.0] - 2026-08-23

### Korrekturen
- **Das Panel lag hinter der Seite und war deshalb unsichtbar.** Die Tab-Ansicht ist eine native
  `WebContentsView` über dem HTML der Oberfläche, und sie belegte die gesamte Fläche unter der
  Chrome-Leiste — auch die 384 Pixel rechts, in denen Lesezeichen, Geräte, Einstellungen und API
  gezeichnet werden. Der Hauptprozess wusste vom Panel überhaupt nichts (`grep -c panel` in
  `main.js` und `tabs.js`: null). Ein Klick auf Einstellungen öffnete das Panel also korrekt,
  nur sah man es nie. Betraf jede Sitzung, in der ein Tab offen war; im Screenshot-Test fiel es
  nicht auf, weil der gar keine native Ansicht erzeugt
- Die Entwicklerwerkzeuge gehen jetzt **abgedockt** auf. Angedockt lagen sie aus demselben Grund
  hinter der Tab-Ansicht und waren damit ebenfalls nicht zu gebrauchen

## [2.9.0] - 2026-08-23

### Neu
- **Der Windows-Installer fragt, ob Nula selbst nach Updates suchen soll** (voreingestellt: ja).
  Die Antwort landet neben der EXE und wird beim Start übernommen, sofern sie neuer ist als die
  vorhandene Konfiguration — eine frische Installation gewinnt also gegen eine alte Einstellung,
  eine spätere Änderung in den Einstellungen ebenso gegen die Installer-Vorgabe
- Ein stilles Update schreibt die Vorgabe **nicht**. Sonst würde jede automatische Aktualisierung
  die zuletzt getroffene Wahl wieder überschreiben

## [2.8.0] - 2026-08-23

### Korrekturen
- **Nula sagte nie, dass ein Update bereitliegt.** Gesucht und geladen wurde seit 2.5.0
  zuverlässig, aber der Zustand stand ausschließlich in der Update-Karte unter Einstellungen.
  Wer sie nicht öffnete, erfuhr nichts — die App startete einfach und schwieg. Jetzt meldet ein
  Hinweis die gefundene Version genau einmal, und ein Abzeichen am Einstellungen-Knopf bleibt
  stehen, bis das Update installiert ist
- Die Update-Prüfung konnte still scheitern: `wire()` stand vor dem `try`, sodass ein Fehler
  beim Laden von `electron-updater` vom `.catch()` des Startaufrufs verschluckt wurde und der
  Status für immer auf „noch nicht geprüft" stehen blieb. Jetzt wird auch das als Fehler
  angezeigt

## [2.7.0] - 2026-08-23

### Neu
- **Google ist die voreingestellte Suchmaschine.** Gilt für neue Vaults und als Rückfall, wenn
  keine Einstellung greift. Ein bestehender Vault behält seine gespeicherte Wahl — dort einmal
  unter Einstellungen umstellen
- Wer sich gegen einen gemerkten Server schon einmal angemeldet hat, bekommt das
  **Setup-Code-Feld nicht mehr vorgesetzt**. Es bleibt über „Setup-Code eingeben" erreichbar und
  klappt von selbst auf, wenn der Server ihn doch verlangt. Der Vermerk hängt bewusst an
  „URL merken": ohne gemerkte Adresse ist nicht bekannt, für welchen Server er gälte

### Korrekturen
- **Fehler in der Oberfläche waren unsichtbar.** Es gab weder einen Menüeintrag für die
  Entwicklerwerkzeuge noch eine Fehleranzeige im Fenster — eine Ausnahme im Renderer sah
  deshalb schlicht so aus, als würde nichts passieren. Jetzt melden `window.onerror` und
  `unhandledrejection` sich sichtbar, und unter **Ansicht** stehen die Entwicklerwerkzeuge
  (`Strg+Umschalt+I`, für die Seite `Strg+Umschalt+J`)
- Ein Fehler in einer Render-Funktion riss bisher die restliche Kette mit. Ein einziges
  kaputtes Vault-Element legte damit dauerhaft alle folgenden Aktualisierungen lahm — für den
  Rest der Sitzung. Jeder Ereignis-Handler ist jetzt einzeln eingefasst
- `navigate()` kehrte bei unbekanntem Tab oder abgelehnter Adresse wortlos zurück. Die Eingabe
  verschwand einfach. Jetzt gibt es einen Grund, und der Nutzer sieht ihn
- Antwortet der Hauptprozess nicht, sagt die Oberfläche das nach acht Sekunden, statt still zu
  warten. Bei Dialogen, die auf eine Eingabe warten, ist die Warnung abgeschaltet
- Ein Tab ohne `deviceId` lässt die Geräteliste nicht mehr auflaufen

### Tests
- Integrationstest auf 70 Prüfungen: Google als Standard, der Setup-Code-Vermerk und seine
  Kopplung an „URL merken"

## [2.6.0] - 2026-08-23

### Neu
- **Auch macOS erkennt Updates jetzt selbst.** Bisher lief die Suche dort in denselben
  Squirrel.Mac-Fehler wie die Installation. Tatsächlich betrifft die Signaturpflicht nur das
  Anwenden — gesucht wird über die GitHub-API und damit plattformunabhängig. Nula lädt auf dem
  Mac deshalb nichts herunter, meldet aber die gefundene Version und öffnet auf Knopfdruck die
  Release-Seite
- Das README beschreibt, wie sich das Signieren für macOS nachrüsten lässt, damit sich der Mac
  danach wie Windows selbst aktualisiert — inklusive der Falle, dass ein **leeres** `CSC_LINK`
  den macOS-Build mit `not a file` abbrechen lässt und die Variablen deshalb erst gesetzt werden
  dürfen, wenn sie auch gefüllt sind

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
