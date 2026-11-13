; Capture at include time: inside a macro __FILEDIR__ is the generated NSIS dir.
!define ONEBYONE_HOOK_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "${ONEBYONE_HOOK_DIR}\..\target\release\onebyone-cli.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\onebyone-cli.exe"
!macroend
