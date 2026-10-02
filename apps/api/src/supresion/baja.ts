// BAJA / STOP por WhatsApp (SA-L-46): el contacto que escribe una de estas palabras (mensaje COMPLETO, no
// una palabra dentro de una frase) queda en la lista de supresion de plataforma y recibe UNA sola
// confirmacion. Ver docs/SUPRESION.md (incluye el riesgo de falsos positivos de "ya no" / "alto").
import type { TenantDbSession } from "@atiende/core-tenancy";
import { registrarSupresion } from "./acceso.ts";
import type { ResultadoRegistro } from "./acceso.ts";

const PALABRAS_BAJA = new Set(["baja", "stop", "alto", "ya no", "dar de baja", "darme de baja", "cancelar suscripcion"]);

function quitarAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/gu, "");
}

/** `true` solo si el mensaje COMPLETO es una palabra de baja (insensible a mayusculas, acentos y signos). */
export function esPalabraBaja(texto: string): boolean {
  const limpio = quitarAcentos(texto).trim().toLowerCase().replace(/^[¡¿\s]+/gu, "").replace(/[.!¡¿?\s]+$/gu, "").replace(/\s+/gu, " ");
  return PALABRAS_BAJA.has(limpio);
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
