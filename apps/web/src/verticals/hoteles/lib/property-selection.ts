// Persistencia de la property activa en el panel de hoteles — cierra el hallazgo de
// auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el primero"):
// HotelesShell.tsx (~línea 191-194) fijaba `propertyId` a `properties[0]` sin
// selector ni persistencia, así que una cadena con más de un hotel jamás podía
// operar el segundo hotel en adelante desde el panel.
//
// MISMO patrón EXACTO que ya resolvió este problema en despachos/rentas en una
// ronda previa (ver apps/web/src/verticals/despachos/lib/property-selection.ts,
// usado aquí literalmente como referencia) — namespaced por organización, misma
// razón: dos organizaciones de hoteles abiertas en el mismo navegador (u otra
// vertical, otra pestaña) no deben pisarse la selección. La resolución de "qué
// property queda activa dado lo persistido" vive en `resolveActivePropertyId`
// (./discovery-client.ts) — este archivo NO la duplica, solo agrega el read/write
// de storage.
//
// Separado de HotelesShell.tsx a propósito, mismo motivo que discovery-client.ts:
// probarlo con vitest en entorno "node" (sin DOM) mientras el componente solo
// conecta esta lógica a estado/render real.
import type { SessionStorageLike } from "./auth-client.ts";

const KEY_PREFIX = "atiende.hoteles.selectedProperty.";

function keyFor(orgSlug: string): string {
  return `${KEY_PREFIX}${orgSlug}`;
}

/** Lee la property activa persistida para esta organización. `null` si nunca se
 * guardó una para este `orgSlug`, o si el storage no está disponible / falla al
 * leer (Safari en modo privado puede bloquear `localStorage` por completo). Nunca
 * lanza — un fallo de lectura de storage no debe tumbar el panel, solo se pierde la
 * persistencia entre refrescos/navegaciones (ver `persistPropertyId` abajo). */
export function readPersistedPropertyId(storage: SessionStorageLike, orgSlug: string): string | null {
  try {
    return storage.getItem(keyFor(orgSlug));
  } catch {
    return null;
  }
}

/** Persiste la property activa para esta organización. Best-effort a propósito: si
 * el storage falla al escribir (cuota excedida, modo privado, bloqueado por
 * política del navegador/organización), la selección sigue viva en el `useState`
 * de HotelesShell.tsx durante la sesión actual del tab — solo no sobrevive a
 * navegar a otra ruta ni a un refresh de página. Nunca lanza, para que un fallo de
 * storage nunca tumbe el selector. */
export function persistPropertyId(storage: SessionStorageLike, orgSlug: string, propertyId: string): void {
  try {
    storage.setItem(keyFor(orgSlug), propertyId);
  } catch {
    // best-effort — ver comentario de cabecera de la función.
  }
}
