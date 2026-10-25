#!/bin/bash
# Prove what is inside the build 23 archive AND the exported ipa (the thing uploaded).
cd ~/bf-build
for APP in Brainforest23.xcarchive/Products/Applications/Brainforest.app /tmp/bf23ipa/Payload/Brainforest.app; do
  echo "=== $APP"
  P="$APP/Info.plist"
  for k in CFBundleShortVersionString CFBundleVersion BuildMachineOSBuild DTXcode DTXcodeBuild DTSDKName DTPlatformVersion MinimumOSVersion; do
    echo "  $k = $(plutil -extract $k raw "$P" 2>&1)"; done
  echo "  UIRequiresFullScreen: $(plutil -extract UIRequiresFullScreen raw "$P" 2>&1)"
  echo "  iPhone orientations: $(plutil -extract UISupportedInterfaceOrientations json -o - "$P")"
  echo "  iPad orientations:   $(plutil -extract UISupportedInterfaceOrientations~ipad json -o - "$P")"
  echo "  voice clips: $(find "$APP/web/voice" -name '*.m4a' | wc -l | tr -d ' ')  manifest: $(ls "$APP/web/voice/manifest.json" 2>&1)"
  echo "  css RESIZABLE WINDOWS: $(grep -c 'RESIZABLE WINDOWS' "$APP/web/style.css")  wide-grid rule: $(grep -c 'min-aspect-ratio: 1/1) and (min-width: 640px)' "$APP/web/style.css")  short-window rule: $(grep -c 'Short, wide windows' "$APP/web/style.css")"
  echo "  code link gated on iOS: CODES_ON=$(grep -c "const CODES_ON = !iapNative" "$APP/web/app.js") hidden-links=$(grep -c "CODES_ON ? \"\" : \" hidden\"" "$APP/web/app.js") ungated-links=$(grep -c "<button class=\"ug-link\" id=\"ug-code-open" "$APP/web/app.js") refusals=$(grep -c "if (!CODES_ON) return;" "$APP/web/app.js")"
  echo "  app.js watchSize: $(grep -c 'watchSize' "$APP/web/app.js")"
  echo "  web files match source: $(diff -rq --exclude=voice ios/web "$APP/web" >/dev/null && echo identical || diff -rq --exclude=voice ios/web "$APP/web" | head -5)"
  echo "  debug hooks (BF_FRAME) in binary: $(strings "$APP/Brainforest" | grep -c BF_FRAME)"
done
codesign -dvv /tmp/bf23ipa/Payload/Brainforest.app 2>&1 | grep -E "Authority=Apple Distribution|TeamIdentifier"
security cms -D -i /tmp/bf23ipa/Payload/Brainforest.app/embedded.mobileprovision | plutil -extract Name raw -
