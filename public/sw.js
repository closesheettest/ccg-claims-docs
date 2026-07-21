// Minimal service worker — its only job is to make the app INSTALLABLE (browsers
// require a registered SW with a fetch handler). It deliberately does NOT cache:
// this app deploys many times a day, so a network passthrough guarantees reps
// always get the freshest version and never a stale white screen.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* passthrough: browser does the default fetch, always live */ });
