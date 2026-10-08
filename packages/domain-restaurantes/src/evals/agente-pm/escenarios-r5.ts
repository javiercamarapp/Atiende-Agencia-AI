// Escenarios de regresion de la RONDA 5 del loop de pulido del agente de PM: lo que rompio la medida contra la cuenta real (Postgres efimero con la
// config real, API real local, OpenRouter y Gemini Live reales, Meta simulado). Parafraseados y anonimizados. Lo que SI es verificable de forma determinista
// (estructura, ausencia de datos personales, que cada defecto de la ronda tenga una prueba que exista) lo ata `tests/pm-r4-escenarios.spec.ts`; la
// redaccion esperada la juzga un LLM o una persona.
import { readFileSync } from "node:fs";

export interface EscenarioR5 {
  readonly id: string;
  /** Defecto de la ronda que cubre (`QA-PM-R5-<lente>-NN`). */
  readonly defecto: string;
  readonly canal: "chat" | "llamada";
  readonly sucursal: string;
  readonly intencion: string;
  readonly turnos_cliente: readonly string[];
  readonly comportamiento_esperado: string;
  readonly que_no_debe_hacer: string;
  /** Prueba determinista que lo cubre en CI (ruta relativa a packages/domain-restaurantes o al repo, o el id del guion de voz). */
  readonly cubierto_por: string;
  readonly dudas: readonly string[];
  readonly estado: "activo" | "pendiente_decision";
}

export interface SuiteEscenariosR5 {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly escenarios: readonly EscenarioR5[];
}

let cache: SuiteEscenariosR5 | null = null;
export function cargarEscenariosR5(): SuiteEscenariosR5 {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-r5.json", import.meta.url), "utf8")) as SuiteEscenariosR5;
  return cache;
}
