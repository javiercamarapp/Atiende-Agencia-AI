// Urgencia de aprobacion en el tablero de Pedidos, traida de la cola «Recibidas» del repo suelto (src/lib/pedidos-cola.ts:
// `minutosPorAprobar`, `esPorAprobarUrgente`, `ordenarRecibidas`). Regla del original: lo que espera aprobacion va PRIMERO y el
// mas viejo arriba, y nunca se esconde por antiguedad (ahi vive el unico boton Aprobar; si saliera de la vista, el cliente se
// queda esperando). En el monorepo lo que espera aprobacion son las solicitudes del autopiloto (migracion 050), no un estado del
// pedido, asi que la regla se aplica a esas solicitudes. Logica pura: `ahoraMs` inyectado, sin React.
import type { Solicitud } from "./autopiloto-client.ts";

/** Umbral del original cuando no se conoce el de la sucursal: un pedido grande sin aprobar desde hace mas de esto es urgente. */
export const POR_APROBAR_URGENTE_MIN = 30;

type SolicitudUrgencia = Pick<Solicitud, "solicitadaAt" | "escaladaAt">;

/** Minutos que lleva esperando (0 si la fecha no se puede leer o es futura). */
export function minutosPorAprobar(s: Pick<Solicitud, "solicitadaAt">, ahoraMs: number): number {
  const desde = Date.parse(s.solicitadaAt);
  return Number.isNaN(desde) ? 0 : Math.max(0, Math.floor((ahoraMs - desde) / 60_000));
}

/**
 * Urgente = el servidor ya la escalo al dueno (`escaladaAt`) o lleva al menos el umbral esperando. El umbral es el de la
 * sucursal (`aprobacionMinutos` de las reglas del autopiloto, el mismo que dispara la escalacion) y, sin el, el del original.
 */
export function esPorAprobarUrgente(s: SolicitudUrgencia, ahoraMs: number, umbralMin: number | null | undefined = null): boolean {
  if (s.escaladaAt) return true;
  const umbral = typeof umbralMin === "number" && Number.isFinite(umbralMin) && umbralMin > 0 ? umbralMin : POR_APROBAR_URGENTE_MIN;
  return minutosPorAprobar(s, ahoraMs) >= umbral;
}

/** Las urgentes primero y, dentro de cada grupo, la mas vieja arriba. No muta la lista. */
export function ordenarPorAprobar<T extends SolicitudUrgencia>(lista: readonly T[], ahoraMs: number, umbralMin: number | null | undefined = null): T[] {
  const clave = (s: T) => {
    const t = Date.parse(s.solicitadaAt);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return lista
    .map((s, i) => ({ s, i, urgente: esPorAprobarUrgente(s, ahoraMs, umbralMin) }))
    .sort((a, b) => (a.urgente === b.urgente ? clave(a.s) - clave(b.s) || a.i - b.i : a.urgente ? -1 : 1))
    .map((x) => x.s);
}

export interface ResumenPorAprobar {
  readonly total: number;
  readonly urgentes: number;
  /** Minutos de la que mas lleva esperando (0 sin solicitudes). */
  readonly masAntiguaMin: number;
}

export function resumenPorAprobar(lista: readonly SolicitudUrgencia[], ahoraMs: number, umbralMin: number | null | undefined = null): ResumenPorAprobar {
  let urgentes = 0;
  let masAntiguaMin = 0;
  for (const s of lista) {
    if (esPorAprobarUrgente(s, ahoraMs, umbralMin)) urgentes += 1;
    masAntiguaMin = Math.max(masAntiguaMin, minutosPorAprobar(s, ahoraMs));
  }
  return { total: lista.length, urgentes, masAntiguaMin };
}
