// BAJA / STOP por WhatsApp (SA-L-46): el contacto que escribe una de estas palabras (mensaje COMPLETO, no
// una palabra dentro de una frase) queda en la lista de supresion de plataforma y recibe UNA sola
// confirmacion. Ver docs/SUPRESION.md (incluye el riesgo de falsos positivos de "ya no" / "alto").
import type { TenantDbSession } from "@atiende/core-tenancy";
import { detectarOptOut } from "@atiende/whatsapp-gateway";
import { crearGuardSupresion, reactivarSupresionBaja, registrarSupresion } from "./acceso.ts";
import type { ResultadoReactivacion, ResultadoRegistro } from "./acceso.ts";

const PALABRAS_BAJA = new Set(["baja", "stop", "alto", "ya no", "dar de baja", "darme de baja", "cancelar suscripcion"]);

function quitarAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/gu, "");
}

/** `true` solo si el mensaje COMPLETO es una palabra de baja (insensible a mayusculas, acentos y signos). */
export function esPalabraBaja(texto: string): boolean {
  const limpio = quitarAcentos(texto).trim().toLowerCase().replace(/^[¡¿\s]+/gu, "").replace(/[.!¡¿?\s]+$/gu, "").replace(/\s+/gu, " ");
  // PL-32: ademas del conjunto de arriba, la deteccion compartida del gateway (p. ej. "no mas mensajes", "darme de baja").
  return PALABRAS_BAJA.has(limpio) || detectarOptOut(texto) === "baja";
}

/** `true` solo si el mensaje COMPLETO es una orden de reactivar (ALTA, START...). Deteccion compartida del gateway. */
export function esPalabraAlta(texto: string): boolean {
  return detectarOptOut(texto) === "alta";
}

export const BAJA_CONFIRMADA_TEXTO = "Listo: ya no recibirás avisos automáticos de Atiende por WhatsApp. Puedes escribirnos cuando quieras y te atendemos.";

export interface ResultadoBaja {
  /** `true` si el mensaje era una baja y quedo procesado (el webhook NO debe pasarlo al agente). */
  readonly manejada: boolean;
  readonly resultado: ResultadoRegistro | null;
}

/**
 * Procesa un mensaje entrante. Si es una baja: registra (idempotente) y llama `confirmar` UNA sola vez, solo
 * cuando la fila es nueva. Si la base aun no tiene la migracion (`no_migrada`) NO se maneja: el mensaje sigue
 * al camino anterior del webhook.
 */
export async function procesarMensajeBaja(
  db: TenantDbSession,
  input: { readonly telefono: string; readonly texto: string; readonly origen: string; readonly organizationId: string | null; readonly confirmar: () => Promise<void> },
): Promise<ResultadoBaja> {
  if (!esPalabraBaja(input.texto)) return { manejada: false, resultado: null };
  const resultado = await registrarSupresion(db, { tipo: "telefono", valor: input.telefono, motivo: "baja", origen: input.origen, organizationId: input.organizationId });
  if (resultado === "no_migrada" || resultado === "valor_invalido") return { manejada: false, resultado };
  if (resultado === "registrada") await input.confirmar();
  return { manejada: true, resultado };
}

export const ALTA_CONFIRMADA_TEXTO = "Listo: volverás a recibir los avisos automáticos de Atiende por WhatsApp. Si quieres dejar de recibirlos, escribe BAJA.";

export interface ResultadoAlta {
  /** `true` si el mensaje era una ALTA que quito una baja y quedo procesada (el webhook NO debe pasarlo al agente). */
  readonly manejada: boolean;
  readonly resultado: ResultadoReactivacion | "sigue_suprimido" | null;
}

/**
 * ALTA (PL-32): si el mensaje es una ALTA, quita la baja voluntaria y llama `confirmar` UNA sola vez. NO se maneja (el texto sigue al
 * agente) cuando no habia baja que quitar, cuando el contacto sigue suprimido por otro motivo (queja, rebote, ARCO, "no contactar":
 * confirmar seria mentir) o cuando la base aun no tiene la migracion 0048.
 */
export async function procesarMensajeAlta(
  db: TenantDbSession,
  input: { readonly telefono: string; readonly texto: string; readonly confirmar: () => Promise<void> },
): Promise<ResultadoAlta> {
  if (!esPalabraAlta(input.texto)) return { manejada: false, resultado: null };
  const resultado = await reactivarSupresionBaja(db, { tipo: "telefono", valor: input.telefono });
  if (resultado !== "reactivada") return { manejada: false, resultado };
  if (await crearGuardSupresion(db)("telefono", input.telefono)) return { manejada: false, resultado: "sigue_suprimido" };
  await input.confirmar();
  return { manejada: true, resultado };
}

/** Atajo de los webhooks: BAJA primero (SA-L-46) y, si no era baja, ALTA (PL-32). `true` = el mensaje ya quedo atendido. */
export async function procesarBajaOAlta(
  db: TenantDbSession,
  input: { readonly telefono: string; readonly texto: string; readonly origen: string; readonly organizationId: string | null; readonly confirmarBaja: () => Promise<void>; readonly confirmarAlta: () => Promise<void> },
): Promise<boolean> {
  const baja = await procesarMensajeBaja(db, { telefono: input.telefono, texto: input.texto, origen: input.origen, organizationId: input.organizationId, confirmar: input.confirmarBaja });
  if (baja.manejada) return true;
  const alta = await procesarMensajeAlta(db, { telefono: input.telefono, texto: input.texto, confirmar: input.confirmarAlta });
  return alta.manejada;
}
