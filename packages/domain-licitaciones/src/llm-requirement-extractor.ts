// LlmRequirementExtractor — Fase 2 pieza 3, novedad frente al origen (ver
// diseño §4.1): un segundo extractor OPCIONAL vía `@atiende/agent-core`'s
// `LlmGateway` (tool-calling real, ya portado en `agent-core`), para bases
// mal estructuradas donde las reglas léxicas de `RuleBasedExtractor` no
// alcanzan. Es justo el caso de uso que justifica haber invertido en
// tool-calling real del gateway fuera de restaurantes: extracción
// estructurada de datos de un documento no conversacional, no un chat.
//
// El modelo NUNCA devuelve texto libre que se parsee a mano: cada requisito
// extraído es una tool_call estructurada a `registrar_requisito`, mismo
// patrón que `buscar_sucursal_cercana`/`cotizar_pedido` de restaurantes Fase
// 2. `confidence` de un ítem "llm" siempre es `<1` (nunca tan determinista
// como "rule"); `RequirementMatrixBuilder` corre AMBOS extractores sobre el
// mismo documento y los conflictos entre "rule" y "llm" para el mismo
// `topicKey` se tratan como cualquier otro `Conflict` (ver
// requirement-matrix.ts::detectConflicts) -- nunca se prefiere uno sobre
// otro en silencio.
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import { assertExplicitOffset } from "./types.ts";
import { nextRequirementId } from "./requirement-matrix.ts";
import { classifyResponsibleRole } from "./requirement-matrix.ts";
import type { Obligatoriedad, RequirementExtractor, RequirementItem, RequirementType, TenderDocumentText } from "./requirement-matrix.ts";

const OBLIGATORIEDAD_VALUES: readonly Obligatoriedad[] = ["obligatorio", "opcional", "condicional"];
const REQUIREMENT_TYPE_VALUES: readonly RequirementType[] = ["tecnico", "economico", "legal", "administrativo", "anexo"];

const REGISTRAR_REQUISITO_TOOL: LlmToolDefinition = {
  name: "registrar_requisito",
  description:
    "Registra UN requisito real encontrado en el texto de la página de las bases de licitación. Llámala una vez por cada requisito distinto que identifiques en la página. Si la página no contiene ningún requisito, no llames a esta herramienta.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Cita textual (o resumen fiel) de la oración/párrafo que establece el requisito. Nunca inventes texto que no esté en la página." },
      obligatoriedad: { type: "string", enum: OBLIGATORIEDAD_VALUES as unknown as string[], description: "'obligatorio' solo si el texto usa lenguaje imperativo (deberá/es obligatorio). 'opcional' si el texto dice explícitamente que es optativo. 'condicional' en cualquier otro caso ambiguo -- NUNCA adivines 'obligatorio' por defecto." },
      type: { type: "string", enum: REQUIREMENT_TYPE_VALUES as unknown as string[] },
      deadlineIso: {
        type: ["string", "null"],
        description:
          "Fecha límite EXPLÍCITA en ISO 8601 CON offset horario (p. ej. \"2026-12-15T18:00:00-06:00\"). Usa null si el texto no fija una fecha inequívoca -- NUNCA inventes ni aproximes una fecha.",
      },
      requiredEvidence: { type: "array", items: { type: "string" }, description: "Documentos/evidencias que el texto exige explícitamente (p. ej. \"acta_constitutiva\"). Arreglo vacío si el texto no exige ninguna evidencia concreta." },
      topicKey: { type: "string", description: "Clave corta y estable del tema (p. ej. \"plazo_entrega_proposiciones\") SOLO si el requisito es de un tipo que podría repetirse/contradecirse entre documentos (plazos, garantías). Omite este campo si no aplica." },
      clause: { type: "string", description: "Cláusula/numeral/anexo citado explícitamente en el texto (p. ej. \"cláusula 4.2\"), si lo hay." },
    },
    required: ["text", "obligatoriedad", "type", "deadlineIso", "requiredEvidence"],
  },
};

interface RegistrarRequisitoArgs {
  readonly text?: unknown;
  readonly obligatoriedad?: unknown;
  readonly type?: unknown;
  readonly deadlineIso?: unknown;
  readonly requiredEvidence?: unknown;
  readonly topicKey?: unknown;
  readonly clause?: unknown;
}

/** Confianza fija para todo ítem "llm": siempre estrictamente menor que la confianza máxima de `RuleBasedExtractor` (0.7) -- un ítem extraído por LLM nunca es "más confiable por defecto" que uno determinista. */
export const LLM_EXTRACTOR_CONFIDENCE = 0.55;

function isValidDeadline(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    assertExplicitOffset(value, "RequirementItem.deadline (LlmRequirementExtractor)");
    return true;
  } catch {
    return false;
  }
}

