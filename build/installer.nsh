; Zusaetzliche Seite im Installer: soll Nula selbst nach Updates suchen?
;
; Die Antwort wird als Datei neben die EXE gelegt. Die App wendet sie beim Start
; an, sofern sie neuer ist als die vorhandene Konfiguration - so gewinnt eine
; frische Installation, eine spaetere Aenderung in den Einstellungen aber ebenso.
;
; Bei einer stillen Installation (genau das macht das Selbst-Update) wird weder
; die Seite gezeigt noch die Datei geschrieben. Sonst wuerde jedes Update die
; zuletzt getroffene Wahl wieder ueberschreiben.
;
; Alles Seitenbezogene steht hinter !ifndef BUILD_UNINSTALLER: electron-builder
; kompiliert dasselbe Skript ein zweites Mal fuer den Uninstaller und haengt die
; Seite dort nicht ein. Unreferenzierte Funktionen und Variablen erzeugen dann
; Warnungen, und makensis laeuft mit -WX - aus jeder Warnung wird ein Fehler.

!include nsDialogs.nsh
!include LogicLib.nsh

!macro customPageAfterChangeDir
  Page custom nulaUpdatePageCreate nulaUpdatePageLeave
!macroend

!ifndef BUILD_UNINSTALLER

Var NulaUpdateCheckbox
Var NulaUpdateWanted

Function nulaUpdatePageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; MUI2 ist an dieser Stelle noch nicht geladen, MUI_HEADER_TEXT gibt es also
  ; nicht. Die Ueberschrift steht deshalb als eigenes Label auf der Seite.
  ${NSD_CreateLabel} 0 0 100% 12u "Soll Nula selbst nach neuen Versionen suchen?"
  Pop $0

  ${NSD_CreateLabel} 0 16u 100% 50u "Nula kann beim Start und danach alle sechs Stunden nachsehen, ob eine neuere Version vorliegt, und sie im Hintergrund laden. Installiert wird nie ohne deine Bestaetigung.$\r$\n$\r$\nJede Abfrage geht an GitHub und verraet dabei die IP dieser Installation. Du kannst das jederzeit in den Einstellungen aendern."
  Pop $0

  ${NSD_CreateCheckbox} 0 72u 100% 12u "Automatisch nach Updates suchen (empfohlen)"
  Pop $NulaUpdateCheckbox
  ${NSD_Check} $NulaUpdateCheckbox

  nsDialogs::Show
FunctionEnd

Function nulaUpdatePageLeave
  ${NSD_GetState} $NulaUpdateCheckbox $NulaUpdateWanted
FunctionEnd

!endif

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      FileOpen $0 "$INSTDIR\auto-update.default" w
      ${If} $NulaUpdateWanted == 1
        FileWrite $0 "1"
      ${Else}
        FileWrite $0 "0"
      ${EndIf}
      FileClose $0
    ${EndIf}
  !endif
!macroend
