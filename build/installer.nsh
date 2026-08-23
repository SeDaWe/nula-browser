; Zusaetzliche Seite im Installer: soll Nula selbst nach Updates suchen?
;
; Die Antwort wird als Datei neben die EXE gelegt. Die App wendet sie beim Start
; an, sofern sie neuer ist als die vorhandene Konfiguration - so gewinnt eine
; frische Installation, eine spaetere Aenderung in den Einstellungen aber ebenso.
;
; Bei einer stillen Installation (genau das macht das Selbst-Update) wird weder
; die Seite gezeigt noch die Datei geschrieben. Sonst wuerde jedes Update die
; zuletzt getroffene Wahl wieder ueberschreiben.

!include nsDialogs.nsh
!include LogicLib.nsh

Var NulaUpdateCheckbox
Var NulaUpdateWanted

!macro customPageAfterChangeDir
  Page custom nulaUpdatePageCreate nulaUpdatePageLeave
!macroend

Function nulaUpdatePageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Updates" "Soll Nula selbst nach neuen Versionen suchen?"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 50u "Nula kann beim Start und danach alle sechs Stunden nachsehen, ob eine neuere Version vorliegt, und sie im Hintergrund laden. Installiert wird nie ohne deine Bestaetigung.$\r$\n$\r$\nJede Abfrage geht an GitHub und verraet dabei die IP dieser Installation. Du kannst das jederzeit in den Einstellungen aendern."
  Pop $0

  ${NSD_CreateCheckbox} 0 58u 100% 12u "Automatisch nach Updates suchen (empfohlen)"
  Pop $NulaUpdateCheckbox
  ${NSD_Check} $NulaUpdateCheckbox

  nsDialogs::Show
FunctionEnd

Function nulaUpdatePageLeave
  ${NSD_GetState} $NulaUpdateCheckbox $NulaUpdateWanted
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
    FileOpen $0 "$INSTDIR\auto-update.default" w
    ${If} $NulaUpdateWanted == 1
      FileWrite $0 "1"
    ${Else}
      FileWrite $0 "0"
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend
