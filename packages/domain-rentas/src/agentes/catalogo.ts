import { MENSAJERIA_ESCRITURA_ROLES, RENTAS_VERTICAL_ROLES } from "../roles.ts";
import type { ToolDefinicion } from "./tipos.ts";

/**
 * Catálogo de tools del agente de mensajería de rentas — port ACOTADO de
 * rentas/packages/domain/src/agentes/catalogo.ts, reducido a lo que este lote
 * construye (mensajería con borrador + aprobación humana). El catálogo real del
 * origen incluía tools de consulta de disponibilidad/pricing/reservas; esas viven ya
 * como funciones de dominio propias (../pricing/cotizacion.ts, ../aplicacion/
 * reservas.ts) sin exponerse todavía como tool de agente — agregarlas es
 * responsabilidad de un lote futuro que las conecte una por una a esta MISMA matriz
 * de roles, nunca una razón para no construir esta primera hoy.
 *
 * `mensajeria_proponer_borrador` es, a propósito, la ÚNICA tool que un agente de
 * rentas puede invocar: nunca envía nada por sí misma (ver
 * ../mensajeria/colaAprobacion.ts) — solo propone el texto que la ruta HTTP inserta
 * como `borrador_mensaje` en estado `pendiente_aprobacion`, exactamente igual que el
 * camino determinista de `GeneradorBorradorPlantillas`. No existe ninguna tool de
 * cancelación/reembolso/contacto directo en este catálogo (D-006/D-007 del origen).
 */
export const NOMBRE_TOOL_PROPONER_BORRADOR = "mensajeria_proponer_borrador";
export const NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL = "mensajeria_consultar_politica_canal";

export const CATALOGO_TOOLS_AGENTE: readonly ToolDefinicion[] = [
  {
    nombre: NOMBRE_TOOL_PROPONER_BORRADOR,
    descripcion:
      "Propone el texto de respuesta al huésped para el mensaje recibido. Esta tool NUNCA envía el mensaje -- " +
      "el texto propuesto siempre queda pendiente de aprobación humana antes de poder llegar al huésped. Nunca " +
      "confirmes una cancelación, reembolso, o cambio de reserva: para eso, propone un texto que explique que " +
      "un miembro del equipo va a revisar el caso.",
    parametros: {
      type: "object",
      properties: {
        texto: { type: "string", description: "El texto de respuesta propuesto para el huésped, en el idioma del mensaje entrante." },
        necesita_escalamiento: { type: "boolean", description: "true si el mensaje del huésped es una queja, emergencia, solicitud de reembolso, o menciona ser huésped VIP." },
      },
      required: ["texto"],
    },
    // Mismo alcance que ESCRITURA_CALENDARIO_ROLES/MENSAJERIA_ESCRITURA_ROLES: solo
    // quien puede escribir en la conversación puede pedirle al modelo que proponga un
    // borrador para ella.
    rolesPermitidos: MENSAJERIA_ESCRITURA_ROLES,
  },
  {
    nombre: NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL,
    descripcion: "Consulta de solo lectura de la política de mensajería (límite de caracteres, reglas de contacto directo) de un canal -- nunca modifica nada.",
    parametros: {
      type: "object",
      properties: { canal: { type: "string", enum: ["airbnb", "vrbo", "booking"], description: "Código del canal a consultar." } },
      required: ["canal"],
    },
    // Solo lectura, sin efecto sobre ninguna conversación: se abre a TODOS los roles
    // de vertical de rentas, incluidos contador/limpieza -- a diferencia de proponer
    // un borrador, consultar la política de un canal no requiere poder escribir en
    // ninguna conversación.
    rolesPermitidos: RENTAS_VERTICAL_ROLES,
  },
];
