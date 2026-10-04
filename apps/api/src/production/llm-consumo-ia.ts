// Consumo de IA del superadmin (SA-L-22): el corte por rol/agente de HOY contra su techo diario y los insights deterministas.
// Funcion PURA (sin I/O): recibe filas ya leidas de core.llm_usage_daily / core.llm_org_budget y devuelve lo que pinta la pagina.
//
// Techo de un rol = tope diario de turnos POR ORGANIZACION (`defaultRoleDailyTurnLimit`: CHAT-07). Es el unico techo por rol que
// existe hoy y esta en TURNOS (llamadas al modelo), no en dinero: no hay un techo de costo por rol. Un rol sin tope por defecto
// (los agentes de WhatsApp, la extraccion de requisitos...) se reporta "sin techo": su gasto solo lo acotan el presupuesto del
// gateway y el tope mensual. Los topes PROPIOS por organizacion (core.llm_org_role_limit) no entran en esta tabla agregada.
import type { LlmUsageByOrgRoleMonthRow, LlmUsageByOrganizationRow } from "@atiende/db";
import { defaultRoleDailyTurnLimit } from "./llm-role-limits.ts";

/** Una tasa de fallback por encima de este porcentaje (sobre el total de llamadas del rol en la ventana) dispara el insight. */
export const UMBRAL_FALLBACK_PCT = 10;
/** Una organizacion con mas de este porcentaje de su tope mensual gastado dispara el insight. */
export const UMBRAL_TOPE_MENSUAL_PCT = 80;

export type CodigoInsightConsumo = "rol_sin_techo" | "rol_con_fallbacks" | "organizacion_cerca_del_tope";
export type SeveridadInsightConsumo = "info" | "atencion" | "alta";

export interface InsightConsumo {
  readonly codigo: CodigoInsightConsumo;
  readonly severidad: SeveridadInsightConsumo;
  readonly titulo: string;
  readonly detalle: string;
  readonly role?: string;
  readonly organizationId?: string;
}

export interface RolConsumo {
  readonly role: string;
  /** Prefijo del rol antes de los dos puntos (la vertical o `plataforma`/`reportes`). */
  readonly grupo: string;
  readonly hoy: { readonly costMicroUsd: number; readonly callCount: number; readonly fallbackCallCount: number };
  readonly ventana: { readonly costMicroUsd: number; readonly callCount: number; readonly fallbackCallCount: number };
  /** Tope diario de turnos por organizacion; `null` = el rol no tiene techo. */
  readonly techoTurnosDia: number | null;
  /** Mayor numero de turnos de UNA organizacion hoy (lo que se compara contra el techo). */
  readonly maxTurnosOrganizacionHoy: number;
  /** `maxTurnosOrganizacionHoy / techoTurnosDia * 100`; `null` si no hay techo. */
  readonly pctTecho: number | null;
}

export interface ConsumoIa {
  readonly roles: readonly RolConsumo[];
  readonly insights: readonly InsightConsumo[];
}

interface Suma {
  costMicroUsd: number;
  callCount: number;
  fallbackCallCount: number;
}

const cero = (): Suma => ({ costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 });
const redondear1 = (n: number): number => Math.round(n * 10) / 10;
const usd = (micro: number): string => `US$${(micro / 1_000_000).toFixed(4)}`;

/**
 * @param hoy        filas por organizacion/rol de HOY (`from = to = hoy`).
 * @param ventana    filas por organizacion/rol/mes de la ventana (30 dias que terminan hoy): base de roles y de la tasa de fallback.
 * @param organizaciones  filas por organizacion con su tope mensual y lo gastado este mes; `null` si no se pudieron leer.
 */
