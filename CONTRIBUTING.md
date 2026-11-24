# Contributing

Thanks for taking a look. Brainforest is used by young kids on a lot of different phones and
tablets, so a clear bug report is useful even if you never send code.

## Reporting a problem

Open an [issue](https://github.com/nicedreamzapp/brainforest-app/issues/new/choose). The things
that make it quick to fix:

- your device (iPhone, iPad or Android model) and OS version
- the app version, from the App Store, Google Play, or a build from this repo
- the grade level and the quest or lesson you were on
- for a wrong answer or a typo, the exact question text
- for a missing or wrong voice line, the text that should have been spoken

Please do not post anything that identifies a child.

## Running it locally

- **Engine tests** (Node only): `node ios/tests/sim_engine.mjs` and `node ios/tests/sim_torture.mjs`
- **iOS:** open `ios/Brainforest.xcodeproj` in Xcode (iOS 17+). The scheme uses
  `ios/Brainforest.storekit` for local purchase testing.
- **Android:**

```bash
cd android && ./gradlew assembleDebug
```

Android needs JDK 17 and Android SDK 36. Release builds need your own `android/keystore.properties`,
which is not committed. The iOS voice pack is not in the repo, so a fresh iOS build is silent, and
the voice and content tools expect paths on my machine.

`ios/web/` and `android/app/src/main/assets/web/` are two copies of the same web app with no sync
script, so a change to one usually needs to go into the other too.

## Tests

```bash
node ios/tests/sim_engine.mjs
node ios/tests/sim_torture.mjs
```

These run the real learning engine in Node, including long soak runs, garbage input and
corrupted-save recovery. For UI changes, also check by hand on a phone and a tablet.

## Pull requests

Small and focused is easiest to review. For big changes, open an issue first so we can talk it
through. The app must stay offline, with no accounts, analytics, ads or tracking.

Please follow the [code of conduct](CODE_OF_CONDUCT.md).
