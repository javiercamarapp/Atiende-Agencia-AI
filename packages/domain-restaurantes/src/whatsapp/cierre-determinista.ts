// Cierre determinista del turno del «si» (QA-PM ronda 9, P1).
//
// El turno del «si» encadena confirmar_resumen + crear_pedido (hasta 3 vueltas de LLM). Con un proveedor lento el turno agota su presupuesto (18 s) y
// `fallaDelSistema()` respondia «problema tecnico» y escalaba: el cliente ya habia dicho que si y el pedido se perdia. Antes de escalar, el handler intenta
// cerrar el pedido SIN modelo, con lo que el SERVIDOR ya tiene guardado de la cotizacion vigente (renglones resueltos, sucursal, canal, hora) y con tres
// datos que se pueden leer sin adivinar: el nombre que ya esta en el cliente conocido, la forma de pago que el cliente (o el resumen que vio) dice una sola
// vez, y el total del resumen. Todo lo demas lo sigue decidiendo el servidor al crear (huella, precios, horario, minimo, pedido grande, nombre utilizable).
//
// Este archivo solo tiene las decisiones PURAS (sin base ni modelo): sirven para probar cada puerta sin armar un turno completo. Cualquier duda = `null`,
// y el handler escala como antes. Nunca se inventa un dato: es preferible perder el atajo que crear un pedido que el cliente no confirmo.
import { CLAIM_STALE_MS, fingerprintOrder, itemsDeHuella, QUOTE_TTL_MS } from "../agent-tools/order-flow.ts";
import type { OrderFlowContext, OrderFlowSnapshot } from "../agent-tools/order-flow.ts";
import { nombreDeClienteUtilizable } from "../orders.ts";

/** Quita acentos, pasa a minusculas y deja solo letras, digitos y espacios sencillos. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras que por si solas afirman. */
const AFIRMACIONES = new Set(["si", "sii", "siii", "sip", "simon", "claro", "correcto", "confirmo", "confirmado", "perfecto", "adelante", "exacto", "afirmativo", "cierto", "acuerdo"]);
/** «ok / va / dale / listo» sueltos tambien se dicen al recibir un dato informativo («Son 3 tacos, $126»): NO bastan solos para crear un pedido, solo acompanan a un si claro («si ok»). */
const AFIRMACIONES_DEBILES = new Set(["ok", "okey", "va", "dale", "listo"]);
/** Palabras de relleno permitidas junto a una afirmacion («si, esta bien», «si por favor», «si efectivo»). Cualquier otra palabra (un «pero», un producto, una cantidad) descalifica. */
const RELLENO = new Set(["es", "esta", "bien", "asi", "todo", "de", "por", "favor", "gracias", "muy", "bueno", "y", "efectivo", "tarjeta", "pago", "con", "el", "la", "lo", "mi", "pedido", "confirmar"]);
const MAX_PALABRAS_DEL_SI = 6;

/**
 * ¿Es un «si» CLARO de confirmacion y nada mas? Lista cerrada: solo afirmaciones y relleno corto. «Si pero mejor 5», «si, agrega una coca», «no», «a que hora», «mmm si»
 * o un emoji solo NO cuentan (la decision de esos mensajes es del modelo o de una persona, nunca de este atajo).
 */
export function esSiClaroDeConfirmacion(texto: string): boolean {
  if (typeof texto !== "string" || texto.length > 80 || /[?¿]/.test(texto)) return false;
  const palabras = normalizar(texto).split(" ").filter(Boolean);
  if (palabras.length === 0 || palabras.length > MAX_PALABRAS_DEL_SI) return false;
  if (!palabras.every((p) => AFIRMACIONES.has(p) || AFIRMACIONES_DEBILES.has(p) || RELLENO.has(p))) return false;
  return palabras.some((p) => AFIRMACIONES.has(p));
}

/**
 * ¿El ultimo mensaje del asistente es un resumen QUE PIDE CONFIRMACION («¿Es correcto?», «¿Lo confirmo?»)? Un mensaje que solo informa o que pregunta otra cosa
 * («¿Quiere agregar algo mas?», «¿a nombre de quien?») no convierte un «ok» del cliente en una confirmacion del pedido.
 */
export function resumenPideConfirmacion(texto: string): boolean {
  // Se juzga la ULTIMA pregunta del mensaje (lo que el cliente esta contestando); el aviso de privacidad del primer contacto trae palabras como «su nombre» que no cuentan.
  const preguntas = [...texto.matchAll(/[^.!?¿\n]*\?/g)].map((m) => normalizar(m[0]));
  const ultima = preguntas.at(-1);
  if (!ultima) return false;
  if (/\b(agregar|agregarle|algo mas|alguna otra|otra cosa|a nombre de|su nombre|cual es su nombre)\b/.test(ultima)) return false;
  return /\b(es correcto|esta correcto|correcto|esta bien|todo bien|asi esta bien|confirm\w*|procedo|lo registro|lo mando)\b/.test(ultima);
}

