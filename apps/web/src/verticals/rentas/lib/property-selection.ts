// Selección de property activa en el panel de rentas (Fase 18) — cierra el hallazgo
// de auditoría "en rentas, una empresa gestora con varias propiedades solo puede
// operar la primera": a diferencia de hoteles (donde `properties[0]` se justifica
// porque la mayoría de las organizaciones de esa vertical operan un solo hotel), en
// rentas el caso multi-propiedad es EL CASO BASE del vertical — una gestora que
// administra propiedades de más de un anfitrión — así que RentasShell.tsx ya no
// puede fijar `propertyId = properties[0]` de forma permanente (ver su comentario de
// cabecera para el selector real).
//
// Separado de RentasShell.tsx a propósito, mismo motivo que discovery-client.ts/
// auth-client.ts de este mismo directorio: probarlo con vitest en entorno "node"
// (sin DOM, sin testing-library — este repo no la tiene instalada) mientras el
// componente solo conecta esta lógica a estado/render real.
//
// Por qué persiste en storage y no solo en el `useState` de RentasShell: cada ruta
// de `apps/web/src/App.tsx` (`/rentas/:orgSlug/calendario`, `/rentas/:orgSlug/
// finanzas`, etc.) monta una instancia NUEVA de `<RentasShell>` — no hay un layout
// persistente entre rutas de React Router aquí. Sin persistir la selección fuera del
// componente, cambiar de página (Calendario -> Finanzas) resetearía silenciosamente
// la property activa a la primera de la lista, exactamente el bug que este hallazgo
// pide cerrar.
import type { SessionStorageLike } from "../../../lib/auth-client.ts";

const KEY_PREFIX = "atiende.rentas.selectedProperty.";

function keyFor(orgSlug: string): string {
  return `${KEY_PREFIX}${orgSlug}`;
}

/** Lee la property activa persistida para esta organización. `null` si nunca se
 * guardó una para este `orgSlug`, o si el storage no está disponible / falla al
 * leer (Safari en modo privado puede bloquear `localStorage` por completo). Nunca
 * lanza — un fallo de lectura de storage no debe tumbar el panel, solo se pierde la
 * persistencia entre refrescos (ver `persistPropertyId` abajo). */
export function readPersistedPropertyId(storage: SessionStorageLike, orgSlug: string): string | null {
  try {
    return storage.getItem(keyFor(orgSlug));
  } catch {
    return null;
  }
}

/** Persiste la property activa para esta organización. Best-effort a propósito: si
 * el storage falla al escribir (cuota excedida, modo privado, bloqueado por política
 * del navegador/organización), la selección sigue viva en el `useState` de
 * RentasShell.tsx durante la sesión actual del tab — solo no sobrevive un refresh de
 * página. Nunca lanza, para que un fallo de storage nunca tumbe el selector. */
export function persistPropertyId(storage: SessionStorageLike, orgSlug: string, propertyId: string): void {
  try {
    storage.setItem(keyFor(orgSlug), propertyId);
  } catch {
    // best-effort — ver comentario de cabecera de la función.
  }
}

/** Resuelve qué property debe quedar activa cuando `RentasShell.tsx` termina de
 * cargar `properties`: la persistida SI sigue siendo una property real de la
 * organización (una property pudo desaparecer entre sesiones — reasignación de
 * staff, property dada de baja), si no la primera de la lista (mismo fallback que
 * ya usaba RentasShell.tsx antes de este selector, ahora solo como default inicial
 * en vez de fijo para siempre). Asume `properties` no vacío — RentasShell.tsx ya
 * gatea el caso de 0 properties antes de necesitar esto. */
export function resolveActivePropertyId(properties: readonly { readonly propertyId: string }[], persisted: string | null): string {
  if (persisted !== null && properties.some((p) => p.propertyId === persisted)) return persisted;
  return properties[0]!.propertyId;
}
