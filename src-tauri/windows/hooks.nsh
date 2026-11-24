; Liga os hooks da Claude Island no ~/.claude/settings.json ao instalar
; e desliga ao desinstalar. Precisa do Node no PATH (os hooks também precisam).

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Ligando os hooks do Claude Code..."
  nsExec::ExecToLog 'node "$INSTDIR\install-hooks.js"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Não foi possível ligar os hooks (Node instalado?). Rode: node $\"$INSTDIR\install-hooks.js$\""
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; numa atualização o instalador novo religa os hooks logo depois
  DetailPrint "Desligando os hooks do Claude Code..."
  nsExec::ExecToLog 'node "$INSTDIR\install-hooks.js" --uninstall'
  Pop $0
!macroend
