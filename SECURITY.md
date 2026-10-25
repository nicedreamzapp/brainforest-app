# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub: go to the **Security** tab of this repo and click **Report a vulnerability** ([direct link](https://github.com/nicedreamzapp/brainforest-app/security/advisories/new)). Only the maintainer sees the report.

Helpful details: what you found, how to reproduce it, which app version or commit, and your device and OS version.

I aim to reply within 3 days and to ship a fix or a clear plan within 30 days, depending on severity. You will be credited in the advisory unless you ask not to be.

## Supported versions

Fixes go into the latest App Store and Google Play builds, and the latest code on `main`. Please update the app before reporting if you are on an older version.

## What matters most here

This is an app for children, so the parts where a mistake could hurt someone:

- the one-time unlock purchase: StoreKit 2 in `ios/Brainforest/BrainforestApp.swift` and Google Play Billing in `android/app/src/main/java/com/brainforest/app/MainActivity.kt`
- the parental gate in front of the purchase, in `ios/web/app.js` (and its Android copy)
- the JavaScript bridges between the web app and the native shells in those same two native files
- the promise that the app collects nothing and makes no network connections (see `PRIVACY.md`)
- `ios/tools/asc_upload_screenshots.py`, which reads an App Store Connect API key
