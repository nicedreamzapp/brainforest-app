#!/bin/bash
# Build 18: wait for upload, wait for Apple processing, attach to 1.3, resubmit
# the EXISTING rejected submission (never cancel it - that seals the message thread).
set -uo pipefail
PY=~/JaneOS/.venv/bin/python3
ASC=~/Scripts/asc_release.py
BUNDLE=com.brainforest.app
SUB_ID=1a2e968c-9d52-4d2d-9dd3-1dee840177e3
LOG=~/bf-build/resubmit18.log

echo "=== $(date "+%F %T") waiting for build 18 upload ===" >>"$LOG"
for i in $(seq 1 120); do
    if grep -q "Uploaded build 18" ~/bf-build/build18.log 2>/dev/null; then break; fi
    if grep -qiE "error|failed|REFUSING" ~/bf-build/build18.log 2>/dev/null && ! pgrep -f "build_and_upload.sh 18" >/dev/null; then
        echo "BUILD/UPLOAD FAILED - see build18.log" >>"$LOG"; exit 1
    fi
    sleep 30
done
grep -q "Uploaded build 18" ~/bf-build/build18.log || { echo "TIMED OUT waiting for upload" >>"$LOG"; exit 1; }
echo "$(date "+%T") upload done, waiting for processing" >>"$LOG"

for i in $(seq 1 90); do
    state=$("$PY" "$ASC" status "$BUNDLE" 2>/dev/null | awk -v b=18 "\$1==\"build\" && \$2==b {print \$3}")
    if [ "$state" = "VALID" ]; then
        echo "$(date "+%T") build 18 VALID" >>"$LOG"
        "$PY" "$ASC" attach "$BUNDLE" 1.3 18 >>"$LOG" 2>&1 || { echo "ATTACH FAILED" >>"$LOG"; exit 1; }
        "$PY" - >>"$LOG" 2>&1 <<PYEOF
import json, time, pathlib, urllib.request, jwt
KEY_ID="VSXKZZ79TK"; ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
P8=pathlib.Path.home()/".appstoreconnect/private_keys/AuthKey_VSXKZZ79TK.p8"
now=int(time.time())
tok=jwt.encode({"iss":ISSUER,"iat":now,"exp":now+1200,"aud":"appstoreconnect-v1"},P8.read_text(),algorithm="ES256",headers={"kid":KEY_ID,"typ":"JWT"})
sid="$SUB_ID"
body=json.dumps({"data":{"type":"reviewSubmissions","id":sid,"attributes":{"submitted":True}}}).encode()
r=urllib.request.Request(f"https://api.appstoreconnect.apple.com/v1/reviewSubmissions/{sid}",method="PATCH",data=body,headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"})
print(json.loads(urllib.request.urlopen(r).read())["data"]["attributes"])
PYEOF
        if [ $? -eq 0 ]; then echo "$(date "+%T") RESUBMITTED build 18 on submission $SUB_ID" >>"$LOG"; exit 0
        else echo "RESUBMIT PATCH FAILED" >>"$LOG"; exit 1; fi
    fi
    [ -n "$state" ] && echo "$(date "+%T") build 18 is $state" >>"$LOG"
    sleep 30
done
echo "TIMED OUT waiting for processing" >>"$LOG"; exit 1