export function armarConsumoIa(args: {
  readonly hoy: readonly LlmUsageByOrgRoleMonthRow[];
  readonly ventana: readonly LlmUsageByOrgRoleMonthRow[];
  readonly organizaciones: readonly LlmUsageByOrganizationRow[] | null;
}): ConsumoIa {
  const ventanaPorRol = new Map<string, Suma>();
  for (const f of args.ventana) {
    const s = ventanaPorRol.get(f.role) ?? cero();
    s.costMicroUsd += f.costMicroUsd;
    s.callCount += f.callCount;
    s.fallbackCallCount += f.fallbackCallCount;
    ventanaPorRol.set(f.role, s);
  }
  const hoyPorRol = new Map<string, Suma>();
  const maxTurnos = new Map<string, number>();
  for (const f of args.hoy) {
    const s = hoyPorRol.get(f.role) ?? cero();
    s.costMicroUsd += f.costMicroUsd;
    s.callCount += f.callCount;
    s.fallbackCallCount += f.fallbackCallCount;
    hoyPorRol.set(f.role, s);
    // Un mismo (organizacion, rol) puede venir en dos meses si la ventana cruza el mes; "hoy" es un solo dia: un solo mes.
    maxTurnos.set(f.role, Math.max(maxTurnos.get(f.role) ?? 0, f.callCount));
  }

  const nombresRol = new Set<string>([...ventanaPorRol.keys(), ...hoyPorRol.keys()]);
  const roles: RolConsumo[] = [...nombresRol].map((role) => {
    const techo = defaultRoleDailyTurnLimit(role) ?? null;
    const turnos = maxTurnos.get(role) ?? 0;
    return {
      role,
      grupo: role.includes(":") ? role.slice(0, role.indexOf(":")) : role,
      hoy: hoyPorRol.get(role) ?? cero(),
      ventana: ventanaPorRol.get(role) ?? cero(),
      techoTurnosDia: techo,
      maxTurnosOrganizacionHoy: turnos,
      pctTecho: techo === null ? null : redondear1((turnos / techo) * 100),
    };
  });
  // Mayor gasto de hoy primero; a igualdad, el de la ventana; luego el nombre (orden estable y testeable).
  roles.sort((a, b) => b.hoy.costMicroUsd - a.hoy.costMicroUsd || b.ventana.costMicroUsd - a.ventana.costMicroUsd || a.role.localeCompare(b.role));

  const insights: InsightConsumo[] = [];
  for (const r of roles) {
    if (r.techoTurnosDia === null && r.ventana.callCount > 0) {
      insights.push({
        codigo: "rol_sin_techo",
        severidad: "info",
        titulo: `El rol ${r.role} no tiene techo diario`,
        detalle: `${r.ventana.callCount} llamadas y ${usd(r.ventana.costMicroUsd)} en la ventana sin un tope de turnos por día; solo lo acotan el presupuesto del gateway y el tope mensual.`,
        role: r.role,
      });
    }
    if (r.ventana.callCount > 0) {
      const tasa = (r.ventana.fallbackCallCount / r.ventana.callCount) * 100;
      if (tasa > UMBRAL_FALLBACK_PCT) {
        insights.push({
          codigo: "rol_con_fallbacks",
          severidad: "atencion",
          titulo: `El rol ${r.role} cae a su modelo de respaldo ${redondear1(tasa)} % de las veces`,
          detalle: `${r.ventana.fallbackCallCount} de ${r.ventana.callCount} llamadas usaron respaldo en la ventana (umbral ${UMBRAL_FALLBACK_PCT} %).`,
          role: r.role,
        });
      }
    }
  }
  for (const o of args.organizaciones ?? []) {
    if (o.monthlyCapMicroUsd <= 0) continue;
    const pct = (o.spendThisMonthMicroUsd / o.monthlyCapMicroUsd) * 100;
    if (pct > UMBRAL_TOPE_MENSUAL_PCT) {
      insights.push({
        codigo: "organizacion_cerca_del_tope",
        severidad: pct >= 100 ? "alta" : "atencion",
        titulo: `${o.organizationName} lleva ${redondear1(pct)} % de su tope mensual`,
        detalle: `${usd(o.spendThisMonthMicroUsd)} de ${usd(o.monthlyCapMicroUsd)} este mes (umbral ${UMBRAL_TOPE_MENSUAL_PCT} %).`,
        organizationId: o.organizationId,
      });
    }
  }
  const peso: Record<SeveridadInsightConsumo, number> = { alta: 0, atencion: 1, info: 2 };
  insights.sort((a, b) => peso[a.severidad] - peso[b.severidad]);
  return { roles, insights };
}
