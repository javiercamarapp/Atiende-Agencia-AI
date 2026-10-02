// Rn-26 -- cliente del Resumen operativo (apps/api/src/routes/verticals/rentas/resumen.ts). Separado de pages/Dashboard.tsx
// para probarlo en entorno "node". Cada bloque llega con su propio estado: "ok" | "no_disponible" (base sin migrar) |
// "sin_permiso" (el rol no abre la pantalla de origen).
import { fetchJson } from "./admin-client.ts";

export type EstadoBloque = "ok" | "no_disponible" | "sin_permiso";

export type Bloque<T> = ({ readonly estado: "ok" } & T) | { readonly estado: "no_disponible" } | { readonly estado: "sin_permiso" };

export interface AgenteResumen {
  readonly clave: "sync_ical" | "borradores_ia" | "liberacion_acceso" | "checkout_sweep";
  readonly nombre: string;
  readonly ultimaCorridaEn: string;
  readonly estado: "ok" | "atencion" | "error";
  readonly detalle: string;
}

export interface ResumenOperativo {
  readonly hoy: string;
  readonly zonaHoraria: string;
  readonly llegadasSalidas: Bloque<{ readonly llegadas: number; readonly salidas: number }>;
  readonly ocupacionMes: Bloque<{ readonly desde: string; readonly hasta: string; readonly ocupacionBasisPoints: number | null; readonly nochesOcupadas: number; readonly nochesDisponibles: number | null }>;
  readonly conflictos: Bloque<{ readonly abiertos: number }>;
  readonly limpieza: Bloque<{ readonly pendientes: number; readonly vencidas: number }>;
  readonly aprobaciones: Bloque<{ readonly pendientes: number }>;
  readonly feeds: Bloque<{ readonly activos: number; readonly conProblema: number }>;
  readonly agentes: readonly AgenteResumen[];
}

interface BloqueWire {
  readonly estado: EstadoBloque;
  readonly [k: string]: unknown;
}
interface ResumenWire {
  readonly hoy: string;
  readonly zona_horaria: string;
  readonly llegadas_salidas: BloqueWire;
  readonly ocupacion_mes: BloqueWire;
  readonly conflictos: BloqueWire;
  readonly limpieza: BloqueWire;
  readonly aprobaciones: BloqueWire;
  readonly feeds: BloqueWire;
  readonly agentes: readonly { readonly clave: AgenteResumen["clave"]; readonly nombre: string; readonly ultima_corrida_en: string; readonly estado: AgenteResumen["estado"]; readonly detalle: string }[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numONull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Un bloque de estado desconocido se trata como no disponible (nunca se inventa una cifra). */
function mapBloque<T>(w: BloqueWire | undefined, mapea: (w: BloqueWire) => T): Bloque<T> {
  if (w?.estado === "ok") return { estado: "ok", ...mapea(w) };
  if (w?.estado === "sin_permiso") return { estado: "sin_permiso" };
  return { estado: "no_disponible" };
}

export async function fetchResumen(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ResumenOperativo> {
  const w = await fetchJson<ResumenWire>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/resumen`, token);
  return {
    hoy: w.hoy,
    zonaHoraria: w.zona_horaria,
    llegadasSalidas: mapBloque(w.llegadas_salidas, (b) => ({ llegadas: num(b.llegadas), salidas: num(b.salidas) })),
    ocupacionMes: mapBloque(w.ocupacion_mes, (b) => {
      const periodo = (b.periodo ?? {}) as { desde?: string; hasta?: string };
      return { desde: periodo.desde ?? "", hasta: periodo.hasta ?? "", ocupacionBasisPoints: numONull(b.ocupacion_basis_points), nochesOcupadas: num(b.noches_ocupadas), nochesDisponibles: numONull(b.noches_disponibles) };
    }),
    conflictos: mapBloque(w.conflictos, (b) => ({ abiertos: num(b.abiertos) })),
    limpieza: mapBloque(w.limpieza, (b) => ({ pendientes: num(b.pendientes), vencidas: num(b.vencidas) })),
    aprobaciones: mapBloque(w.aprobaciones, (b) => ({ pendientes: num(b.pendientes) })),
    feeds: mapBloque(w.feeds, (b) => ({ activos: num(b.activos), conProblema: num(b.con_problema) })),
    agentes: (w.agentes ?? []).map((a) => ({ clave: a.clave, nombre: a.nombre, ultimaCorridaEn: a.ultima_corrida_en, estado: a.estado, detalle: a.detalle })),
  };
}
