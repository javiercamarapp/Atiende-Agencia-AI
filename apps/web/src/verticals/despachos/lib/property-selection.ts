// Persistencia del contribuyente activo en el panel de despachos (Fase 19) — cierra
// el hallazgo de auditoría "el selector real de contribuyente (Fase 10,
// DespachosShell.tsx) vive en un useState que se resetea cada vez que se navega,
// porque App.tsx monta una instancia NUEVA de DespachosShell por cada ruta (14
// wrappers Despachos*Route, cada uno con su propio <DespachosShell>)": un contador
// que elige el contribuyente B en CFDI y navega a Declaraciones vuelve a ver los
// datos del contribuyente A (el primero) sin ningún aviso, porque el `useState` de
// `selectedPropertyId` no sobrevive a desmontar/montar un <DespachosShell> nuevo.
//
// Mismo patrón EXACTO que ya resolvió esto en rentas en la misma ronda (ver
// apps/web/src/verticals/rentas/lib/property-selection.ts, usado aquí literalmente
// como referencia) — namespaced por organización, misma razón: dos organizaciones
// de despachos abiertas en el mismo navegador (u otra vertical, otra pestaña) no
// deben pisarse la selección.
//
// Separado de DespachosShell.tsx a propósito, mismo motivo que
// admin-client.ts/auth-client.ts de este mismo directorio: probarlo con vitest en
// entorno "node" (sin DOM, sin testing-library — este repo no la tiene instalada)
// mientras el componente solo conecta esta lógica a estado/render real.
//
// Nota: la resolución de "qué contribuyente queda activo dado lo persistido" ya
// vive en `resolveActivePropertyId` (./admin-client.ts, agregada en la Fase 10 junto
// con el selector) — este archivo NO la duplica, solo agrega el read/write de
// storage que le faltaba a esa fase para sobrevivir a la navegación entre rutas.
import type { SessionStorageLike } from "./auth-client.ts";

const KEY_PREFIX = "atiende.despachos.selectedProperty.";

function keyFor(orgSlug: string): string {
  return `${KEY_PREFIX}${orgSlug}`;
}

/** Lee el contribuyente activo persistido para esta organización. `null` si nunca
 * se guardó uno para este `orgSlug`, o si el storage no está disponible / falla al
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

/** Persiste el contribuyente activo para esta organización. Best-effort a
 * propósito: si el storage falla al escribir (cuota excedida, modo privado,
 * bloqueado por política del navegador/organización), la selección sigue viva en
 * el `useState` de DespachosShell.tsx durante la sesión actual del tab — solo no
 * sobrevive a navegar a otra ruta ni a un refresh de página. Nunca lanza, para que
 * un fallo de storage nunca tumbe el selector. */
export function persistPropertyId(storage: SessionStorageLike, orgSlug: string, propertyId: string): void {
  try {
    storage.setItem(keyFor(orgSlug), propertyId);
  } catch {
    // best-effort — ver comentario de cabecera de la función.
  }
}
