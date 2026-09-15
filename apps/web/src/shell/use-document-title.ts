// Mecanismo GENÉRICO y reusable de título de pestaña — hallazgo de auditoría
// (severidad MEDIA/BRANDING, "Título de pestaña fijo en 'Restaurantes' para las 6
// verticales"): `apps/web/index.html` trae un <title>Atiende — Restaurantes</title>
// estático que nunca reflejaba qué vertical (ni qué organización) estaba viendo el
// usuario — cualquiera de las 6 verticales (hoteles, citas, licitaciones, despachos,
// rentas incluidos) mostraba siempre "Restaurantes" en la pestaña del navegador.
//
// Vive aquí, en el shell COMPARTIDO de apps/web (ver el README de esta carpeta: "...y
// layout común de apps/web"), a propósito: las 6 verticales necesitan lo mismo, no
// solo restaurantes (ver el brief de esta ronda de auditoría). Esta ronda solo cablea
// el hook en RestaurantesShell.tsx/Login.tsx — el resto de verticales lo adopta cada
// una en su propio *Shell.tsx/Login.tsx cuando les toque (mismo import, sin volver a
// escribir el mecanismo).
import { useEffect } from "react";

const BRAND = "Atiende";

/** `globalThis` (nunca el identificador `document`) a propósito — mismo motivo
 * exacto documentado en `apps/web/src/lib/authed-fetch.ts::notifySessionExpired`:
 * este archivo es un `.ts` plano incluido también por el `tsconfig.json` RAÍZ del
 * monorepo (el include recursivo bajo `apps/*` hacia archivos `.ts`,
 * `"lib": ["ES2023"]`, SIN `"DOM"` — a diferencia de `apps/web/tsconfig.json`, que
 * sí trae DOM para los `.tsx`), así que el nombre `document` no existe ahí. En un
 * navegador real `globalThis.document` es el documento real; en el entorno "node"
 * de vitest (ver vitest.config.ts) no existe y el hook simplemente no hace nada —
 * nunca truena, mismo criterio best-effort que el resto de este patrón. */
function browserDocument(): { title: string } | null {
  const target = globalThis as { document?: { title: string } };
  return target.document ?? null;
}

/**
 * Fija el título de la pestaña mientras el componente que la llama está montado y
 * lo restaura al desmontar (nunca dos Shells de vertical distintos "pelean" por el
 * título si alguna vez se llegan a montar juntos, p.ej. en tests).
 *
 * @param verticalLabel Nombre de la vertical tal como debe verse en la pestaña
 *   (p.ej. "Restaurantes", "Hoteles") — nunca la marca interna del proyecto, ver
 *   la regla del repo de nunca usar esa marca en ningún string visible.
 * @param orgSlug Slug de la organización activa, si ya se conoce (p.ej. dentro de
 *   un *Shell ya logueado) — se omite en pantallas sin sesión, como Login.
 */
export function useDocumentTitle(verticalLabel: string, orgSlug?: string | null): void {
  useEffect(() => {
    const doc = browserDocument();
    if (!doc) return;
    const previous = doc.title;
    doc.title = orgSlug ? `${BRAND} — ${verticalLabel} · ${orgSlug}` : `${BRAND} — ${verticalLabel}`;
    return () => {
      doc.title = previous;
    };
  }, [verticalLabel, orgSlug]);
}
