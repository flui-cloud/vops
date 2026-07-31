/* Service worker for the installed (PWA) dashboard.
 *
 * The point of this file is not offline browsing — the dashboard is useless
 * without the local API — but the launcher icon. Once installed, the icon lives
 * in the dock/Start menu forever, while the server only exists while `vops ui`
 * runs. Clicking it with the CLI stopped would otherwise show the browser's
 * connection-refused page, which reads like the app is broken. Instead we serve
 * a shell that explains how to start it.
 *
 * VERSION is substituted from package.json by scripts/build-ui.js, so a
 * `npm update -g @flui-cloud/vops` drops the previous cache instead of serving
 * the old shell forever.
 */
const VERSION = '__VOPS_VERSION__';
const CACHE = `vops-shell-${VERSION}`;
const SHELL = '/';

self.addEventListener('install', (event) => {
  // Take over as soon as the new CLI version is installed rather than waiting
  // for every window to close — the old shell may not match the new API.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => globalThis.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => globalThis.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API is live state and session-guarded — never cache it, and never serve
  // a stale answer. Letting it fail normally is what surfaces "server is down"
  // to the app's own error handling.
  if (url.pathname.startsWith('/api')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Brand icons and map data: immutable per version, so cache-first is safe and
  // keeps the installed app painting instantly.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/world.geo.json') {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Network-first: the served shell carries a fresh session cookie, so a cached
 * copy is only ever a fallback. Cache-first here would hand the app a stale
 * document that cannot talk to the API.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(SHELL, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(SHELL);
    return cached ?? notRunningPage();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504 });
  }
}

/**
 * Shown when the installed app is launched while the CLI is stopped. Kept as an
 * inline string so it works with an empty cache — a separate HTML file would be
 * one more thing that must have been fetched first.
 */
function notRunningPage() {
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vops — not running</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#08080a; color:#e8e8ea;
         font:15px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { max-width:30rem; padding:2rem; text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 .5rem; font-weight:600; }
  p { color:#a1a1aa; margin:0 0 1.25rem; }
  code { display:block; padding:.75rem 1rem; border-radius:.5rem;
         background:#141417; border:1px solid #26262b; color:#e8e8ea;
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13.5px; }
  button { margin-top:1.25rem; padding:.5rem 1.1rem; border-radius:.5rem;
           border:1px solid #26262b; background:#141417; color:#e8e8ea;
           font-size:13.5px; font-weight:600; cursor:pointer; }
  button:hover { border-color:#3f3f46; }
</style>
</head>
<body>
  <div class="box">
    <h1>vops isn't running</h1>
    <p>This app is served by vops on your own machine. Start it in a terminal, then reload — or install the background service so it is always there.</p>
    <code>vops ui</code>
    <code style="margin-top:.5rem">vops service install</code>
    <p style="margin:1rem 0 0;font-size:12.5px">Removed vops on purpose? This icon is the last piece — uninstall it from your browser's app list.</p>
    <button onclick="location.reload()">Reload</button>
  </div>
  <script>setInterval(function(){fetch('/',{method:'HEAD',cache:'no-store'}).then(function(r){if(r.ok)location.reload()}).catch(function(){})},2000);</script>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
