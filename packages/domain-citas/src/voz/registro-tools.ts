// Registro de tools de voz de CITAS sobre @atiende/voice-core: las 9 herramientas de agenda del agente de WhatsApp (el MISMO catalogo, `TOOLS`) mas
// `derivar_a_humano`. SOLO corre lo que este registro declara. Las 4 que escriben (crear, cancelar, reagendar, modificar) llevan ademas el parametro
// `confirmado_por_cliente` (la maquina de la cita rechaza la accion sin el, ver `maquina-cita.ts`). Cualquiera de esas 4 que sale bien cierra la
// llamada como lograda (`cita_gestionada`); `derivar_a_humano` es la de pasar a una persona.
import type { ReglasCierreLlamada, RegistroToolsVoz, ToolDefinicion } from "@atiende/voice-core";
import { TOOLS } from "../whatsapp/llm-turn-handler.ts";
import { MaquinaCitaVoz, TOOLS_ESCRITURA_CITAS } from "./maquina-cita.ts";

export type ResultadoVozCitas = "cita_gestionada";

export const REGLAS_CIERRE_CITAS: ReglasCierreLlamada<ResultadoVozCitas> = {
  herramientaObjetivo: TOOLS_ESCRITURA_CITAS,
  resultadoObjetivo: "cita_gestionada",
  herramientaEscalar: "derivar_a_humano",
};

const TOOL_DERIVAR: ToolDefinicion = {
  name: "derivar_a_humano",
  description:
    "Pasa la llamada a una persona del negocio. Úsala cuando el cliente lo pida, cuando el asunto no sea de agenda (quejas, precios especiales, otra cita en la misma llamada), o cuando una herramienta devuelva requiere_humano o falle de forma repetida. No prometas un horario de respuesta; di lo que devuelva la herramienta.",
  parameters: {
    type: "object",
    properties: {
      motivo: { type: "string", description: "Motivo breve (máximo 500 caracteres)." },
      resumen: { type: "string", description: "Qué pidió la persona y qué se alcanzó a hacer, sin datos de tarjeta ni documentos." },
    },
    required: ["motivo"],
  },
};

const CONFIRMACION = {
  type: "boolean",
  description: "true SOLO si ya le dijiste al cliente exactamente qué vas a hacer y respondió que sí en esta llamada. Si no, no llames la herramienta.",
} as const;

function paraVoz(t: (typeof TOOLS)[number]): ToolDefinicion {
  const base = t.parameters as unknown as ToolDefinicion["parameters"];
  if (!TOOLS_ESCRITURA_CITAS.includes(t.name)) return { name: t.name, description: t.description, parameters: base };
  return {
    name: t.name,
    description: t.description,
    parameters: { ...base, properties: { ...base.properties, confirmado_por_cliente: CONFIRMACION }, required: [...(base.required ?? []), "confirmado_por_cliente"] },
  };
}

export const DEFINICIONES_VOZ_CITAS: readonly ToolDefinicion[] = Object.freeze([...TOOLS.map(paraVoz), TOOL_DERIVAR]);

/** Registro de UNA llamada (la maquina de la cita lleva estado, por eso se crea uno por llamada). */
export function crearRegistroToolsCitas(): RegistroToolsVoz & { readonly maquina: MaquinaCitaVoz } {
  const maquina = new MaquinaCitaVoz();
  return {
    maquina,
    definiciones: () => DEFINICIONES_VOZ_CITAS,
    herramientasInciertas: TOOLS_ESCRITURA_CITAS,
    mensajeIncierto: "No se pudo confirmar si la acción quedó registrada. No le asegure nada al cliente; dígale que una persona del negocio lo verificará.",
    guardia: (nombre, args) => maquina.guardia(nombre, args),
    alResultado: (nombre, args, resultado, ok) => maquina.alResultado(nombre, args, resultado, ok),
  };
}
