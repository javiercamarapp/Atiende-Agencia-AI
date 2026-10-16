// Mensajes PREGRABADOS de la llamada: aqui viven solo los IDENTIFICADORES (el contrato con la maquina y el controlador) y la
// regla del saludo por hora. El TEXTO (es-MX, trato de usted, con el nombre del negocio) es de cada vertical: son los avisos que el
// servicio de voz debe poder decir SIN depender del proveedor de voz (se reproducen desde un audio local, porque la sintesis del
// proveedor puede ser justo lo que fallo). Ningun mensaje lleva datos del cliente.
export const MENSAJE_IDS = [
  "saludo_respaldo",
  "saludo_respaldo_dias",
  "saludo_respaldo_tardes",
  "saludo_respaldo_noches",
  "silencio_reprompt",
  "silencio_despedida",
  "pedir_repetir",
  "handoff",
  "aviso_duracion",
  "limite_duracion",
  "limite_costo",
  "tope_mensual",
  "proveedor_caido",
  "tool_timeout",
  "despedida",
] as const;

export type MensajeId = (typeof MENSAJE_IDS)[number];

/** Catalogo de textos pregrabados de una vertical: TODOS los ids, ninguno de mas. */
export type CatalogoMensajes = Readonly<Record<MensajeId, string>>;

export type SaludoPorHora = "buenos días" | "buenas tardes" | "buenas noches";

/** Saludo segun la HORA LOCAL del negocio (X40: el seed y el pregrabado decian "buenas tardes" a toda hora). Acepta la hora entera
 * (0-23) o un texto con "HH:MM" ("11:59", "lunes 18:30"). Buenos dias de 5:00 a 11:59, buenas tardes de 12:00 a 19:59 y buenas
 * noches el resto: desde las 20:00 (incluida la madrugada, hasta las 4:59). Un valor que no es hora lanza: callar el error daria un saludo equivocado. */
export function saludoPorHora(horaLocal: number | string): SaludoPorHora {
  let hora: number;
  if (typeof horaLocal === "number") hora = horaLocal;
  else {
    const m = /(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(horaLocal);
    hora = m ? Number(m[1]) : Number.NaN;
  }
  if (!Number.isInteger(hora) || hora < 0 || hora > 23) throw new RangeError(`saludoPorHora: hora local invalida (${String(horaLocal)})`);
  if (hora >= 5 && hora < 12) return "buenos días";
  if (hora >= 12 && hora < 20) return "buenas tardes";
  return "buenas noches";
}

/** Pregrabado de saludo de reserva que corresponde a la HORA LOCAL del negocio (misma regla que el agente: `saludoPorHora`). */
export function mensajeSaludoRespaldo(horaLocal: number | string): MensajeId {
  const saludo = saludoPorHora(horaLocal);
  return saludo === "buenos días" ? "saludo_respaldo_dias" : saludo === "buenas tardes" ? "saludo_respaldo_tardes" : "saludo_respaldo_noches";
}
