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
import { idiomaDeMensaje, type Idioma } from "../idioma.ts";
import type { BranchSummary } from "../types.ts";

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

export function pendingQuestionForMissingData(branchKnown: boolean, orderId: string | null, idioma: Idioma = "es"): string | null {
  if (orderId) return null;
  if (idioma === "en") {
    if (!branchKnown) return "Could you share your neighborhood or a nearby landmark so I can find the closest branch?";
    return "What would you like to order, or is there anything else I can help you with?";
  }
  if (!branchKnown) return "¿Me comparte su colonia o una referencia cercana para ubicar la sucursal más cercana?";
  return "¿Qué le gustaría pedir, o hay algo más en lo que le pueda ayudar?";
}

export function enforcePendingQuestion(reply: string, branchKnown: boolean, orderId: string | null, idioma: Idioma = "es"): string {
  const trimmed = reply.trim();
  if (/[?¿]/.test(trimmed)) return reply;
  const pending = pendingQuestionForMissingData(branchKnown, orderId, idioma);
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

// El orden importa: lo mas delicado primero (alergia / cobro / privacidad) para que un mensaje que
// mezcla varios motivos se atienda por el de mayor riesgo.
const HIGH_RISK_PATTERNS: ReadonlyArray<{ intent: HighRiskIntent; pattern: RegExp; patternEn: RegExp; reply: string; replyEn: string }> = [
  {
    intent: "alergia_salud",
    pattern: /\b(?:al[eé]rgic[oa]s?|alergias?|intolerante|intolerancia|celiaco|cel[ií]aca|cacahuate|gluten)\b/i,
    reply:
      "Por su seguridad no puedo asegurarle los ingredientes de un platillo ni si es apto para una alergia. Ya avisé al equipo del restaurante para que le confirme directamente antes de hacer su pedido.",
    patternEn: /\b(?:allerg(?:ic|y|ies)|intoleran(?:t|ce)|celiac|coeliac|gluten|peanuts?|anaphyla\w+)\b/i,
    replyEn: "For your safety I can't guarantee the ingredients of a dish or whether it is safe for an allergy. I've already alerted the restaurant team so they can confirm directly with you before you place your order.",
  },
  {
    intent: "cobro_duplicado",
    pattern: /cobr(?:o|aron|é)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces/i,
    reply: "Lamento el problema con el cobro. Ya avisé al equipo para que revise su caso directamente y lo contacte lo antes posible.",
    patternEn: /\b(?:charged|billed)\s+(?:me\s+)?(?:twice|double|two\s+times)\b|\bdouble[-\s]charge[d]?\b|\bduplicate\s+charge\b|\bovercharg\w+\b/i,
    replyEn: "I'm sorry about the charge problem. I've already alerted the team so they can review your case directly and contact you as soon as possible.",
  },
  {
    intent: "privacidad_arco",
    pattern:
      /\b(?:borr(?:ar|en|e|a|ame)|elimin(?:ar|en|e|a|ame))\s+(?:todos\s+)?(?:mis|los)\s+datos\b|\bderechos?\s+arco\b|\barco\b.{0,20}\bdatos\b|\bmis\s+datos\s+personales\b.{0,30}\b(?:borrar|eliminar|acceder|rectificar|corregir)\b/i,
    reply:
      "Recibido. Para ejercer sus derechos ARCO (acceso, rectificación, cancelación u oposición) sobre sus datos, ya avisé al equipo para que lo contacte y gestione su solicitud directamente.",
    patternEn: /\b(?:delete|erase|remove)\s+(?:all\s+)?(?:of\s+)?my\s+(?:personal\s+)?(?:data|information)\b|\bmy\s+personal\s+(?:data|information)\b|\bprivacy\s+rights?\b|\bdata\s+(?:deletion|access|rectification)\s+request\b/i,
    replyEn: "Understood. To exercise your data rights (access, rectification, cancellation or objection) I've already alerted the team so they can contact you and handle your request directly.",
  },
  {
    intent: "cancelacion_modificacion",
    pattern:
      /\bcancel(?:ar|o|a|e|en)\b[^.!?\n]{0,40}\b(?:pedido|orden|comanda)\b|\b(?:pedido|orden|comanda)\b[^.!?\n]{0,40}\bcancel(?:ar|o|a|e|en)\b|\bcancelarme\s+(?:el|mi)\s+pedido\b/i,
    reply:
      "Entendido, desea cancelar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
    patternEn: /\bcancel(?:l?ing|led)?\b[^.!?\n]{0,40}\b(?:order|ticket)\b|\b(?:order|ticket)\b[^.!?\n]{0,40}\bcancel\w*\b/i,
    replyEn: "Understood, you would like to cancel your order. Only someone at the restaurant can confirm that directly, because it depends on whether it has already started to be prepared. I've already alerted the team so they can contact you as soon as possible.",
  },
  {
    intent: "transferencia",
    pattern: /\btransferencia\b|\bdep[oó]sito\b|\bspei\b|\bpagar\s+por\s+transfer/i,
    reply:
      "Por este medio no puedo registrar pagos por transferencia. Ya avisé al equipo para que lo contacte y vea con usted esa forma de pago; si prefiere, puede pagar en efectivo o con tarjeta.",
    patternEn: /\b(?:bank|wire)\s+transfer\b|\bspei\b|\b(?:zelle|venmo|paypal)\b|\bdeposit\b|\bpay\s+(?:by|via|with)\s+transfer\b/i,
    replyEn: "I can't register payments by bank transfer here. I've already alerted the team so they can contact you and sort out that payment method; if you prefer, you can pay with cash or card.",
  },
  {
    intent: "queja",
    pattern: /\bqueja\b|\blleg[oó]\s+(?:fr[ií]o|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bme\s+falt[oó]\b|\bmal\s+armado\b/i,
    reply: "Lamento mucho lo ocurrido. Ya avisé al gerente para que revise su caso y lo contacte directamente; yo no puedo prometerle una reposición ni un descuento.",
    patternEn: /\bcomplain(?:t|ing)?\b|\b(?:arrived|came|was|got)\s+(?:cold|incomplete|wrong|late)\b|\bwrong\s+order\b|\bmissing\s+(?:items?|food|tacos?)\b|\b(?:order|food)\s+(?:was|is)\s+(?:cold|late|wrong|incomplete)\b|\bnever\s+arrived\b/i,
    replyEn: "I'm very sorry about what happened. I've already alerted the manager so they can review your case and contact you directly; I can't promise a replacement or a discount.",
  },
  {
    intent: "urgencia",
    pattern: /\burgen(?:te|cia)\b/i,
    reply: "Entendido, es urgente. Ya avisé al equipo para que lo contacte de inmediato.",
    patternEn: /\burgent(?:ly)?\b|\bemergency\b/i,
    replyEn: "Understood, it's urgent. I've already alerted the team so they can contact you right away.",
  },
  {
    intent: "cliente_lo_pide",
    pattern: /\b(?:hablar|comunicar(?:me)?|pasar(?:me)?|conectar(?:me)?)\s+con\s+(?:una\s+|un\s+)?(?:persona|humano|gerente|encargad[oa]|alguien|asesor|agente)\b|\bquiero\s+(?:una\s+|un\s+)?(?:persona|humano)\b/i,
    reply: "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
    patternEn: /\b(?:speak|talk|connect|transfer|put)\s+(?:me\s+)?(?:to|with|through\s+to)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:real\s+)?(?:person|human|manager|someone|somebody|agent|representative|employee|staff)\b|\bI\s+(?:want|need|would\s+like)\s+(?:a\s+|an\s+)?(?:real\s+)?(?:person|human)\b|\bcustomer\s+service\b/i,
    replyEn: "Of course. I've already alerted the restaurant team so a person can contact you as soon as possible.",
  },
];

/** Pura: que motivo de alto riesgo detecta el texto entrante del cliente, si alguno. Prueba los patrones de AMBOS idiomas (un cliente
 * puede mezclar: "cancel mi pedido"); `idioma` solo decide en que idioma se redacta la respuesta fija (por omision, el del propio
 * mensaje y, si es ambiguo, espanol). */
export function classifyHighRiskIntent(text: string, idioma?: Idioma): HighRiskMatch | null {
  const lang = idioma ?? idiomaDeMensaje(text) ?? "es";
  for (const { intent, pattern, patternEn, reply, replyEn } of HIGH_RISK_PATTERNS) {
    if (pattern.test(text) || patternEn.test(text)) return { intent, motivo: intent, reply: lang === "en" ? replyEn : reply };
  }
  return null;
}

/** Pura: ¿el texto dispara algun motivo de alto riesgo DISTINTO de `excepto`? (aunque otro de mayor
 * prioridad en el orden de arriba tambien coincida). */
export function matchesHighRiskOtherThan(text: string, excepto: HighRiskIntent): boolean {
  return HIGH_RISK_PATTERNS.some(({ intent, pattern, patternEn }) => intent !== excepto && (pattern.test(text) || patternEn.test(text)));
}
