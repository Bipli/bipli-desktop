; =============================================================================
; ⚠️ WINDOWS TOASTS NEED AN INSTALLED SHORTCUT CARRYING THE AppUserModelID, and
; NSIS does not set one on the shortcut by default. Round 3 proved OS toasts do
; not work for us even packaged, so the popup is the design — but the AUMID is
; still what Windows uses to identify the app for taskbar grouping and jump
; lists, and a mismatch between this and app.setAppUserModelId() in main.js is
; the kind of thing that fails silently later.
;
; 🔴 AND WINDOWS WILL NOT OFFER AN APP IT HAS NOT BEEN TOLD ABOUT.
; app.setAsDefaultProtocolClient("tel") makes Bipli a candidate in HKCU\Software\
; Classes, but "Choose defaults by link type → TEL" lists only applications that
; have registered CAPABILITIES. Without the block below Bipli never appears
; there, and the runtime call looks like it silently did nothing — the user has
; no way to pick us even if they want to.
;
; ⚠️ SHCTX, not a hardcoded hive: this installer is perMachine:false today, so
; SHCTX resolves to HKCU. Hardcoding HKLM would fail for a per-user install and
; hardcoding HKCU would be wrong the day we go per-machine.
; =============================================================================
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\AppUserModelId\com.bipli.desktop" "DisplayName" "Bipli"

  ; The handler itself.
  WriteRegStr SHCTX "Software\Classes\Bipli.tel" "" "Phone call"
  WriteRegStr SHCTX "Software\Classes\Bipli.tel" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Bipli.tel\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Bipli.tel\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Capabilities — what makes Bipli show up in Default apps.
  WriteRegStr SHCTX "Software\Bipli\Capabilities" "ApplicationName" "Bipli"
  WriteRegStr SHCTX "Software\Bipli\Capabilities" "ApplicationDescription" "Your Bipli phone on the desktop"
  WriteRegStr SHCTX "Software\Bipli\Capabilities\URLAssociations" "tel" "Bipli.tel"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Bipli" "Software\Bipli\Capabilities"
!macroend

; Leave the machine as we found it. A stale URLAssociation pointing at an
; uninstalled binary is how "clicking a number does nothing" survives the
; uninstall that was supposed to fix it.
!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Bipli.tel"
  DeleteRegKey SHCTX "Software\Bipli\Capabilities"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Bipli"
  DeleteRegKey SHCTX "Software\Classes\AppUserModelId\com.bipli.desktop"
!macroend