/**
 * ¿El reclamo "creando" es de OTRO turno y sigue fresco? Solo entonces se le dice al cliente «se esta registrando». Un reclamo propio que fallo en este turno, o uno
 * mas viejo que `CLAIM_STALE_MS`, no lo va a terminar nadie: ahi se escala (como sin atajo) en vez de prometer una confirmacion que nunca llega.
 */
export function reclamoFrescoDeOtroTurno(flow: OrderFlowSnapshot | null, ahoraMs: number, crearPropioFallido: boolean): boolean {
  if (!flow || flow.state !== "creando" || flow.context?.orderId) return false;
  if (crearPropioFallido) return false;
  return ahoraMs - (flow.context?.claimedAtMs ?? 0) <= CLAIM_STALE_MS;
}

/** Forma de pago que menciona un texto: `null` si ninguna, `"ambiguo"` si menciona las dos. */
export function pagoDelTexto(texto: string): "efectivo" | "tarjeta" | "ambiguo" | null {
  const t = normalizar(texto);
  const ef = /\befectivo\b/.test(t);
  const ta = /\btarjeta\b/.test(t);
  if (ef && ta) return "ambiguo";
  return ef ? "efectivo" : ta ? "tarjeta" : null;
}

/** ¿El texto trae el total en pesos de la cotizacion («$126», «$1,250.00»)? Es la prueba de que el cliente vio el resumen que va a confirmar. */
export function textoLlevaElTotal(texto: string, total: number): boolean {
  if (!Number.isFinite(total)) return false;
  const sinComas = texto.replace(/(?<=\d),(?=\d{3})/g, "");
  for (const m of sinComas.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)) {
    if (Math.abs(Number(m[1]) - total) < 0.005) return true;
  }
  return false;
}

