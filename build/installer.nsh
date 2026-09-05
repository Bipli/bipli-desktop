; =============================================================================
; ⚠️ WINDOWS TOASTS NEED AN INSTALLED SHORTCUT CARRYING THE AppUserModelID, and
; NSIS does not set one on the shortcut by default. Round 3 proved OS toasts do
; not work for us even packaged, so the popup is the design — but the AUMID is
; still what Windows uses to identify the app for taskbar grouping and jump
; lists, and a mismatch between this and app.setAppUserModelId() in main.js is
; the kind of thing that fails silently later.
; =============================================================================
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\AppUserModelId\com.bipli.desktop" "DisplayName" "Bipli"
!macroend
