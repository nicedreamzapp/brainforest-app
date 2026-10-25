#!/bin/bash
# Brainforest 1.6 (22): archive with Xcode 27.1, re-stamp beta-OS, export. No upload here.
set -euo pipefail
export DEVELOPER_DIR=/Applications/Xcode-27.1.app/Contents/Developer
export PATH=/opt/homebrew/bin:$PATH
cd ~/bf-build
BUILD=22; ARCHIVE="Brainforest${BUILD}.xcarchive"; EXPORT="export${BUILD}"; PUBLIC_MACOS="25F80"
[ -e "$ARCHIVE" ] && { echo "$ARCHIVE exists"; exit 1; }
git rev-parse --abbrev-ref HEAD; git log --oneline -1
grep -q "CURRENT_PROJECT_VERSION = 22;" ios/Brainforest.xcodeproj/project.pbxproj
grep -q "MARKETING_VERSION = 1.6;" ios/Brainforest.xcodeproj/project.pbxproj
VOICE_N=$(find ios/web/voice -name "*.m4a" | wc -l | tr -d ' ')
[ -f ios/web/voice/manifest.json ] && [ "$VOICE_N" -ge 5000 ] || { echo "VOICE PACK MISSING ($VOICE_N)"; exit 1; }
echo "voice pack OK: $VOICE_N clips"
~/JaneOS/.venv/bin/python3 ios/tools/verify_voice_coverage.py
xcodebuild -version
xcodebuild -project ios/Brainforest.xcodeproj -scheme Brainforest -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$ARCHIVE" archive \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Development: matthew macosko (4CZN7SBXR2)" \
  PROVISIONING_PROFILE_SPECIFIER="BF Dev Both Phones 20260930" DEVELOPMENT_TEAM=B9RA6QH559 > build22.log 2>&1 \
  || { tail -40 build22.log; exit 1; }
echo "ARCHIVE OK"
APP_PLIST="$ARCHIVE/Products/Applications/Brainforest.app/Info.plist"
echo "BuildMachineOSBuild was: $(plutil -extract BuildMachineOSBuild raw "$APP_PLIST") -> $PUBLIC_MACOS"
plutil -replace BuildMachineOSBuild -string "$PUBLIC_MACOS" "$APP_PLIST"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist ExportOptions-brainforest.plist > export22.log 2>&1 || { tail -40 export22.log; exit 1; }
echo "EXPORT OK"; ls -la "$EXPORT"
rm -rf /tmp/bf22ipa && mkdir /tmp/bf22ipa && cd /tmp/bf22ipa && unzip -q ~/bf-build/$EXPORT/Brainforest.ipa
codesign --verify --strict --deep Payload/Brainforest.app && echo "CODESIGN VERIFY OK"
echo BUILD_DONE
