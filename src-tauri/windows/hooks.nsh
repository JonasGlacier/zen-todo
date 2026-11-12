; Capture at include time: inside a macro __FILEDIR__ is the generated NSIS dir.
!define ZEN_HOOK_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "${ZEN_HOOK_DIR}\..\target\release\zen-todo-cli.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\zen-todo-cli.exe"
!macroend
