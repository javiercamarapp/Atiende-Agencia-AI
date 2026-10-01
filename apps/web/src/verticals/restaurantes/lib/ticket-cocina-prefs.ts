// Estado local de la impresión de cocina (PM PR-7): auto-impresión opcional por sucursal,
// pedidos ya impresos y número de reimpresiones. Vive SOLO en el navegador que imprime
// (la "cola" es el polling del panel sobre el listado de pedidos): no hay tabla ni
// columna nueva, así que funciona contra la base sin migrar. Consecuencia asumida: el
// estado no se comparte entre dispositivos -- la auto-impresión debe activarse en el
// equipo que está conectado a la impresora de cocina.
//
// Best-effort como property-selection.ts: un storage bloqueado nunca tumba el panel; sin
// storage, la auto-impresión simplemente no puede recordar qué imprimió y por eso NO se
// ofrece (ver `storageDisponible`).
import type { SessionStorageLike } from "../../../lib/auth-client.ts";

const KEY_PREFIX = "atiende.restaurantes.ticketCocina.";
/** Tope de ids recordados: la lista solo sirve para no repetir pedidos recientes. */
export const MAX_IMPRESOS_RECORDADOS = 500;

export interface PrefsTicketCocina {
  readonly autoImprimir: boolean;
  /** Ids ya impresos (orden de inserción: el más reciente al final). */
  readonly impresos: readonly string[];
  /** Reimpresiones por pedido (0/ausente = solo el original). */
  readonly reimpresiones: Readonly<Record<string, number>>;
}

export const PREFS_VACIAS: PrefsTicketCocina = { autoImprimir: false, impresos: [], reimpresiones: {} };

function keyFor(orgSlug: string, propertyId: string): string {
  return `${KEY_PREFIX}${orgSlug}.${propertyId}`;
}

export function leerPrefs(storage: SessionStorageLike, orgSlug: string, propertyId: string): PrefsTicketCocina {
  try {
    const raw = storage.getItem(keyFor(orgSlug, propertyId));
    if (!raw) return PREFS_VACIAS;
    const p = JSON.parse(raw) as Partial<PrefsTicketCocina> | null;
    if (!p || typeof p !== "object") return PREFS_VACIAS;
    const impresos = Array.isArray(p.impresos) ? p.impresos.filter((x): x is string => typeof x === "string") : [];
    const reimpresiones: Record<string, number> = {};
    if (p.reimpresiones && typeof p.reimpresiones === "object") {
      for (const [k, v] of Object.entries(p.reimpresiones)) if (typeof v === "number" && Number.isFinite(v) && v > 0) reimpresiones[k] = Math.floor(v);
    }
    return { autoImprimir: p.autoImprimir === true, impresos, reimpresiones };
  } catch {
    return PREFS_VACIAS;
  }
}

/** Devuelve false si no se pudo guardar (storage bloqueado o lleno). */
export function guardarPrefs(storage: SessionStorageLike, orgSlug: string, propertyId: string, prefs: PrefsTicketCocina): boolean {
  try {
    const recortados = prefs.impresos.slice(-MAX_IMPRESOS_RECORDADOS);
    const permitidos = new Set(recortados);
    const reimpresiones = Object.fromEntries(Object.entries(prefs.reimpresiones).filter(([id]) => permitidos.has(id)));
    storage.setItem(keyFor(orgSlug, propertyId), JSON.stringify({ autoImprimir: prefs.autoImprimir, impresos: recortados, reimpresiones }));
    return true;
  } catch {
    return false;
  }
}

/** true si el storage permite escribir y releer (sin esto la auto-impresión reimprimiría
 * el mismo pedido en cada ciclo de polling). */
export function storageDisponible(storage: SessionStorageLike): boolean {
  try {
    const k = `${KEY_PREFIX}__probe`;
    storage.setItem(k, "1");
    const ok = storage.getItem(k) === "1";
    storage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}

export function marcarImpresos(prefs: PrefsTicketCocina, ids: readonly string[]): PrefsTicketCocina {
  const ya = new Set(prefs.impresos);
  const nuevos = ids.filter((id) => !ya.has(id));
  return nuevos.length === 0 ? prefs : { ...prefs, impresos: [...prefs.impresos, ...nuevos] };
}

export function registrarReimpresion(prefs: PrefsTicketCocina, id: string): PrefsTicketCocina {
  const n = (prefs.reimpresiones[id] ?? 0) + 1;
  return { ...marcarImpresos(prefs, [id]), reimpresiones: { ...prefs.reimpresiones, [id]: n } };
}
