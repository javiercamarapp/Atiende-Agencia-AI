// Redaccion de datos sensibles para alertas SALIENTES (correo, webhook, Sentry).
// Una alerta sale del proceso hacia un tercero (Resend, un webhook generico, Sentry): lo que
// viaje ahi NO debe contener secretos, tokens, correos ni telefonos de clientes aunque un
// mensaje de error de Postgres/proveedor los haya incluido. Defensa en profundidad: el
// llamador ya deberia mandar solo texto operativo; esto es la red de seguridad.
//
// Pura y sin I/O. PL-10: los patrones ya NO viven aqui -- son la fuente unica de
// @atiende/core-pii (la misma que usan el logger, los error handlers y la redaccion de pagos de
// los webhooks de WhatsApp); este archivo conserva la API historica de alertas (topes de largo,
// profundidad y claves) como una configuracion de ese paquete.

import { MARCA_REDACTADO, scrubTexto, scrubValor, type OpcionesScrubValor } from "@atiende/core-pii";

export { MARCA_REDACTADO };

/** Longitud maxima de cualquier cadena que sale en una alerta. */
export const MAX_LARGO_CADENA = 500;

const OPCIONES_ALERTA: OpcionesScrubValor = { maxLargo: MAX_LARGO_CADENA, maxProfundidad: 4, maxClaves: 30, maxElementos: 20, errores: "mensaje" };

export function redactarTexto(texto: string): string {
  return scrubTexto(texto, { maxLargo: MAX_LARGO_CADENA });
}

/** Redacta recursivamente un valor arbitrario (objeto/array/primitivo) con topes de
 *  profundidad y tamano. Nunca lanza; los ciclos terminan por el tope de profundidad. */
export function redactarValor(valor: unknown, profundidad = 0): unknown {
  return scrubValor(valor, OPCIONES_ALERTA, profundidad);
}
