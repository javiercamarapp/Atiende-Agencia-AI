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

// El orden importa: lo mas delicado primero (alergia / cobro / privacidad) para que un mensaje que
// mezcla varios motivos se atienda por el de mayor riesgo.
const HIGH_RISK_PATTERNS: ReadonlyArray<{ intent: HighRiskIntent; pattern: RegExp; reply: string }> = [
  {
    intent: "alergia_salud",
    pattern: /\b(?:al[eé]rgic[oa]s?|alergias?|intolerante|intolerancia|celiaco|cel[ií]aca|cacahuate|gluten)\b/i,
    reply:
      "Por su seguridad no puedo asegurarle los ingredientes de un platillo ni si es apto para una alergia. Ya avisé al equipo del restaurante para que le confirme directamente antes de hacer su pedido.",
  },
  {
    intent: "cobro_duplicado",
    pattern: /cobr(?:o|aron|é)\s+(?:dos\s+veces|doble|duplicado)|cobro\s+duplicado|me\s+cobraron\s+dos\s+veces/i,
    reply: "Lamento el problema con el cobro. Ya avisé al equipo para que revise su caso directamente y lo contacte lo antes posible.",
  },
  {
    intent: "privacidad_arco",
    pattern:
      /\b(?:borr(?:ar|en|e|a|ame)|elimin(?:ar|en|e|a|ame))\s+(?:todos\s+)?(?:mis|los)\s+datos\b|\bderechos?\s+arco\b|\barco\b.{0,20}\bdatos\b|\bmis\s+datos\s+personales\b.{0,30}\b(?:borrar|eliminar|acceder|rectificar|corregir)\b/i,
    reply:
      "Recibido. Para ejercer sus derechos ARCO (acceso, rectificación, cancelación u oposición) sobre sus datos, ya avisé al equipo para que lo contacte y gestione su solicitud directamente.",
  },
  {
    intent: "cancelacion_modificacion",
    pattern:
      /\bcancel(?:ar|o|a|e|en)\b[^.!?\n]{0,40}\b(?:pedido|orden|comanda)\b|\b(?:pedido|orden|comanda)\b[^.!?\n]{0,40}\bcancel(?:ar|o|a|e|en)\b|\bcancelarme\s+(?:el|mi)\s+pedido\b/i,
    reply:
      "Entendido, desea cancelar su pedido. Eso solo lo puede confirmar alguien del restaurante directamente, porque depende de si ya se empezó a preparar. Ya avisé al equipo para que lo contacte lo antes posible.",
  },
  {
    intent: "transferencia",
    pattern: /\btransferencia\b|\bdep[oó]sito\b|\bspei\b|\bpagar\s+por\s+transfer/i,
    reply:
      "Por este medio no puedo registrar pagos por transferencia. Ya avisé al equipo para que lo contacte y vea con usted esa forma de pago; si prefiere, puede pagar en efectivo o con tarjeta.",
  },
  {
    intent: "queja",
    pattern: /\bqueja\b|\blleg[oó]\s+(?:fr[ií]o|incompleto|mal|tarde)\b|\bpedido\s+(?:incompleto|mal\s+armado)\b|\bme\s+falt[oó]\b|\bmal\s+armado\b/i,
    reply: "Lamento mucho lo ocurrido. Ya avisé al gerente para que revise su caso y lo contacte directamente; yo no puedo prometerle una reposición ni un descuento.",
  },
  {
    intent: "urgencia",
    pattern: /\burgen(?:te|cia)\b/i,
    reply: "Entendido, es urgente. Ya avisé al equipo para que lo contacte de inmediato.",
  },
  {
    intent: "cliente_lo_pide",
    pattern: /\b(?:hablar|comunicar(?:me)?|pasar(?:me)?|conectar(?:me)?)\s+con\s+(?:una\s+|un\s+)?(?:persona|humano|gerente|encargad[oa]|alguien|asesor|agente)\b|\bquiero\s+(?:una\s+|un\s+)?(?:persona|humano)\b/i,
    reply: "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.",
  },
];

/** Pura: que motivo de alto riesgo detecta el texto entrante del cliente, si alguno. */
export function classifyHighRiskIntent(text: string): HighRiskMatch | null {
  for (const { intent, pattern, reply } of HIGH_RISK_PATTERNS) {
    if (pattern.test(text)) return { intent, motivo: intent, reply };
  }
  return null;
}

/** Pura: ¿el texto dispara algun motivo de alto riesgo DISTINTO de `excepto`? (aunque otro de mayor
 * prioridad en el orden de arriba tambien coincida). */
export function matchesHighRiskOtherThan(text: string, excepto: HighRiskIntent): boolean {
  return HIGH_RISK_PATTERNS.some(({ intent, pattern }) => intent !== excepto && pattern.test(text));
}
