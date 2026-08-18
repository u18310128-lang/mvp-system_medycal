/* =====================================================================
   Service worker — Consultorio Perú Ruso

   Regla que ordena todo lo demás: la interfaz puede servirse de la caché,
   los datos clínicos nunca. Una agenda de ayer mostrada como si fuera la
   de hoy es peor que una pantalla que avisa que no hay conexión: la
   primera hace que alguien atienda al paciente equivocado.
   ===================================================================== */

const VERSION = "v1";
const CACHE = `peruruso-${VERSION}`;

/** Lo mínimo para que la aplicación dibuje algo sin red. */
const ARMAZON = [
  "/login.html",
  "/offline.html",
  "/styles.css",
  "/app.js",
  "/icono.svg",
  "/icono-192.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches
      .open(CACHE)
      // addAll aborta entero si un recurso falla; acá se toleran las bajas
      // para que una ruta renombrada no deje la aplicación sin worker.
      .then((cache) => Promise.allSettled(ARMAZON.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nombres) =>
        Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (evento) => {
  if (evento.data === "activar-ya") self.skipWaiting();
});

self.addEventListener("fetch", (evento) => {
  const pedido = evento.request;
  if (pedido.method !== "GET") return;

  const url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;

  // Los datos y la sesión salen siempre de la red. Sin excepción.
  if (url.pathname.startsWith("/api/")) return;

  // Navegación: se intenta la red y se cae a lo último que se haya visto.
  if (pedido.mode === "navigate") {
    evento.respondWith(
      fetch(pedido)
        .then((respuesta) => {
          guardar(pedido, respuesta.clone());
          return respuesta;
        })
        .catch(async () => (await caches.match(pedido)) ?? caches.match("/offline.html"))
    );
    return;
  }

  // Estáticos: se responde de la caché y se refresca de fondo.
  evento.respondWith(
    caches.match(pedido).then((enCache) => {
      const desdeRed = fetch(pedido)
        .then((respuesta) => {
          guardar(pedido, respuesta.clone());
          return respuesta;
        })
        .catch(() => enCache);
      return enCache ?? desdeRed;
    })
  );
});

/**
 * Guarda solo respuestas completas y propias.
 *
 * Se descartan las redirigidas por dos motivos: `cache.put` las rechaza, y
 * guardar bajo «/» lo que en realidad es la pantalla de acceso haría que,
 * ya con sesión abierta, la aplicación siguiera mostrando el login.
 */
function guardar(pedido, respuesta) {
  if (!respuesta.ok || respuesta.type !== "basic" || respuesta.redirected) return;
  caches
    .open(CACHE)
    .then((cache) => cache.put(pedido, respuesta))
    .catch(() => undefined);
}
