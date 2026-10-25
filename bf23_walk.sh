#!/bin/bash
# Clean-install walk of Brainforest 1.6 (23) source on a FRESH iPad simulator, headless, mini muted.
# step: simbuild | setup | shot <name> | tap <x> <y> | click "<label>" | type "<text>" | src [n] | teardown
export DEVELOPER_DIR=/Applications/Xcode-27.1.app/Contents/Developer
W=~/bf-build/walk23; mkdir -p $W; BID=com.brainforest.app; P=8861
APP=~/bf-build/simdd23/Build/Products/Release-iphonesimulator/Brainforest.app
U=$(cat $W/udid 2>/dev/null); sid(){ cat $W/sid; }
case $1 in
simbuild)
  cd ~/bf-build && xcodebuild -project ios/Brainforest.xcodeproj -scheme Brainforest -configuration Release -sdk iphonesimulator \
   -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/bf-build/simdd23 CODE_SIGNING_ALLOWED=NO build > $W/simbuild.log 2>&1 && echo SIM_OK || { tail -20 $W/simbuild.log; echo SIM_FAIL; } ;;
setup)
  osascript -e 'output muted of (get volume settings)' > $W/was_muted; osascript -e 'set volume output muted true'
  echo "muted now: $(osascript -e 'output muted of (get volume settings)') (was $(cat $W/was_muted))"
  U=$(xcrun simctl create "BF23 walk clean iPad" com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3 com.apple.CoreSimulator.SimRuntime.iOS-26-5); echo $U > $W/udid
  xcrun simctl boot $U; xcrun simctl bootstatus $U -b >/dev/null; xcrun simctl install $U $APP
  plutil -extract CFBundleShortVersionString raw "$APP/Info.plist"; plutil -extract CFBundleVersion raw "$APP/Info.plist"
  (xcrun simctl spawn $U log stream --style compact --predicate 'process == "Brainforest"' > $W/app.log 2>&1 &)
  (TEST_RUNNER_USE_PORT=$P TEST_RUNNER_MJPEG_SERVER_PORT=$((P+1)) nohup xcodebuild test-without-building -xctestrun "$(ls ~/hs-build/wda-sim/Build/Products/*.xctestrun)" -destination "id=$U" > $W/wda.log 2>&1 &)
  for i in $(seq 1 60); do curl -s -m 2 localhost:$P/status | grep -q ready && break; sleep 2; done
  curl -s -X POST localhost:$P/session -H 'Content-Type: application/json' -d '{"capabilities":{"alwaysMatch":{"bundleId":"'$BID'","shouldWaitForQuiescence":false}}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])' > $W/sid
  sleep 8; echo "session $(sid)" ;;
shot) curl -s -m 60 localhost:$P/screenshot | python3 -c 'import sys,json,base64;open(sys.argv[1],"wb").write(base64.b64decode(json.load(sys.stdin)["value"]))' "$W/$2.png"; sips -Z 900 "$W/$2.png" --out "$W/$2-s.png" >/dev/null; echo "$W/$2-s.png" ;;
tap) curl -s -X POST localhost:$P/session/$(sid)/wda/tap -H 'Content-Type: application/json' -d "{\"x\":$2,\"y\":$3}" >/dev/null; echo tapped $2 $3 ;;
click) E=$(curl -s -m 60 -X POST localhost:$P/session/$(sid)/element -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"using":"predicate string","value":"label CONTAINS[c] %s" % json.dumps(sys.argv[1])}))' "$2")" | python3 -c 'import sys,json;v=json.load(sys.stdin)["value"];print(v.get("ELEMENT") or v.get("element-6066-11e4-a52e-4f735466cecc") or "")')
  [ -z "$E" ] && { echo "NOT FOUND: $2"; exit 1; }; curl -s -X POST localhost:$P/session/$(sid)/element/$E/click >/dev/null; echo "clicked $2" ;;
type) curl -s -X POST localhost:$P/session/$(sid)/wda/keys -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"value":list(sys.argv[1])}))' "$2")" >/dev/null; echo typed ;;
src) curl -s -m 60 "localhost:$P/session/$(sid)/source?format=description" | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])' | grep -E "label|value" | grep -v "Other, {{0" | head -${2:-80} ;;
muted) osascript -e 'output muted of (get volume settings)' ;;
teardown)
  pkill -f "test-without-building.*$U"; pkill -f 'log stream.*process == "Brainforest"'
  xcrun simctl shutdown $U; xcrun simctl delete $U
  [ "$(cat $W/was_muted)" = "false" ] && osascript -e 'set volume output muted false'; echo "torn down, mute restored to $(cat $W/was_muted)" ;;
esac
