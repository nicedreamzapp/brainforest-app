#!/bin/bash
# Brainforest: archive -> fix beta-OS stamp -> export -> upload.
#
# THIS MAC RUNS BETA macOS. Apple stamps BuildMachineOSBuild into every
# binary and auto-rejects beta-OS stamps with ITMS-90111 ("Unsupported SDK
# or Xcode version") at submission time — even with release Xcode. Builds
# 6, 7, and 9 all died this way in July 2026. NEVER upload an archive from
# this machine without the re-stamp step below.
#
# Usage: ./build_and_upload.sh <build-number>
set -euo pipefail

PUBLIC_MACOS="25F80"          # latest PUBLIC macOS build — update when macOS updates
API_KEY="VSXKZZ79TK"
ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
cd "$(dirname "$0")"

BUILD="${1:?usage: ./build_and_upload.sh <build-number>}"
ARCHIVE="Brainforest${BUILD}.xcarchive"
EXPORT="export${BUILD}"

# Refuse to overwrite an archive that was already uploaded
[ -e "$ARCHIVE" ] && { echo "$ARCHIVE already exists — pick a new build number"; exit 1; }

# The recorded narration pack is gitignored as "regenerable" — and in this clone it
# was never regenerated, so builds 1-12 ALL shipped with an empty web/voice/. With no
# clips the app falls back to the bare iOS system voice, which reads emoji aloud by
# name ("drum, drumroll yes"). Family caught it 2026-08-07. Never ship voiceless again.
VOICE_DIR="ios/web/voice"
VOICE_N=$(find "$VOICE_DIR" -name "*.m4a" 2>/dev/null | wc -l | tr -d ' ')
[ -f "$VOICE_DIR/manifest.json" ] && [ "$VOICE_N" -ge 5000 ] || {
    echo "REFUSING TO BUILD: $VOICE_DIR has $VOICE_N clips and/or no manifest.json."
    echo "Regenerate first:  ~/JaneOS/.venv/bin/python3 ios/tools/build_voice_pack_kokoro.py"
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


sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${BUILD};/g" \
    ios/Brainforest.xcodeproj/project.pbxproj

xcodebuild -project ios/Brainforest.xcodeproj -scheme Brainforest -configuration Release \
    -destination "generic/platform=iOS" -archivePath "$ARCHIVE" archive -allowProvisioningUpdates

APP_PLIST="$ARCHIVE/Products/Applications/Brainforest.app/Info.plist"
STAMP="$(plutil -extract BuildMachineOSBuild raw "$APP_PLIST")"
echo "BuildMachineOSBuild: $STAMP -> $PUBLIC_MACOS"
plutil -replace BuildMachineOSBuild -string "$PUBLIC_MACOS" "$APP_PLIST"

# exportArchive re-signs the app, so the plist edit stays valid
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
    -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates

xcrun altool --upload-app -f "$EXPORT/Brainforest.ipa" -t ios \
    --apiKey "$API_KEY" --apiIssuer "$ISSUER"

echo "Uploaded build $BUILD. Remember: export compliance (usesNonExemptEncryption=false),"
echo "attach to version, resubmit — see ~/Scripts/appstore-watch/fix10.py for the pattern."
