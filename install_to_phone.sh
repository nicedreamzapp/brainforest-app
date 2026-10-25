#!/bin/bash
# Brainforest: build a development-signed copy and install it straight onto a
# tethered iPhone. This is for HEARING a change on real hardware in minutes
# instead of waiting on an App Store review cycle.
#
# The App Store IPA in export*/ is distribution-signed and will NOT install on a
# device — that is why this builds its own development-signed .app.
#
# Usage: ./install_to_phone.sh [device-udid]
set -euo pipefail
cd "$(dirname "$0")"

DEVICE="${1:-58EEFE60-DAA7-5A19-B80E-69B7F0EB8F16}"   # "Divine Tribe" iPhone 14 Pro Max

# Same guard as the upload script: an empty voice pack is the bug that shipped
# builds 1-12 with a robot voice reading emoji names aloud. Never install one either.
VOICE_N=$(find ios/web/voice -name "*.m4a" 2>/dev/null | wc -l | tr -d ' ')
[ -f ios/web/voice/manifest.json ] && [ "$VOICE_N" -ge 5000 ] || {
    echo "REFUSING: ios/web/voice has $VOICE_N clips and/or no manifest.json."
    exit 1
}
echo "voice pack OK: $VOICE_N clips"

# A missing clip is now SILENCE (the synthesizer fallback was removed), so a
# hand-check is not good enough — this refuses to build unless every line the app
# can speak has a clip on disk.
~/JaneOS/.venv/bin/python3 ios/tools/verify_voice_coverage.py || {
    echo "REFUSING TO BUILD: voice coverage check failed (see above)."
    exit 1
}


DD="$PWD/DerivedData-device"
xcodebuild -project ios/Brainforest.xcodeproj -scheme Brainforest \
    -configuration Release -destination "id=$DEVICE" \
    -derivedDataPath "$DD" -allowProvisioningUpdates build

APP="$DD/Build/Products/Release-iphoneos/Brainforest.app"
[ -d "$APP" ] || { echo "no .app at $APP"; exit 1; }
echo "bundled voice clips: $(find "$APP/web/voice" -name "*.m4a" 2>/dev/null | wc -l | tr -d ' ')"

xcrun devicectl device install app --device "$DEVICE" "$APP"
echo "Installed. Open Brainforest on the phone."
