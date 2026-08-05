/* ============================================================
   Rainbow Alerts — service worker (web push).
   IMPORTANT: this file must be served from the SITE ROOT (e.g. https://prey.tel/sw.js)
   so its scope covers the signup page and the notifications work.
   ============================================================ */

self.addEventListener("push", (event) => {
  let data = { title: "🌈 Rainbow Alerts", body: "A rainbow is likely near you — look toward the sky!" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (_) { /* keep default */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/assets/favicon.png",
      badge: "/assets/favicon.png",
      tag: "rainbow-alert",
      renotify: true,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ("focus" in w) return w.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
