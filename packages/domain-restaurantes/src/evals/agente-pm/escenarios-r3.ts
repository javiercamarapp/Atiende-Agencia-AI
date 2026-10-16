// Escenarios de regresion de la RONDA 3 del loop de pulido del agente de PM: lo que rompio la medida contra la cuenta real (Postgres efimero con la
// config real, API real local, OpenRouter y Gemini Live reales, Meta simulado). Parafraseados y anonimizados. Lo que SI es verificable de forma determinista
// (estructura, ausencia de datos personales, que cada defecto de la ronda tenga una prueba que exista) lo ata `tests/pm-r3-escenarios.spec.ts`; la
// redaccion esperada la juzga un LLM o una persona.
import { readFileSync } from "node:fs";

export interface EscenarioR3 {
  readonly id: string;
  /** Defecto de la ronda que cubre (`QA-PM-R3-<lente>-NN`). */
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

export interface SuiteEscenariosR3 {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly escenarios: readonly EscenarioR3[];
}

let cache: SuiteEscenariosR3 | null = null;
export function cargarEscenariosR3(): SuiteEscenariosR3 {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-r3.json", import.meta.url), "utf8")) as SuiteEscenariosR3;
  return cache;
}
