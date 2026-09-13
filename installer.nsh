!macro customInstall
  File /oname=$PLUGINSDIR\GSRC-Safety-Car-Controller-Trust.cer "${PROJECT_DIR}\certs\GSRC-Safety-Car-Controller-Trust.cer"

  nsExec::Exec '"$SYSDIR\certutil.exe" -user -store Root CC29EA571212019725076F18358828C817C0254F'
  Pop $0

  ${If} $0 != 0
    nsExec::Exec '"$SYSDIR\certutil.exe" -user -f -addstore Root "$PLUGINSDIR\GSRC-Safety-Car-Controller-Trust.cer"'
    Pop $0

    ${If} $0 != 0
      MessageBox MB_ICONSTOP "GSRC Safety Car Controller could not install its publisher certificate. Installation cannot continue safely."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
