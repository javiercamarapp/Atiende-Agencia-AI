// Registro de tools de voz de HOTELES sobre @atiende/voice-core: las 6 herramientas de reservas (H-25, el MISMO catalogo que WhatsApp) mas las 2 que ya
// tenia la voz de hoteles (pedido F&B y contacto no operativo). SOLO corre lo que este registro declara. `crear_pre_reserva` es la herramienta objetivo
// (cierra la llamada como `pre_reserva_creada`: el agente nunca confirma, solo aparta) y `derivar_a_humano` es la de pasar a una persona.
import type { LlmToolDefinition } from "@atiende/agent-core";
import type { ReglasCierreLlamada, RegistroToolsVoz, ToolDefinicion } from "@atiende/voice-core";
import { RESERVAS_TOOLS } from "../reservas-agente/herramientas.ts";
import { MaquinaReservaVoz } from "./maquina-reserva.ts";

export type ResultadoVozHoteles = "pre_reserva_creada";

export const REGLAS_CIERRE_HOTELES: ReglasCierreLlamada<ResultadoVozHoteles> = {
  herramientaObjetivo: "crear_pre_reserva",
  resultadoObjetivo: "pre_reserva_creada",
  herramientaEscalar: "derivar_a_humano",
};

const TOOL_FNB: ToolDefinicion = {
  name: "crear_ticket_huesped_fnb",
  description:
    "Registra un pedido de alimentos o bebidas (room service) de un huésped hospedado. Marca alergia_declarada en true si menciona CUALQUIER alergia, intolerancia o restricción alimentaria (sobre-marcar es aceptable). " +
    "NUNCA digas que un platillo es seguro para una alergia: solo la cocina puede confirmarlo.",
  parameters: {
    type: "object",
    properties: {
      mensaje: { type: "string", description: "El pedido tal cual lo dijo el huésped (máximo 1000 caracteres)." },
      habitacion: { type: "string", description: "Número de habitación, si lo dio." },
      alergia_declarada: { type: "boolean", description: "true si menciona cualquier alergia, intolerancia o restricción alimentaria." },
    },
    required: ["mensaje"],
  },
};

const TOOL_CONTACTO: ToolDefinicion = {
  name: "registrar_contacto_no_operativo",
  description: "Deja registrado, para seguimiento de una persona del hotel, cualquier asunto que no sea reservas ni pedido de alimentos (facturas, quejas, preguntas generales). No prometas resultados.",
  parameters: {
    type: "object",
    properties: {
      motivo: { type: "string", description: "Motivo breve (máximo 500 caracteres)." },
      resumen: { type: "string", description: "Resumen de lo que pidió el huésped, sin datos de tarjeta ni documentos." },
    },
    required: ["motivo"],
  },
};

const comoDefinicion = (t: LlmToolDefinition): ToolDefinicion => ({ name: t.name, description: t.description, parameters: t.parameters as unknown as ToolDefinicion["parameters"] });

export const DEFINICIONES_VOZ_HOTELES: readonly ToolDefinicion[] = Object.freeze([...RESERVAS_TOOLS.map(comoDefinicion), TOOL_FNB, TOOL_CONTACTO]);

/** Registro de UNA llamada (la maquina de la reserva lleva estado, por eso se crea uno por llamada). */
export function crearRegistroToolsHoteles(): RegistroToolsVoz & { readonly maquina: MaquinaReservaVoz } {
  const maquina = new MaquinaReservaVoz();
  return {
    maquina,
    definiciones: () => DEFINICIONES_VOZ_HOTELES,
    herramientasInciertas: ["crear_pre_reserva", "crear_ticket_huesped_fnb"],
    mensajeIncierto: "No se pudo confirmar si quedó registrado. No le asegure nada al huésped; dígale que una persona del hotel lo verificará.",
    guardia: (nombre, args) => maquina.guardia(nombre, args),
    alResultado: (nombre, args, resultado, ok) => maquina.alResultado(nombre, args, resultado, ok),
  };
}
