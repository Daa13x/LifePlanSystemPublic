# Wear OS companion — status

This module is a **compiling, installable skeleton only**. It launches on a
watch and shows a static placeholder screen. It does **not** yet:

- talk to the phone app at all (no Wearable Data Layer API code exists yet)
- show a real Today/next-task view, reminders, Done/Later, or quick capture
- have been run on a physical watch or a Wear OS emulator

## Why it stops here for now

The phone<->desktop sync transport (Phase 4) could be built and verified end
to end from this machine: a real HTTP server, a real SQLite database, and
`node`/`curl` to drive both sides of the exchange in an automated test. None
of that is true for a watch. Phone<->watch communication on Android is the
Wearable Data Layer API (`MessageClient`/`DataClient`), which requires an
actual paired watch (physical or emulated) to see work at all — there is no
way to fake that round trip from a headless script the way
`scripts/verify-sync-exchange.mjs` does for the desktop bridge. Writing that
bridge blind, with no way to ever run it, risks shipping code nobody has
seen actually deliver a message to a watch.

This module exists so CI's `Build Android` workflow (`./gradlew
assembleDebug` runs every Gradle module by default) gives real, automated
proof the module at least compiles and packages correctly, before any
message-passing code is added on top of it.

## Planned next slice (not yet started)

1. A phone-side `WearableListenerService` (native Android, registered in
   `android/app/src/main/AndroidManifest.xml`) that reads the SAME on-device
   SQLite database `@capacitor-community/sqlite` already maintains (the
   file, not through the WebView/JS bridge — the phone app is not always
   foregrounded when a watch message arrives) to answer "what's my next
   task" and apply Done/Later actions.
2. A matching watch-side `MessageClient` call in this module, replacing the
   static placeholder text with the real answer.
3. Physical or emulator verification of that round trip — this is the part
   that genuinely cannot happen from this environment and needs the user's
   own hardware, same as Phase 4's two-device proof.
