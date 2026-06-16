/* bui service worker — Web Push only.
 *
 * Deliberately minimal: NO offline/asset caching (the app needs the live
 * server, and an SW cache is exactly what caused stale-bundle pain). Its only
 * jobs are (1) show a notification for every push and (2) focus/open the app
 * — and deep-link to the right session — when one is tapped.
 *
 * This file lives in src/renderer/public/ so Vite copies it verbatim to
 * mobile/www/sw.js (served at /sw.js, scope "/"). It is plain ES5-ish JS:
 * no bundler runs over it.
 */

self.addEventListener("install", () => {
  // Activate immediately so a freshly-deployed SW takes over without needing
  // every tab to close first.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // iOS revokes the push subscription if a delivered push doesn't surface a
  // notification, so we ALWAYS show one (the server already decided this push
  // is worth surfacing).
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  const title = payload.title || "Better UI";
  const body = payload.body || "";
  const tag = payload.tag || undefined;
  const data = {
    sessionId: payload.sessionId || null,
    kind: payload.kind || null,
  };
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag, // collapse repeated notifs for the same session/kind
      renotify: !!tag,
      icon: "./icons/icon-180.png",
      badge: "./icons/icon-180.png",
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  // Deep-link target: the app reads ?notif=<sessionId> (or the postMessage
  // below) and navigates to that session.
  const url = sessionId
    ? "./?notif=" + encodeURIComponent(sessionId)
    : "./";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.focus();
            if (sessionId && "postMessage" in client) {
              client.postMessage({ type: "bui-open-session", sessionId });
            }
            return undefined;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      }),
  );
});
