// Guardias DETERMINISTAS del agente de WhatsApp: logica que antes dependia solo del prompt y
// que el repo original ya habia endurecido tras bugs reales (X05, X06, X37). Se portan aqui,
// al trato de USTED que exige el dueno (P26), sin tocar el loop de tool-use.
//
//   * enforceQuotedTotal      -- el texto libre del modelo puede alucinar un total distinto al
//                                que devolvio cotizar_pedido (el cobro era correcto, el cliente
//                                leia otra cifra). Reescribe la cifra junto a la palabra "total".
//   * enforcePendingQuestion  -- un turno que termina sin herramienta ni pregunta ("voy a
//                                revisar") deja al cliente esperando; se anexa la pregunta del
//                                paso pendiente.
//   * classifyHighRiskIntent  -- cancelacion, cobro duplicado, urgencia, ARCO, transferencia,
//                                alergia, queja o "quiero hablar con una persona" NO se dejan al
//                                criterio del modelo: se intercepta ANTES del LLM, se registra el
//                                aviso al equipo y se responde un texto fijo y honesto (el
//                                agente no puede cancelar ni cobrar nada).
import type { PedidoReciente } from "../pedido-reciente.ts";
import type { BranchSummary, CustomerLookupResult } from "../types.ts";

const MONEY_TOKEN = "\\$\\s?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?\\s*pesos\\b";
const TOTAL_WITH_MONEY = new RegExp(`(total[^$\\d]{0,40})(${MONEY_TOKEN})`, "gi");

function parseMoneyToken(token: string): number {
  return Number(token.replace(/[^\d.]/g, ""));
}

/** Corrige cualquier cifra que acompane a la palabra "total" para que coincida con el ultimo total
 * REAL (cotizar_pedido / crear_pedido). No toca precios unitarios ni montos sin la palabra "total". */
export function enforceQuotedTotal(reply: string, lastQuoteTotal: number | null): string {
  if (lastQuoteTotal === null || !Number.isFinite(lastQuoteTotal)) return reply;
  return reply.replace(TOTAL_WITH_MONEY, (full: string, prefix: string, moneyToken: string) => {
    const stated = parseMoneyToken(moneyToken);
    if (!Number.isFinite(stated) || Math.abs(stated - lastQuoteTotal) < 0.01) return full;
    return `${prefix}$${lastQuoteTotal.toFixed(2)}`;
  });
}

export function pendingQuestionForMissingData(branchKnown: boolean, orderId: string | null): string | null {
  if (orderId) return null;
  if (!branchKnown) return "¿Me comparte su colonia o una referencia cercana para ubicar la sucursal más cercana?";
  return "¿Qué le gustaría pedir, o hay algo más en lo que le pueda ayudar?";
}

export function enforcePendingQuestion(reply: string, branchKnown: boolean, orderId: string | null): string {
  const trimmed = reply.trim();
  if (/[?¿]/.test(trimmed)) return reply;
  const pending = pendingQuestionForMissingData(branchKnown, orderId);
  if (!pending) return reply;
  return trimmed ? `${trimmed} ${pending}` : pending;
}

/** La sucursal ya quedo resuelta en la conversacion si entro por el numero de una sucursal o si algun
 * mensaje previo del asistente la nombra (el historial persistido solo guarda texto). */
export function branchAlreadyKnown(entryBranchName: string | null, assistantTexts: readonly string[], branches: readonly BranchSummary[]): boolean {
  if (entryBranchName) return true;
  const names = branches.map((b) => b.name.toLowerCase());
  return assistantTexts.some((text) => names.some((name) => text.toLowerCase().includes(name)));
}

export type HighRiskIntent = "cancelacion_modificacion" | "cobro_duplicado" | "urgencia" | "privacidad_arco" | "transferencia" | "alergia_salud" | "queja" | "cliente_lo_pide";

export interface HighRiskMatch {
  readonly intent: HighRiskIntent;
  /** Motivo tipificado para `escalar_a_humano` (mismo valor que el intent). */
  readonly motivo: HighRiskIntent;
  readonly reply: string;
}