/** Monto de «paga con $500» / «cambio de 500» del resumen, o `null`. */
export function efectivoConDelResumen(resumen: string): number | null {
  const t = resumen.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/(?<=\d),(?=\d{3})/g, "");
  const m = /(?:paga(?:ra)?\s+con|cambio\s+de)\s*\$?\s*(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Huella que el servidor guardo al cotizar, recalculada con el unico dato que no se guarda aparte (la mayoria de edad). `null` = no coincide con ninguna: la cotizacion llevaba algo que aqui no se reproduce. */
export function mayoriaDeEdadDeLaCotizacion(ctx: OrderFlowContext): boolean | null {
  if (!ctx.quotedItems || ctx.quotedItems.length === 0 || !ctx.quotedBranchSlug) return null;
  for (const adulto of [false, true]) {
    const huella = fingerprintOrder({
      branchSlug: ctx.quotedBranchSlug,
      canal: "recoger",
      adultConfirmed: adulto,
      items: itemsDeHuella(ctx.quotedItems),
      ...(ctx.horaRecogida ? { horaRecogida: ctx.horaRecogida } : {}),
    });
    if (huella === ctx.quoteHash) return adulto;
  }
  return null;
}

export interface EntradaCierre {
  /** Estado del flujo del pedido LEIDO AHORA (no el del inicio del turno). */
  readonly flow: OrderFlowSnapshot | null;
  /** Huella e instante de la cotizacion que estaba vigente al INICIO del turno: si cambiaron, el cliente ya no esta diciendo «si» a lo mismo. */
  readonly quoteHashInicial: string;
  readonly quotedAtMsInicial: number;
  /** Marcador del turno actual (numero de mensajes del cliente): la confirmacion exige un turno posterior al de la cotizacion. */
  readonly turnoActual: string;
  readonly ahoraMs: number;
  /** Nombre que YA esta en el cliente conocido (null = cliente nuevo o sin nombre: no se adivina). */
  readonly nombreConocido: string | null;
  /** Mensajes del cliente sin responder (los que dicen «si»). */
  readonly mensajesDelCliente: readonly string[];
  /** Ultimo mensaje del asistente (el resumen que el cliente vio), o null. */
  readonly ultimoResumen: string | null;
}

export type MotivoSinCierre =
  | "sin_cotizacion"
  | "cotizacion_cambio"
  | "cotizacion_vencida"
  | "no_es_recoger"
  | "mismo_turno"
  | "turno_no_inmediato"
  | "resumen_no_pide_confirmacion"
  | "si_ambiguo"
  | "resumen_sin_total"
  | "sin_nombre"
  | "nombre_no_utilizable"
  | "pago_no_claro"
  | "huella_no_reproducible";

export type PlanDeCierre = { readonly ok: true; readonly input: Record<string, unknown> } | { readonly ok: false; readonly motivo: MotivoSinCierre };

/**
 * Decide si se puede cerrar el pedido sin modelo y, si si, arma el `crear_pedido` EXACTO (los renglones salen de la cotizacion guardada, no de texto libre).
 * Alcance deliberadamente estrecho: solo RECOGER. A domicilio hace falta la direccion, la colonia/pin y la cobertura, que la cotizacion guardada no conserva: ahi se escala como antes.
 */
export function planDeCierreDeterminista(e: EntradaCierre): PlanDeCierre {
  const no = (motivo: MotivoSinCierre): PlanDeCierre => ({ ok: false, motivo });
  const ctx = e.flow?.context;
  if (!e.flow || !ctx || (e.flow.state !== "cotizado" && e.flow.state !== "confirmado")) return no("sin_cotizacion");
  if (ctx.quoteHash !== e.quoteHashInicial || ctx.quotedAtMs !== e.quotedAtMsInicial) return no("cotizacion_cambio");
  if (e.ahoraMs - ctx.quotedAtMs > QUOTE_TTL_MS) return no("cotizacion_vencida");
  if (!ctx.quotedItems || ctx.quotedItems.length === 0 || !ctx.quotedBranchSlug || typeof ctx.quotedTotal !== "number") return no("sin_cotizacion");
  if (ctx.quotedCanal !== "recoger") return no("no_es_recoger");
  if (ctx.quotedTurn === null || ctx.quotedTurn === e.turnoActual) return no("mismo_turno");
  // El «si» debe ser la respuesta al turno INMEDIATAMENTE posterior a la cotizacion: si entre la cotizacion y este «si» hubo otros mensajes del cliente (p. ej. «mejor 5
  // tacos» contestado con un resumen nuevo SIN volver a cotizar), el resumen que vio ya no es el de la cotizacion guardada aunque cite su total viejo.
  const turnosDesdeCotizar = Number(e.turnoActual) - Number(ctx.quotedTurn);
  if (!Number.isInteger(turnosDesdeCotizar) || turnosDesdeCotizar !== e.mensajesDelCliente.length) return no("turno_no_inmediato");
  if (e.mensajesDelCliente.length === 0 || !e.mensajesDelCliente.every(esSiClaroDeConfirmacion)) return no("si_ambiguo");
  if (e.ultimoResumen === null || !textoLlevaElTotal(e.ultimoResumen, ctx.quotedTotal)) return no("resumen_sin_total");
  if (e.nombreConocido === null || e.nombreConocido.trim() === "") return no("sin_nombre");
  if (!nombreDeClienteUtilizable(e.nombreConocido)) return no("nombre_no_utilizable");

  // Forma de pago: la que dice el cliente en su «si» o, si no dice, la del resumen. Dos distintas, o ninguna clara, = no se adivina.
  const delCliente = pagoDelTexto(e.mensajesDelCliente.join(" "));
  const delResumen = pagoDelTexto(e.ultimoResumen);
  if (delCliente === "ambiguo" || delResumen === "ambiguo") return no("pago_no_claro");
  if (delCliente !== null && delResumen !== null && delCliente !== delResumen) return no("pago_no_claro");
  const pago = delCliente ?? delResumen;
  if (pago === null) return no("pago_no_claro");

  if (!resumenPideConfirmacion(e.ultimoResumen)) return no("resumen_no_pide_confirmacion");
  const adulto = mayoriaDeEdadDeLaCotizacion(ctx);
  if (adulto === null) return no("huella_no_reproducible");

  const efectivoCon = pago === "efectivo" ? efectivoConDelResumen(e.ultimoResumen) : null;
  return {
    ok: true,
    input: {
      branch_slug: ctx.quotedBranchSlug,
      customer_name: e.nombreConocido.trim(),
      canal: "recoger",
      payment_method: pago,
      adult_confirmed: adulto,
      items: ctx.quotedItems.map((i) => ({ product_id: i.id, product_name: i.name, requested_quantity: i.qty, ...(i.tortilla ? { tortilla: i.tortilla } : i.tortillaKilo ? { tortilla: i.tortillaKilo } : {}) })),
      ...(efectivoCon !== null && efectivoCon >= ctx.quotedTotal ? { efectivo_con: efectivoCon } : {}),
      // Los ajustes que no entran a la huella (sin cebolla, salsas extra, indicaciones) viajan solo en el texto que el cliente vio: se dejan en la nota para la sucursal.
      notes: `Pedido cerrado automaticamente (el asistente no alcanzo a responder a tiempo). Resumen que el cliente confirmo: ${e.ultimoResumen.replace(/\s+/g, " ").trim().slice(0, 600)}`,
    },
  };
}
