// Escenarios de regresion de la RONDA 6 del loop de pulido del agente de PM (ver `escenarios-r6.json`): defectos confirmados de los testers y de la medida, cada uno atado a la prueba
// determinista que lo cubre en CI, mas el banco de casos para romper (WhatsApp y voz) que se corre a mano con el arnes de Postgres efimero y LLM real.
import { readFileSync } from "node:fs";

export interface EscenarioR6 {
  readonly id: string;
  /** Defecto de la ronda que cubre (`QA-PM-R6-<lente>-NN` u otro identificador de la medida). */
  readonly defecto: string;
  readonly canal: "chat" | "llamada" | "ambos";
  readonly sucursal: string;
  readonly intencion: string;
  readonly turnos_cliente: readonly string[];
  readonly comportamiento_esperado: string;
  readonly que_no_debe_hacer: string;
  /** Prueba determinista que lo cubre en CI (ruta relativa al repo). */
  readonly cubierto_por: string;
  readonly dudas: readonly string[];
  readonly estado: "activo" | "pendiente_decision";
}

export interface ConversacionWhatsappR6 {
  readonly id: string;
  readonly fuente: string;
  readonly sucursal: string;
  readonly reloj_utc: string;
  readonly pasos: readonly unknown[];
  readonly rafaga: boolean;
  readonly pedido_previo: unknown;
  readonly esperado: string;
  readonly prohibido: string;
  readonly pendiente: boolean;
}

export interface GuionVozR6 {
  readonly id: string;
  readonly titulo: string;
  readonly sucursal: string;
  readonly reloj_utc: string;
  readonly sin_turno_extra: boolean;
  readonly turnos: readonly unknown[];
  readonly segunda_llamada: readonly unknown[] | null;
  readonly esperado: string;
  readonly prohibido: string | null;
}

export interface SuiteEscenariosR6 {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly escenarios: readonly EscenarioR6[];
  readonly conversaciones_whatsapp: readonly ConversacionWhatsappR6[];
  readonly guiones_voz: readonly GuionVozR6[];
}

let cache: SuiteEscenariosR6 | null = null;
export function cargarEscenariosR6(): SuiteEscenariosR6 {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-r6.json", import.meta.url), "utf8")) as SuiteEscenariosR6;
  return cache;
}