/** Lo que el clasificador necesita saber del cliente para NO confundir un ajuste del carrito con una cancelacion o una queja. */
export interface HighRiskContext {
  /** Pedido de las ultimas 12 h de este telefono: `null` = no hay; ausente = desconocido (cliente nuevo o lectura no disponible). */
  readonly pedidoReciente?: PedidoReciente | null;
}

/** Texto comparable: minusculas y sin acentos. Asi "faltó" y "falto" son lo mismo (con `\b` y sin acentos el resultado ya no depende de si el cliente acentuó). */
export function normalizarParaClasificar(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Verbo en infinitivo (con o sin clitico): "me falto pedir", "me falto pedirle", "me falto agregar". Es el habla de quien SE OLVIDO de pedir algo
// (ajuste del carrito), nunca una queja por algo que no llego.
const INFINITIVO = "[a-z]{2,}(?:ar|er|ir)(?:le|les|me|se|lo|la|los|las|selo)?";
// Cambio de opinion sobre lo que se esta armando ("mejor ponme", "en vez de", "cambialo por").
const CORRECCION_DE_CARRITO = /\bmejor\b|\ben\s+(?:vez|lugar)\s+de\b|\bponme\b|\bponmanos\b|\bcambi(?:a|ame|alo|ala)\b/;
// El mensaje habla del pedido que YA existe (no de uno que se esta armando).
const HABLA_DE_SU_PEDIDO = /\b(?:mi|su|el|ese|este)\s+pedido\b|\bmi\s+orden\b|\bya\s+(?:viene|sale|salio|llego|casi)\b|\bcuanto\s+(?:tarda|falta|se\s+tarda)\b/;
const ME_FALTO = new RegExp(`\\bme\\s+falto\\b\\s*(?<resto>.*)$`);

interface Patron {
  readonly intent: HighRiskIntent;
  readonly pattern: RegExp;
  readonly reply: string;
  /** Condicion adicional sobre el texto normalizado y el contexto del cliente (ausente = basta el patron). */
  readonly cuando?: (texto: string, ctx: HighRiskContext) => boolean;
}

// El orden importa: lo mas delicado primero (alergia / cobro / privacidad) para que un mensaje que
// mezcla varios motivos se atienda por el de mayor riesgo. Los patrones corren sobre texto SIN acentos.
const HIGH_RISK_PATTERNS: readonly Patron[] = [
  {
    intent: "alergia_salud",
    pattern: /\b(?:alergic[oa]s?|alergias?|intolerante|intolerancia|celiac[oa]|cacahuate|gluten)\b/,
    reply:
      "Por su seguridad no puedo asegurarle los ingredientes de un platillo ni si es apto para una alergia. Ya avisé al equipo del restaurante para que le confirme directamente antes de hacer su pedido.",
  },
  {
    intent: "cobro_duplicado",
    pattern: /cobr(?:o|aron|e)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces/,
    reply: "Lamento el problema con el cobro. Ya avisé al equipo para que revise su caso directamente y lo contacte lo antes posible.",
  },
  {
    intent: "privacidad_arco",
    pattern:
      /\b(?:borr(?:ar|en|e|a|ame)|elimin(?:ar|en|e|a|ame))\s+(?:todos\s+)?(?:mis|los)\s+datos\b|\bderechos?\s+arco\b|\barco\b.{0,20}\bdatos\b|\bmis\s+datos\s+personales\b.{0,30}\b(?:borrar|eliminar|acceder|rectificar|corregir)\b/,
    reply:
      "Recibido. Para ejercer sus derechos ARCO (acceso, rectificación, cancelación u oposición) sobre sus datos, ya avisé al equipo para que lo contacte y gestione su solicitud directamente.",
  },
  {
    // Solo "pedido": "orden" y "comanda" son UNIDADES del menu ("cancela la orden de bistec" corrige el carrito). Si ademas es un cambio de
    // opinion y el telefono no tiene un pedido ya creado, es el carrito y va al agente; un pedido ya creado SI justifica el aviso al equipo.
    intent: "cancelacion_modificacion",
    pattern: /\bcancel(?:ar|o|a|e|en)\b[^.!?\n]{0,40}\bpedido\b|\bpedido\b[^.!?\n]{0,40}\bcancel(?:ar|o|a|e|en)\b|\bcancelarme\s+(?:el|mi)\s+pedido\b/,
    cuando: (texto, ctx) => !CORRECCION_DE_CARRITO.test(texto) || (ctx.pedidoReciente ?? null) !== null,
    reply:
      "Entendido, desea cancelar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
  },
  {
    intent: "transferencia",
    pattern: /\btransferencia\b|\bdeposito\b|\bspei\b|\bpagar\s+por\s+transfer/,
    reply:
      "Por este medio no puedo registrar pagos por transferencia. Ya avisé al equipo para que lo contacte y vea con usted esa forma de pago; si prefiere, puede pagar en efectivo o con tarjeta.",
  },
  {
    intent: "queja",
    pattern: /\bqueja\b|\bllego\s+(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bme\s+falto\b|\bmal\s+armado\b/,
    // "me falto" es queja solo si habla de algo que NO llego ("me falto la bebida de mi pedido"); "me falto pedir otra coca" es el carrito.
    cuando: (texto, ctx) => {
      if (!/\bme\s+falto\b/.test(texto)) return true;
      if (/\bqueja\b|\bllego\s+(?:frio|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bmal\s+armado\b/.test(texto)) return true;
      const resto = ME_FALTO.exec(texto)?.groups?.resto ?? "";
      if (new RegExp(`^(?:a\\s+)?${INFINITIVO}\\b`).test(resto)) return false;
      const estado = ctx.pedidoReciente?.estado;
      return estado === "entregado" || estado === "salio" || HABLA_DE_SU_PEDIDO.test(texto);
    },
    reply: "Lamento mucho lo ocurrido. Ya avisé al gerente para que revise su caso y lo contacte directamente; yo no puedo prometerle una reposición ni un descuento.",
  },
  {
    // "urgente" como enfasis de un pedido nuevo ("medio kilo de pastor, lo necesito urgente") NO es una emergencia: solo escala cuando habla del pedido que ya existe.
    intent: "urgencia",
    pattern: /\burgen(?:te|cia)\b/,
    cuando: (texto) => HABLA_DE_SU_PEDIDO.test(texto),
    reply: "Entendido, es urgente. Ya avisé al equipo para que lo contacte de inmediato.",
  },
  {
    intent: "cliente_lo_pide",
    pattern: /\b(?:hablar|comunicar(?:me)?|pasar(?:me)?|conectar(?:me)?)\s+con\s+(?:una\s+|un\s+)?(?:persona|humano|gerente|encargad[oa]|alguien|asesor|agente)\b|\bquiero\s+(?:una\s+|un\s+)?(?:persona|humano)\b/,
    reply: "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
  },
];

/** Contexto de riesgo a partir de la ficha del cliente (la que ya trae el turno). */
export function contextoDeCliente(customer: CustomerLookupResult): HighRiskContext {
  return customer.isNew ? {} : { pedidoReciente: customer.pedidoReciente };
}

function coincide(p: Patron, texto: string, ctx: HighRiskContext): boolean {
  return p.pattern.test(texto) && (p.cuando ? p.cuando(texto, ctx) : true);
}

/** Pura: que motivo de alto riesgo detecta el texto entrante del cliente, si alguno. */
export function classifyHighRiskIntent(text: string, ctx: HighRiskContext = {}): HighRiskMatch | null {
  const texto = normalizarParaClasificar(text);
  for (const p of HIGH_RISK_PATTERNS) {
    if (coincide(p, texto, ctx)) return { intent: p.intent, motivo: p.intent, reply: p.reply };
  }
  return null;
}

/** Pura: ¿el texto dispara algun motivo de alto riesgo DISTINTO de `excepto`? (aunque otro de mayor
 * prioridad en el orden de arriba tambien coincida). */
export function matchesHighRiskOtherThan(text: string, excepto: HighRiskIntent, ctx: HighRiskContext = {}): boolean {
  const texto = normalizarParaClasificar(text);
  return HIGH_RISK_PATTERNS.some((p) => p.intent !== excepto && coincide(p, texto, ctx));
}