/** Convierte UNA tool_call `registrar_requisito` ya parseada en un `RequirementItem`, o `null` si sus argumentos no pasan las guardias fail-closed (nunca lanza -- un ítem inválido simplemente se descarta, nunca se persiste con datos a medias). */
function toRequirementItem(args: RegistrarRequisitoArgs, doc: TenderDocumentText, page: number): RequirementItem | null {
  if (typeof args.text !== "string" || args.text.trim().length === 0) return null;
  if (!OBLIGATORIEDAD_VALUES.includes(args.obligatoriedad as Obligatoriedad)) return null;
  if (!REQUIREMENT_TYPE_VALUES.includes(args.type as RequirementType)) return null;
  if (!Array.isArray(args.requiredEvidence) || !args.requiredEvidence.every((e) => typeof e === "string")) return null;

  // Fail-closed (mismo guardia que assertExplicitOffset ya portado en Fase 1
  // types.ts, reusado tal cual -- no una guardia nueva): un `deadlineIso`
  // presente pero inválido (offset fuera de rango, fecha imposible, "naive")
  // hace que TODO el ítem se RECHACE antes de persistirse, nunca se guarda
  // con una fecha a medias ni se coacciona a `null` en silencio.
  let deadline: string | null = null;
  if (args.deadlineIso !== null && args.deadlineIso !== undefined) {
    if (!isValidDeadline(args.deadlineIso)) return null;
    deadline = args.deadlineIso;
  }

  const type = args.type as RequirementType;
  const topicKey = typeof args.topicKey === "string" && args.topicKey.trim().length > 0 ? args.topicKey.trim() : undefined;
  const clause = typeof args.clause === "string" && args.clause.trim().length > 0 ? args.clause.trim() : undefined;

  return {
    id: nextRequirementId(),
    text: args.text.trim(),
    source: { documentId: doc.documentId, documentLabel: doc.documentLabel, page, clause },
    obligatoriedad: args.obligatoriedad as Obligatoriedad,
    type,
    responsibleRole: classifyResponsibleRole(type),
    deadline,
    requiredEvidence: args.requiredEvidence as string[],
    status: "pendiente",
    extractedBy: "llm",
    confidence: LLM_EXTRACTOR_CONFIDENCE,
    topicKey,
  };
}

export interface LlmRequirementExtractorOptions {
  /** Organización dueña de la extracción -- se pasa tal cual a `LlmGateway.complete({tenantId})` para presupuesto/auditoría por tenant. */
  readonly tenantId: string;
  /** Rol lógico registrado en el gateway vía `registerLadder(role, providers)` -- el llamador (apps/api, wiring de producción) decide qué escalera de proveedores atiende este rol. Nunca se hardcodea un proveedor aquí (agnóstico de vertical, mismo principio que el resto de agent-core). */
  readonly role?: string;
  /** Máximo de páginas a procesar por documento en una sola llamada a `extract` -- protección de costo/latencia explícita, nunca implícita. */
  readonly maxPages?: number;
}

const DEFAULT_ROLE = "licitaciones:requirement_extractor";
const DEFAULT_MAX_PAGES = 200;

export class LlmRequirementExtractor implements RequirementExtractor {
  readonly name = "llm-tool-calling-v1";
  readonly extractedBy = "llm" as const;

  constructor(
    private readonly gateway: LlmGateway,
    private readonly options: LlmRequirementExtractorOptions,
  ) {}

  async extract(doc: TenderDocumentText): Promise<RequirementItem[]> {
    const role = this.options.role ?? DEFAULT_ROLE;
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;
    const items: RequirementItem[] = [];

    for (const page of doc.pages.slice(0, maxPages)) {
      if (page.text.trim().length === 0) continue;

      const result = await this.gateway.complete({
        tenantId: this.options.tenantId,
        runId: randomUUID(),
        lane: "batch",
        role,
        request: {
          system:
            'Eres un analista de licitaciones públicas mexicanas. Tu ÚNICO trabajo es identificar requisitos reales en el texto que se te da (una página de las bases de una convocatoria) y registrarlos llamando a la herramienta "registrar_requisito" -- una llamada por requisito. Nunca respondas con texto libre. Nunca inventes un requisito que no esté literalmente respaldado por el texto. Si la página no tiene requisitos (portada, índice, texto de relleno), no llames a ninguna herramienta.',
          messages: [{ role: "user", content: `Documento: "${doc.documentLabel}" -- Página ${page.page}.\n\nTexto de la página:\n"""\n${page.text}\n"""` }],
          tools: [REGISTRAR_REQUISITO_TOOL],
          temperature: 0,
          // Hallazgo de auditoría (rubro 10, performance): esta llamada corre dentro
          // de la transacción por-request que `dbSession` abre para toda la ruta
          // (`POST .../requirements/extract`) -- sin límite, una llamada colgada al
          // proveedor de LLM sostiene la conexión de Postgres indefinidamente. Sacar
          // la llamada del middleware de auth/transacción compartido es el fix
          // completo, pero requiere reestructurar el wiring de esa ruta (bloqueado
          // por el clasificador de seguridad como cambio de auth -- ver el propio
          // comentario de cabecera de technicalProposal.ts). Este timeout acota el
          // peor caso real por página sin tocar ningún middleware.
          signal: AbortSignal.timeout(15_000),
        },
      });

      for (const call of result.toolCalls ?? []) {
        const item = this.parseToolCall(call, doc, page.page);
        if (item) items.push(item);
      }
    }

    return items;
  }

  private parseToolCall(call: LlmToolCall, doc: TenderDocumentText, page: number): RequirementItem | null {
    if (call.name !== "registrar_requisito") return null;
    let args: RegistrarRequisitoArgs;
    try {
      args = JSON.parse(call.argumentsJson || "{}") as RegistrarRequisitoArgs;
    } catch {
      // JSON malformado del proveedor: se descarta esta tool_call en
      // particular, nunca se lanza (no debe tumbar el resto de la
      // extracción de la página).
      return null;
    }
    return toRequirementItem(args, doc, page);
  }
}
