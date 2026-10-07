// Cabeceras de seguridad de la API (`apps/api`, servida por la función
// serverless de Vercel). Complementa `vercel.json::headers`, que cubre la SPA
// estática (ver `docs/SEGURIDAD-CABECERAS.md` para el detalle y para cómo
// promover la CSP de la SPA de Report-Only a enforcing).
//
// Esta API responde JSON/redirecciones/texto plano, así que aquí la CSP SÍ es
// enforcing y restrictiva: `default-src 'none'` no puede romper nada que una
// respuesta JSON necesite. La ÚNICA excepción son las páginas de entrada del
// storefront (`/pedir/:org[/:sucursal]`, ver restaurantes/storefront-meta.ts):
// devuelven el index.html de la SPA con meta en servidor y deben cargar su
// script y sus estilos, así que fijan la CSP de la SPA (Report-Only, la misma de
// `vercel.json`) y el middleware NO les añade la restrictiva (toda respuesta
// text/html queda fuera de esa CSP). La CSP de la SPA vive aparte y es Report-Only.
//
// Política "no pisar": si una ruta ya fijó una de estas cabeceras a propósito,
// se respeta (se asigna solo si falta). Se aplica también a respuestas de
// error (401/404/500) porque el middleware corre alrededor de `next()`.
import type { MiddlewareHandler } from "hono";

/** Valores únicos, exportados para que los tests y la documentación no dupliquen literales. */
export const CABECERAS_SEGURIDAD_API: Readonly<Record<string, string>> = {
  // 1 año, subdominios incluidos. Sin `preload` a propósito: entrar a la lista
  // de preload del navegador es prácticamente irreversible y es una decisión
  // de dominio (no de este repo).
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // La API no necesita enviar Referer a nadie (las redirecciones OAuth a
  // Google/Stripe no dependen de él).
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/** CSP de la SPA (Report-Only). Debe coincidir con `vercel.json`; un test lo comprueba. */
export const CSP_SPA_REPORT_ONLY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

/** Permissions-Policy de las paginas del storefront: igual que la de la API pero deja usar la ubicacion a la propia pagina ("Usar mi ubicacion"). */
export const PERMISSIONS_POLICY_STOREFRONT = "camera=(), microphone=(), geolocation=(self), payment=(), usb=()";

export function cabecerasSeguridadApi(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const esHtml = (c.res.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html");
    for (const [nombre, valor] of Object.entries(CABECERAS_SEGURIDAD_API)) {
      if (nombre === "Content-Security-Policy" && esHtml) continue;
      if (!c.res.headers.has(nombre)) c.header(nombre, valor);
    }
  };
}
