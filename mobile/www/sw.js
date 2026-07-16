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
  const title = payload.title || "Manta UI";
  const body = payload.body || "";
  const tag = payload.tag || undefined;
  // Carry everything the click handler needs to either deep-link or post a
  // direct answer (questionId + index→label map).
  const data = {
    sessionId: payload.sessionId || null,
    kind: payload.kind || null,
    requestId: payload.requestId || null,
    answers: Array.isArray(payload.answers) ? payload.answers : null,
  };
  // Notification action buttons (shown on long-press on iOS). Cap to the
  // platform's max so extras aren't silently dropped mid-list.
  const max =
    (self.Notification && self.Notification.maxActions) || 4;
  const actions = Array.isArray(payload.actions)
    ? payload.actions.slice(0, max)
    : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag, // collapse repeated notifs for the same session/kind
      renotify: !!tag,
      icon: "./icons/icon-180.png",
      badge: "./icons/icon-180.png",
      actions,
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const sessionId = data.sessionId;
  const action = event.action; // "" for body tap, "ans:<i>" for an option

  // Direct answer: the user tapped an option action. POST the reply to the
  // box and do NOT open the app (the whole point is answering in place).
  if (action && action.indexOf("ans:") === 0 && data.requestId && data.answers) {
    const idx = parseInt(action.slice(4), 10);
    const label = data.answers[idx];
    if (typeof label === "string") {
      event.waitUntil(
        fetch(self.location.origin + "/push/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: data.requestId,
            sessionId: sessionId,
            answers: [[label]],
          }),
        }).catch(function () {
          /* best-effort; if it fails the in-app card is still answerable */
        }),
      );
      return;
    }
  }

  // Body tap (or an action we couldn't resolve): focus/open the app and
  // deep-link to the session.
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
