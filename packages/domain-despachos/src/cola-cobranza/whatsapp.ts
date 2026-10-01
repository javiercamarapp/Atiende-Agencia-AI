// D-11 -- utilidades puras del recordatorio por WhatsApp (opt-in/opt-out). NADA aqui envia: el mensaje se
// ENCOLA en `despachos.cobranza_whatsapp_outbox` y ningun proceso del repo lo despacha todavia.
import { construirRecordatorioCobranza } from "../cobranza/engine.ts";
import type { CobranzaReminderStage } from "../cobranza/engine.ts";

const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;
export const MAX_MENSAJE_WHATSAPP = 1000;

export function normalizarRfc(raw: string): string | null {
  const rfc = raw.trim().toUpperCase();
  return RFC_RE.test(rfc) ? rfc : null;
}

/** Normaliza a E.164. Un numero de 10 digitos se asume mexicano (+52); `+521...`/`521...` (movil historico)
 * se reduce a `+52` + 10 digitos. Cualquier otro numero con `+` se acepta si es E.164 valido. */
export function normalizarTelefono(raw: string): string | null {
  const limpio = raw.trim().replace(/[\s().-]/g, "");
  if (limpio === "") return null;
  let candidato: string;
  if (limpio.startsWith("+")) candidato = limpio;
  else if (/^\d{10}$/.test(limpio)) candidato = `+52${limpio}`;
  else if (/^\d{12,13}$/.test(limpio) && limpio.startsWith("52")) candidato = `+${limpio}`;
  else return null;
  if (/^\+521\d{10}$/.test(candidato)) candidato = `+52${candidato.slice(4)}`;
  return E164_RE.test(candidato) ? candidato : null;
}

/** Texto del recordatorio (reutiliza las plantillas del motor de cobranza; el monto se formatea desde centavos). */
export function construirMensajeWhatsApp(entrada: {
  readonly facturaId: string;
  readonly nombreCliente: string;
  readonly saldoCentavos: number;
  readonly diasVencido: number;
  readonly etapa: CobranzaReminderStage;
}): string {
  const r = construirRecordatorioCobranza({ facturaId: entrada.facturaId, nombreCliente: entrada.nombreCliente, monto: entrada.saldoCentavos / 100, diasVencido: entrada.diasVencido }, entrada.etapa, "whatsapp");
  return (r.whatsapp ?? "").slice(0, MAX_MENSAJE_WHATSAPP);
}

/** Llave de idempotencia: una cuenta recibe a lo mas un mensaje por etapa y dia de negocio. */
export function dedupeKeyWhatsApp(receivableId: string, etapa: CobranzaReminderStage, fechaNegocio: string): string {
  return `cobranza-wa:${receivableId}:${etapa}:${fechaNegocio}`;
}
