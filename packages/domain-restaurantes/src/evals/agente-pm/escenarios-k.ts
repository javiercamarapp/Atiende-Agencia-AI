// Escenarios K (lo que enseñan los chats reales de T7 y el cuestionario) y KH (huecos finales del original). Hermano de escenarios-t7.ts:
// mismos campos de texto libre para un juez, mas `verificacion` (lo que ata un test determinista contra el servidor real) y `depende_de`
// (lo que main aun no tiene: el escenario se lista y NO falla el CI). Todo es sintetico: ningun texto sale de los chats privados.
import { readFileSync } from "node:fs";

export type EstadoEscenarioK = "activo" | "pendiente_construccion";
export type VerificacionEscenarioK = "determinista" | "juez";

export interface EscenarioK {
  readonly id: string;
  readonly canal: "chat";
  readonly sucursal: string;
  readonly intencion: string;
  readonly turnos_cliente: readonly string[];
  readonly comportamiento_esperado: string;
  readonly que_no_debe_hacer: string;
  readonly dudas: readonly string[];
  readonly estado: EstadoEscenarioK;
  readonly verificacion: VerificacionEscenarioK;
  /** Lo que falta en main para que el escenario pueda pasar (solo con `pendiente_construccion`). */
  readonly depende_de: string | null;
  /** Prueba que lo ata (solo con `determinista`). */
  readonly prueba: string | null;
  readonly fuente: string;
}

export interface SuiteEscenariosK {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly escenarios: readonly EscenarioK[];
}

let cache: SuiteEscenariosK | null = null;

export function cargarEscenariosK(): SuiteEscenariosK {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-k.json", import.meta.url), "utf8")) as SuiteEscenariosK;
  return cache;
}

export function escenariosKActivos(): readonly EscenarioK[] {
  return cargarEscenariosK().escenarios.filter((e) => e.estado === "activo");
}

export function escenariosKPendientesDeConstruccion(): readonly EscenarioK[] {
  return cargarEscenariosK().escenarios.filter((e) => e.estado === "pendiente_construccion");
}
