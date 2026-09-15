// Persistencia de la sucursal activa en el panel de citas — cierra el hallazgo de
// auditoría (rubro 19, multi-organización, severidad MEDIA, "negocio de citas con
// 2+ sucursales solo opera la primera"): CitasShell.tsx fijaba `propertyId` a
// `branches[0]!.propertyId` sin selector ni persistencia, así que un negocio con más
// de una sucursal jamás podía operar la segunda en adelante desde el panel.
//
// MISMO patrón EXACTO que ya resolvió este problema en hoteles/despachos/rentas/
// restaurantes (ver apps/web/src/verticals/hoteles/lib/property-selection.ts, usado
// aquí literalmente como referencia) — namespaced por organización, misma razón: dos
// organizaciones de citas abiertas en el mismo navegador (u otra vertical, otra
// pestaña) no deben pisarse la selección. La resolución de "qué sucursal queda
// activa dado lo persistido" vive en `resolveActivePropertyId` (./admin-client.ts) —
// este archivo NO la duplica, solo agrega el read/write de storage.
//
// Separado de CitasShell.tsx a propósito, mismo motivo que admin-client.ts/
// auth-client.ts de este mismo directorio: probarlo con vitest en entorno "node"
// (sin DOM) mientras el componente solo conecta esta lógica a estado/render real.
import type { SessionStorageLike } from "./auth-client.ts";

const KEY_PREFIX = "atiende.citas.selectedProperty.";

function keyFor(orgSlug: string): string {
  return `${KEY_PREFIX}${orgSlug}`;
}

/** Lee la sucursal activa persistida para esta organización. `null` si nunca se
 * guardó una para este `orgSlug`, o si el storage no está disponible / falla al leer
 * (Safari en modo privado puede bloquear `localStorage` por completo). Nunca lanza —
 * un fallo de lectura de storage no debe tumbar el panel, solo se pierde la
 * persistencia entre refrescos/navegaciones (ver `persistPropertyId` abajo). */
export function readPersistedPropertyId(storage: SessionStorageLike, orgSlug: string): string | null {
  try {
    return storage.getItem(keyFor(orgSlug));
  } catch {
    return null;
  }
}

/** Persiste la sucursal activa para esta organización. Best-effort a propósito: si
 * el storage falla al escribir (cuota excedida, modo privado, bloqueado por política
 * del navegador/organización), la selección sigue viva en el `useState` de
 * CitasShell.tsx durante la sesión actual del tab — solo no sobrevive a navegar a
 * otra ruta ni a un refresh de página. Nunca lanza, para que un fallo de storage
 * nunca tumbe el selector. */
export function persistPropertyId(storage: SessionStorageLike, orgSlug: string, propertyId: string): void {
  try {
    storage.setItem(keyFor(orgSlug), propertyId);
  } catch {
    // best-effort — ver comentario de cabecera de la función.
  }
}
