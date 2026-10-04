// R-44 -- reglas de idioma del agente (WhatsApp y voz) y textos fijos del sistema en ingles. El idioma lo calcula el servidor
// (`../idioma.ts`); estas reglas solo le dicen al modelo como responder y NO tocan ninguna regla dura: minimos, horarios, cantidades,
// cotizar antes de confirmar y escalaciones son identicos en los dos idiomas porque las aplican las herramientas y los guardias.
import type { Idioma } from "../idioma.ts";

/** Se agrega a TODOS los perfiles (como las reglas de notas de voz). Siempre presente: el idioma lo decide el cliente, no la configuracion. */
export const IDIOMA_RULES = `IDIOMA:
- Responda en el idioma en que escribe el cliente: español (de usted) por omisión; si escribe en inglés, responda en inglés, y si cambia de idioma, cambie con él. No mezcle idiomas en un mismo mensaje (los nombres de productos y colonias van tal cual).
- En inglés conserve el mismo trato cortés y formal, sin jerga, y sigue siendo un asistente virtual (diga "virtual assistant" si le preguntan). Las reglas duras NO cambian por el idioma: precios, cantidades, mínimos, horarios, cotizar antes de confirmar y escalaciones.
- Los valores que usted manda a las herramientas NO se traducen: tortilla "maiz"/"harina"/"mixta", canal "domicilio"/"recoger", payment_method, los motivos de escalar_a_humano y los nombres de producto exactamente como los devuelve buscar_producto. Traducir un platillo es solo para explicárselo al cliente, nunca para buscarlo, cotizarlo ni crearlo.
- Lo que lee el equipo del restaurante (resumen de escalar_a_humano, notes de crear_pedido, motivos) va SIEMPRE en español, aunque el cliente escriba en inglés.
- Los importes son en pesos mexicanos (MXN) y la hora es la local de la sucursal: nunca convierta a dólares ni a otra zona horaria.
- Si el cliente escribe en un idioma distinto del español y del inglés, responda en español con cortesía y ofrezca ayuda en español o en inglés.`;

/** Version compacta para la llamada (el comportamiento de voz tiene tope de 8000 caracteres). */
export const IDIOMA_RULES_VOZ = `# IDIOMA
- Hable en el idioma del cliente: español (de usted) por omisión; si habla en inglés, responda en inglés, cortés y formal, y diga "virtual assistant" si le preguntan. Si cambia de idioma, cámbiese con él.
- Las reglas duras no cambian. Los valores de las herramientas no se traducen (tortilla, canal, pago, motivos, nombres de producto); lo que lee el equipo (resumen, notes) va en español. Importes en pesos mexicanos, nunca en dólares.`;

/** Bloque por turno: le dice al modelo en que idioma esta ESTA conversacion (lo calculo el servidor, no el modelo). */
export function bloqueIdiomaActual(idioma: Idioma): string {
  return idioma === "en"
    ? `IDIOMA ACTUAL DE ESTA CONVERSACIÓN: inglés. Todos sus mensajes al cliente van en inglés (cortés, formal, "you"), incluido el saludo y las preguntas del flujo; los argumentos de las herramientas siguen en español como se indica arriba.`
    : `IDIOMA ACTUAL DE ESTA CONVERSACIÓN: español. Responda en español, de usted.`;
}

/** Textos fijos del sistema (no los redacta el modelo) cuando falla algo o hay que cerrar un turno. */
export const COPY_FIJO = {
  es: {
    avisoNoRegistrado: "Lamento el inconveniente: no pude avisar al equipo en este momento. Por favor inténtelo de nuevo en unos minutos.",
    repetirPedido: "¿Me puede repetir su pedido, por favor?",
    turnoComplicado: "Se me complicó procesar su pedido. Un momento, por favor.",
    pedidoRegistrado: "Su pedido ya quedó registrado y se mandó a cocina.",
    problemaTecnico: "En este momento tenemos un problema técnico. Por favor, inténtelo de nuevo en unos minutos.",
  },
  en: {
    avisoNoRegistrado: "I'm sorry for the inconvenience: I couldn't alert the team right now. Please try again in a few minutes.",
    repetirPedido: "Could you please repeat your order?",
    turnoComplicado: "I had trouble processing your order. One moment, please.",
    pedidoRegistrado: "Your order has been registered and sent to the kitchen.",
    problemaTecnico: "We are having a technical problem right now. Please try again in a few minutes.",
  },
} as const;

export const AVISO_BISTEC_EN = "Steak (bistec) tacos are sold only in orders of 3; each menu price is for the full order.";
