// UNI-RES-hoteles -- reglas puras del Resumen de hoteles (que ve cada rol y como se redacta cada metrica). Aparte de
// pages/Dashboard.tsx para probarlas sin DOM. Todos los sets son COSMETICOS: el servidor (`assertVerticalRole`) es la
// unica barrera real; aqui solo se evita pedir (y pintar como error) lo que el servidor respondera 403.
import { AGENT_VIEW_ROLES } from "./agentes-client.ts";
import { NIGHT_AUDIT_VIEW_ROLES } from "./night-audit-client.ts";
import { RECEPCION_VIEW_ROLES } from "./recepcion-client.ts";
import { HOLD_VIEW_ROLES } from "./reservas-agente-client.ts";

/** Espejo de `PL_ROLES` (domain-hoteles/src/roles.ts): ocupacion/ADR/RevPAR salen de `GET .../pl`. */
export const RESUMEN_PL_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);
/** Espejo de `MAINTENANCE_TICKET_CREATE_ROLES`: quien puede consultar los tickets de mantenimiento sin 403. */
export const RESUMEN_MANTENIMIENTO_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "housekeeping", "maintenance"]);
/** Espejo de `REVENUE_NAV_ROLES` del Shell: quien ve el link a Revenue. */
export const RESUMEN_REVENUE_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);
/** Espejo de `REPUTACION_NAV_ROLES` del Shell. */
export const RESUMEN_REPUTACION_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);

export interface CapacidadesResumen {
  /** Ocupacion, ADR y RevPAR (`GET .../pl`). */
  readonly pl: boolean;
  /** Llegadas / salidas / en casa del dia desde `GET .../recepcion`. */
  readonly recepcion: boolean;
  /** Aprobaciones pendientes, holds del agente y catalogo de agentes. */
  readonly agentes: boolean;
  /** Seccion "Ultima corrida" (night audit). */
  readonly nightAudit: boolean;
  /** Tickets de mantenimiento abiertos (atajo de housekeeping/maintenance). */
  readonly mantenimiento: boolean;
  /** Pedidos F&B activos y alergias sin confirmar (solo el rol fnb). */
  readonly pedidosFnb: boolean;
  readonly revenue: boolean;
  readonly reputacion: boolean;
}

export function capacidadesResumen(role: string): CapacidadesResumen {
  const recepcion = RECEPCION_VIEW_ROLES.has(role);
  return {
    pl: RESUMEN_PL_ROLES.has(role),
    recepcion,
    agentes: AGENT_VIEW_ROLES.has(role) && HOLD_VIEW_ROLES.has(role),
    nightAudit: NIGHT_AUDIT_VIEW_ROLES.has(role),
    // El conteo de mantenimiento solo es un KPI propio de los roles de piso; owner/gm/frontdesk ya ven Recepcion y Tickets.
    mantenimiento: role === "housekeeping" || role === "maintenance",
    pedidosFnb: role === "fnb",
    revenue: RESUMEN_REVENUE_ROLES.has(role),
    reputacion: RESUMEN_REPUTACION_ROLES.has(role),
  };
}

/** "1 aprobacion" / "3 aprobaciones". */
export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** "2 oct, 14:05" en la zona del negocio (CDMX, la misma de `hoyFechaSolo`); fecha invalida = null. */
export function cuandoNegocio(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" }).format(d);
}
