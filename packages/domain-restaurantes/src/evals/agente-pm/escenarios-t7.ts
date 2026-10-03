// 71 escenarios de la muestra ANONIMIZADA de chats reales de T7 Garcia Lavin (2-oct-2026). Son datos de evaluacion: describen
// lo que el cliente escribe, lo que el agente debe hacer y lo que NO debe hacer, en texto libre para un juez (LLM o persona).
// No se evaluan de forma determinista; lo que SI es verificable (estructura, ausencia de datos personales, cifras de catalogo
// y que el prompt cubra cada familia de intenciones) lo prueba `tests/pm-c5-escenarios-t7.spec.ts`.
import { readFileSync } from "node:fs";

export type EstadoEscenarioT7 = "activo" | "pendiente_decision";

export interface EscenarioT7 {
  readonly id: string;
  readonly canal: "chat";
  /** Slug de la sucursal del chat (T7 = garcia-lavin). */
  readonly sucursal: string;
  readonly intencion: string;
  readonly turnos_cliente: readonly string[];
  readonly comportamiento_esperado: string;
  readonly que_no_debe_hacer: string;
  /** Preguntas P# del dueño de las que depende lo esperado. */
  readonly dudas: readonly string[];
  readonly estado: EstadoEscenarioT7;
  readonly fuente: string;
}

export interface SuiteEscenariosT7 {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly escenarios: readonly EscenarioT7[];
}

/** Decisiones de Javier todavia abiertas (2-oct-2026): horario y pedidos programados antes de abrir (P1/P18), colonias y regla de
 * cobertura cuando la sucursal dueña de la zona esta cerrada (P3/P7), menu por link (P22) y celulares personales (P25). Un
 * escenario que depende de alguna queda `pendiente_decision`: se lista, pero NO falla el CI ni cuenta en el modo real. */
export const DECISIONES_PENDIENTES: readonly string[] = ["P1", "P3", "P7", "P18", "P22", "P25"];

let cache: SuiteEscenariosT7 | null = null;

export function cargarEscenariosT7(): SuiteEscenariosT7 {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-t7.json", import.meta.url), "utf8")) as SuiteEscenariosT7;
  return cache;
}

export function escenariosT7Activos(): readonly EscenarioT7[] {
  return cargarEscenariosT7().escenarios.filter((e) => e.estado === "activo");
}

export function escenariosT7PendientesDeDecision(): readonly EscenarioT7[] {
  return cargarEscenariosT7().escenarios.filter((e) => e.estado === "pendiente_decision");
}
