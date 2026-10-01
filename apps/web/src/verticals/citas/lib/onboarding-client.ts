// C-06 -- cliente del checklist de "Primeros pasos" de citas: GET /v1/citas/properties/:propertyId/onboarding (el estado
// de cada paso lo calcula el SERVIDOR; aqui solo se pinta) y las preferencias de descartar/posponer.
//
// Descartar/posponer es una comodidad de ESTE navegador (localStorage, por negocio + sucursal), no un dato del negocio:
// no cambia que el paso este completo ni habilita nada. Un paso REQUERIDO para publicar nunca se oculta. Si el
// almacenamiento no esta disponible (ventana privada, bloqueado) todo se muestra sin ocultar nada.
import { fetchJson } from "./admin-client.ts";

export type PasoId = "proveedor" | "servicio" | "asignacion" | "horario" | "precio" | "whatsapp" | "recordatorios" | "cancelacion" | "cita_prueba";
export type PasoEstado = "completo" | "pendiente" | "no_disponible";

export interface PasoOnboarding {
  readonly id: PasoId;
  readonly titulo: string;
  readonly descripcion: string;
  readonly estado: PasoEstado;
  readonly requeridoParaPublicar: boolean;
  readonly detalle: string | null;
  readonly ruta: string;
}

export interface ChecklistOnboarding {
  readonly propertyId: string;
  readonly pasos: readonly PasoOnboarding[];
  readonly completados: number;
  readonly total: number;
  readonly progresoPct: number;
  readonly faltanParaPublicar: readonly PasoId[];
  readonly listoParaRecibirCitas: boolean;
}

export function fetchOnboarding(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ChecklistOnboarding> {
  return fetchJson<ChecklistOnboarding>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/onboarding`, token);
}

/** Enlace directo a la pantalla donde se resuelve el paso. */
export function rutaDelPaso(orgSlug: string, paso: Pick<PasoOnboarding, "ruta">): string {
  return `/citas/${orgSlug}/${paso.ruta}`;
}

// ---- Descartar / posponer (solo este navegador) ----

export interface PreferenciasOnboarding {
  readonly descartados: readonly string[];
  /** id de paso -> instante ISO hasta el que esta pospuesto. */
  readonly pospuestos: Readonly<Record<string, string>>;
}

export const PREFERENCIAS_VACIAS: PreferenciasOnboarding = { descartados: [], pospuestos: {} };
export const DIAS_POSPONER = 7;

export function claveDePreferencias(orgId: string, propertyId: string): string {
  return `atiende.citas.onboarding.${orgId}.${propertyId}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function leerPreferencias(storage: StorageLike | null, clave: string): PreferenciasOnboarding {
  try {
    const raw = storage?.getItem(clave);
    if (!raw) return PREFERENCIAS_VACIAS;
    const v = JSON.parse(raw) as { descartados?: unknown; pospuestos?: unknown };
    const descartados = Array.isArray(v.descartados) ? v.descartados.filter((x): x is string => typeof x === "string") : [];
    const pospuestos: Record<string, string> = {};
    if (v.pospuestos && typeof v.pospuestos === "object") {
      for (const [id, hasta] of Object.entries(v.pospuestos as Record<string, unknown>)) {
        if (typeof hasta === "string" && Number.isFinite(Date.parse(hasta))) pospuestos[id] = hasta;
      }
    }
    return { descartados, pospuestos };
  } catch {
    return PREFERENCIAS_VACIAS;
  }
}

export function guardarPreferencias(storage: StorageLike | null, clave: string, prefs: PreferenciasOnboarding): void {
  try {
    storage?.setItem(clave, JSON.stringify(prefs));
  } catch {
    /* sin almacenamiento: la preferencia vale solo mientras la pagina siga abierta */
  }
}

export function descartarPaso(prefs: PreferenciasOnboarding, id: string): PreferenciasOnboarding {
  const { [id]: _quitado, ...resto } = prefs.pospuestos;
  void _quitado;
  return { descartados: prefs.descartados.includes(id) ? prefs.descartados : [...prefs.descartados, id], pospuestos: resto };
}

export function posponerPaso(prefs: PreferenciasOnboarding, id: string, ahora: Date, dias = DIAS_POSPONER): PreferenciasOnboarding {
  return {
    descartados: prefs.descartados.filter((x) => x !== id),
    pospuestos: { ...prefs.pospuestos, [id]: new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000).toISOString() },
  };
}

export function reactivarPaso(prefs: PreferenciasOnboarding, id: string): PreferenciasOnboarding {
  const { [id]: _quitado, ...resto } = prefs.pospuestos;
  void _quitado;
  return { descartados: prefs.descartados.filter((x) => x !== id), pospuestos: resto };
}

export type OcultoComo = "descartado" | "pospuesto" | null;

/** Un paso requerido, o ya completo, nunca se oculta. Un pospuesto vuelve solo cuando vence. */
export function ocultoComo(prefs: PreferenciasOnboarding, paso: Pick<PasoOnboarding, "id" | "requeridoParaPublicar" | "estado">, ahora: Date): OcultoComo {
  if (paso.requeridoParaPublicar || paso.estado === "completo") return null;
  if (prefs.descartados.includes(paso.id)) return "descartado";
  const hasta = prefs.pospuestos[paso.id];
  if (hasta !== undefined && Date.parse(hasta) > ahora.getTime()) return "pospuesto";
  return null;
}
