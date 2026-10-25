#!/bin/bash
# Upload Brainforest 1.6 (23) with Apple's Transporter (never altool). Key file lives in ~/.appstoreconnect/private_keys.
/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter -m upload \
  -assetFile ~/bf-build/export23/Brainforest.ipa \
  -apiKey VSXKZZ79TK -apiIssuer 1ab8acba-26d0-4a22-b2e4-96398ed7ade5 -v informational
echo "TRANSPORTER_EXIT=$?"
