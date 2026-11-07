// Cerebro v2 (decision B, latencia): el resumen de cotizar_pedido sin otra llamada al modelo.
//
// Con todos los datos (producto, entrega, nombre, pago y, si es para recoger, la hora) la instruccion de cotizar_pedido le pide al modelo COPIAR `resumen_canonico` TAL CUAL
// (INSTRUCCION_RESUMEN_CANONICO en agent-tools/registry.ts). Esa vuelta solo pega un texto que el servidor ya tiene: con Luna por Azure ZDR cuesta 3-6 s. Aqui se decide, de
// forma conservadora, cuando el servidor puede entregar ese texto el mismo: si hay cualquier cosa que el modelo deba explicar u ofrecer antes del resumen (promociones
// sugeridas, aviso de hora distinta, guacamole, media orden de nachos, pedido grande, una pregunta abierta del cliente...), NO aplica y el modelo redacta como siempre.
// La otra mitad de la condicion (cotizacion vigente de este turno y datos de cierre completos) la revisa el handler con el estado FRESCO del flujo y `planCierreDeterminista`.
import { sinAcentos } from "../../product-search.ts";

/** Herramientas que pueden ir en la misma respuesta que la cotizacion sin que el modelo tenga algo que decir de ellas: solo lecturas. */
const LECTURAS_PREVIAS = new Set(["buscar_cliente", "buscar_producto", "buscar_sucursal_cercana", "consultar_sucursal"]);

/** Llaves del resultado de cotizar_pedido que NO piden nada al modelo. Cualquier otra (aviso_hora, aviso_guacamole, mensaje_media_orden_nachos, ya_mostrada_al_cliente,
 *  pedido_grande, pedido_retenido...) es algo que explicar antes del resumen. */
const LLAVES_NEUTRAS = new Set(["quote", "sin_cortesias", "quote_hash", "resumen_canonico", "instruccion_resumen"]);

/** «En cuanto esté» no viaja en ningun campo de la cotizacion: es la unica forma de saber que la hora de recogida ya esta dicha sin un campo de hora. */
const RECOGER_EN_CUANTO_ESTE = /\b(?:en cuanto (?:este|esten|lo tengan|quede)|lo antes posible|lo mas pronto|ahorita|de una vez|ya mismo)\b/;

export interface LlamadaDelLote {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: unknown;
  readonly error: boolean;
}

/** ¿Puede el servidor entregar el resumen de esta cotizacion sin otra vuelta del modelo? Solo mira el lote de herramientas de ESTA respuesta y los mensajes del cliente. */
export function loteAdmiteResumenSinVuelta(lote: readonly LlamadaDelLote[], mensajesPendientes: readonly string[]): boolean {
  const ultima = lote.at(-1);
  if (!ultima || ultima.name !== "cotizar_pedido" || ultima.error) return false;
  if (lote.slice(0, -1).some((c) => c.error || !LECTURAS_PREVIAS.has(c.name))) return false;
  const r = ultima.result as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.resumen_canonico !== "string" || r.resumen_canonico.trim() === "") return false;
  if (Object.keys(r).some((k) => !LLAVES_NEUTRAS.has(k))) return false;
  const quote = r.quote as { promociones_sugeridas?: readonly unknown[] } | null | undefined;
  if ((quote?.promociones_sugeridas?.length ?? 0) > 0) return false;
  // Una pregunta del cliente pide una respuesta que el resumen no trae.
  if (mensajesPendientes.length === 0 || mensajesPendientes.some((m) => /[?¿]/.test(m))) return false;
  if (ultima.input.canal === "recoger") {
    const conHora = ["hora_recogida", "minutos_para_recoger", "programado_para"].some((k) => ultima.input[k] !== undefined && ultima.input[k] !== null && ultima.input[k] !== "");
    if (!conHora && !mensajesPendientes.some((m) => RECOGER_EN_CUANTO_ESTE.test(sinAcentos(m)))) return false;
  }
  return true;
}
