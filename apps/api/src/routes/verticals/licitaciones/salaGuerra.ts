// L-04 -- licitacionesSalaGuerraRoutes: sala de guerra por convocatoria (tablero de
// preparacion, bitacora de decisiones, comentarios y tareas) y preguntas de la junta
// de aclaraciones (captura, deduplicacion, priorizacion, borrador asistido por IA,
// estados borrador/aprobada/enviada/respondida y vinculo a la respuesta del acta).
//
// NO envia nada a ningun portal (ComprasMX ni otro): "enviada" la marca un humano a
// mano, despues de presentar la pregunta por el canal oficial de la convocante. Las
// decisiones de go/no-go ya viven en `.../go-no-go`; aqui solo se muestran.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (migracion 029 pendiente): el repositorio
// lanza `SalaGuerraNotAvailableError` (dentro de SAVEPOINT, la transaccion del request
// sigue sana). Las lecturas responden 200 con `available: false` y datos vacios (el
// tablero igual muestra los requisitos y las decisiones go/no-go que SI existen
// antes de la migracion); las escrituras responden 503, nunca 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, ApiError } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  DECISION_ROLES,
  DraftAgentGenerationFailedError,
  DraftAgentNoProposalError,
  DraftAgentRoleNotAllowedError,
  BITACORA_DEFAULT_LIMIT,
  BITACORA_FUENTES,
  BITACORA_MAX_LIMIT,
  GO_NO_GO_ROLES,
  GuardrailBlockedError,
  JuntaQuestionDraftAgent,
  JuntaQuestionDuplicateError,
  JuntaQuestionRejectedError,
  SalaGuerraNotAvailableError,
  SalaGuerraValidationError,
  PackageAssembler,
  WRITE_ROLES,
  assertQuestionEditable,
  assertQuestionTransition,
  buildBitacoraEventos,
  buildJuntaSummary,
  buildWarRoomBoard,
  evaluarGateSalaGuerra,
  evaluateExpedienteStages,
  isBitacoraFuente,
  paginarBitacora,
  resolveGateTimeZone,
  verifyZipAgainstStoredManifest,
  findSimilarQuestions,
  parseJuntaConfig,
  parseQuestionCapture,
  parseQuestionPatch,
  parseTransitionRequest,
  parseWarRoomEntryCreate,
  parseWarRoomItemCreate,
  parseWarRoomItemPatch,
  questionDedupeKey,
  sortJuntaQuestions,
  suggestQuestionPriority,
  describirPlazo,
} from "@atiende/domain-licitaciones";
import type { GateApprovalsInput, GatePackageInput, GateZipCheck, JuntaQuestionRecord, LicitacionesRole, SalaGuerraRepository, TenderAuditLogEntry, WarRoomItemRecord } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveCalendarioFor } from "./calendario.ts";
import { buildAssembleInput } from "./cierre.ts";

type Ctx = Context<CoreAuthHonoEnv>;

/** Parametro de ruta con forma de UUID: evita que `items/import-requirements` o `questions/draft` caigan en las rutas con `:id` (y que el middleware de sesion corra dos veces). */
const UUID_PARAM = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Traduce los errores de dominio de esta pieza a HTTP; cualquier otro error se repropaga tal cual. */
function mapSalaError(err: unknown): unknown {
  if (err instanceof SalaGuerraValidationError) return Errors.validation(err.message);
  if (err instanceof SalaGuerraNotAvailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof JuntaQuestionRejectedError) {
    if (err.reasonCode === "rol_no_autorizado") return Errors.forbidden(err.message);
    if (err.reasonCode === "datos_requeridos") return Errors.validation(err.message);
    return Errors.conflict(err.message);
  }
  return err;
}

async function body(c: Ctx, maxBytes = 32 * 1024): Promise<Record<string, unknown>> {
  const raw = await readJsonCapped<unknown>(c.req.raw, maxBytes);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Errors.validation("El cuerpo debe ser un objeto JSON.");
  return raw as Record<string, unknown>;
}

function summarizeQuestion(q: JuntaQuestionRecord) {
  return { id: q.id, questionText: q.questionText, status: q.status, priority: q.priority };
}

/** 409 con el MISMO formato de error que el resto de la API (`{ code, message }`, ver app.ts::onError) mas la pregunta existente. */
function duplicateResponse(c: Ctx, err: JuntaQuestionDuplicateError) {
  return c.json({ code: "duplicate_question", message: err.message, existing: err.existing ? summarizeQuestion(err.existing) : null }, 409);
}

/** Reintenta un bloque de lectura que degrada a "no disponible aun" en vez de fallar. */
async function readOrUnavailable<T>(fn: () => Promise<T>, fallback: T): Promise<{ value: T; available: boolean }> {
  try {
    return { value: await fn(), available: true };
  } catch (err) {
    if (err instanceof SalaGuerraNotAvailableError) return { value: fallback, available: false };
    throw err;
  }
}

export function licitacionesSalaGuerraRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const t = "/licitaciones/:propertyId/tenders/:tenderId";
  const paths = {
    board: `${t}/sala-guerra`,
    items: `${t}/sala-guerra/items`,
    importRequirements: `${t}/sala-guerra/items/import-requirements`,
    item: `${t}/sala-guerra/items/:itemId{${UUID_PARAM}}`,
    entries: `${t}/sala-guerra/entries`,
    gate: `${t}/sala-guerra/gate`,
    bitacora: `${t}/bitacora`,
    junta: `${t}/junta`,
    juntaConfig: `${t}/junta/config`,
    questions: `${t}/junta/questions`,
    draft: `${t}/junta/questions/draft`,
    question: `${t}/junta/questions/:questionId{${UUID_PARAM}}`,
    transition: `${t}/junta/questions/:questionId{${UUID_PARAM}}/transition`,
    reminderAck: `${t}/junta/reminders/:reminderId{${UUID_PARAM}}/acknowledge`,
  } as const;
  for (const path of Object.values(paths)) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const salaFor = (c: Ctx): SalaGuerraRepository => {
    if (!deps.licitacionesSalaGuerraRepo) throw Errors.serviceUnavailable("La sala de guerra no esta configurada en este ambiente.");
    return deps.licitacionesSalaGuerraRepo(c.get("db"));
  };

  async function requireTender(c: Ctx) {
    const tender = await deps.licitacionesRepo(c.get("db")).findTender(c.get("organizationId"), c.req.param("tenderId")!);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    return tender;
  }

  /** Anota un evento automatico en la bitacora; si la sala aun no esta disponible no debe tumbar la accion principal (ya fallo antes). */
  async function logEvent(c: Ctx, sala: SalaGuerraRepository, text: string, itemId: string | null = null): Promise<void> {
    await sala.addEntry(c.get("organizationId"), c.req.param("tenderId")!, { entryKind: "evento", body: text.slice(0, 4000), itemId }, c.get("userId"));
  }

  // ===================================================================== tablero

  app.get(paths.board, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId")!;
    const repo = deps.licitacionesRepo(c.get("db"));
    const sala = salaFor(c);
    const tender = await requireTender(c);
    const nowIso = new Date().toISOString();

    const items = await readOrUnavailable(() => sala.listItems(organizationId, tenderId), [] as readonly WarRoomItemRecord[]);
    const entries = await readOrUnavailable(() => sala.listEntries(organizationId, tenderId), []);
    const decisions = await repo.listGoNoGoDecisions(organizationId, tenderId);
    const requirements = await repo.listRequirementItems(organizationId, tenderId);

    const board = buildWarRoomBoard({ items: items.value, goNoGoDecisions: decisions, submissionDeadline: tender.submissionDeadline, nowIso });
    // L-22: dias habiles que quedan para la presentacion segun el calendario efectivo (fecha civil de Mexico).
    const calendario = await resolveCalendarioFor(deps, c, tenderId);
    const plazoPresentacion = tender.submissionDeadline ? describirPlazo(tender.submissionDeadline, nowIso, calendario) : null;
    const imported = new Set(items.value.map((i) => i.requirementItemId).filter((id): id is string => id !== null));
    return c.json({
      available: items.available && entries.available,
      now: nowIso,
      viewerUserId: c.get("userId"),
      tender: { id: tender.id, title: tender.title, submissionDeadline: tender.submissionDeadline, status: tender.status ?? null },
      board,
      plazoPresentacion,
      entries: entries.value,
      goNoGoHistory: decisions,
      importableRequirements: requirements
        .filter((r) => r.obligatoriedad !== "opcional" && !imported.has(r.id))
        .map((r) => ({ id: r.id, text: r.text, requirementKind: r.requirementKind, obligatoriedad: r.obligatoriedad, clause: r.clause })),
    });
  });

  app.post(paths.items, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const input = parseWarRoomItemCreate(await body(c));
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      if (input.requirementItemId) {
        const requirements = await deps.licitacionesRepo(c.get("db")).listRequirementItems(organizationId, tenderId);
        if (!requirements.some((r) => r.id === input.requirementItemId)) throw Errors.validation("requirementItemId: el requisito no pertenece a esta convocatoria.");
      }
      const sala = salaFor(c);
      const item = await sala.createItem(organizationId, tenderId, input, c.get("userId"));
      await logEvent(c, sala, `Se agrego ${input.kind} "${item.title}".`, item.id);
      return c.json(item, 201);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.post(paths.importRequirements, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const sala = salaFor(c);
      const existing = await sala.listItems(organizationId, tenderId);
      const imported = new Set(existing.map((i) => i.requirementItemId).filter((id): id is string => id !== null));
      const requirements = await deps.licitacionesRepo(c.get("db")).listRequirementItems(organizationId, tenderId);
      const created: WarRoomItemRecord[] = [];
      for (const r of requirements) {
        if (r.obligatoriedad === "opcional" || imported.has(r.id)) continue;
        const text = r.text.trim();
        if (text.length < 3) continue;
        const dueAt = r.deadline && !Number.isNaN(Date.parse(r.deadline)) ? new Date(r.deadline).toISOString() : null;
        created.push(
          await sala.createItem(
            organizationId,
            tenderId,
            { kind: "requisito", title: text.slice(0, 300), description: text.length > 300 ? text.slice(0, 4000) : r.clause ? `Clausula: ${r.clause}` : null, requirementItemId: r.id, dueAt },
            c.get("userId"),
          ),
        );
      }
      if (created.length > 0) await logEvent(c, sala, `Se importaron ${created.length} requisito(s) de las bases al tablero.`);
      return c.json({ created: created.length, items: created }, 201);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.patch(paths.item, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const itemId = c.req.param("itemId")!;
      const sala = salaFor(c);
      const current = await sala.findItem(organizationId, tenderId, itemId);
      if (!current) throw Errors.notFound("Item no encontrado.");
      const patch = parseWarRoomItemPatch(await body(c), current.kind);
      const updated = await sala.updateItem(organizationId, tenderId, itemId, patch, c.get("userId"));
      if (!updated) throw Errors.notFound("Item no encontrado.");
      if (patch.status !== undefined && patch.status !== current.status) await logEvent(c, sala, `"${current.title}": ${current.status} -> ${patch.status}.`, itemId);
      return c.json(updated);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.get(paths.entries, async (c) => {
    await requireTender(c);
    const entries = await readOrUnavailable(() => salaFor(c).listEntries(c.get("organizationId"), c.req.param("tenderId")!), []);
    return c.json({ available: entries.available, entries: entries.value });
  });

  app.post(paths.entries, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const input = parseWarRoomEntryCreate(await body(c));
      // Una DECISION de la sala de guerra exige los mismos roles que decidir go/no-go.
      if (input.entryKind === "decision") assertVerticalRole(c, GO_NO_GO_ROLES);
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const sala = salaFor(c);
      if (input.itemId && !(await sala.findItem(organizationId, tenderId, input.itemId))) throw Errors.validation("itemId: el item no pertenece a esta convocatoria.");
      const entry = await sala.addEntry(organizationId, tenderId, input, c.get("userId"));
      return c.json(entry, 201);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  // ============================================================ L-25: gate final

  /**
   * Gate final "anti-desechamiento" (REQ-040): junta checklist VIVO, paquete (re-derivado contra el expediente
   * vivo, AE-14), hash del ZIP guardado contra el manifiesto guardado, doble aprobacion (L-26) y holgura al cierre.
   * Solo lectura para cualquier miembro; NO presenta nada ante ningun portal. Unico efecto lateral: el aviso in-app
   * (deduplicado por convocatoria, en SAVEPOINT, nunca tumba la lectura) cuando faltan menos de 24 h y no esta listo.
   */
  app.get(paths.gate, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId")!;
    const repo = deps.licitacionesRepo(c.get("db"));
    const tender = await requireTender(c);
    const nowIso = new Date().toISOString();
    const zonaHoraria = resolveGateTimeZone((await repo.findTenantConfig(organizationId)).timezone);
    const proposal = await repo.findProposal(organizationId, tenderId);

    let checklist = null as Awaited<ReturnType<typeof buildAssembleInput>>["checklist"] | null;
    let paquete: GatePackageInput | null = null;
    let zip: GateZipCheck | null = null;
    let aprobaciones: GateApprovalsInput = { mode: "sin_propuesta", complete: false, missing: [] };
    let presentado = false;

    if (proposal) {
      const input = await buildAssembleInput(repo, { organizationId, tenderId, proposalId: proposal.id, correlationId: null });
      checklist = input.checklist;
      const snapshot = await repo.listExpedienteStageApprovals(organizationId, proposal.id);
      if (snapshot.mode === "doble") {
        const evaluation = evaluateExpedienteStages(snapshot.approvals, input.currentInputsHash.hash);
        aprobaciones = { mode: "doble", complete: evaluation.complete, missing: evaluation.missing, sameApprover: evaluation.sameApprover };
      } else {
        // Base sin la migracion 033: la aprobacion unica de siempre (el gate lo declara en ambar).
        aprobaciones = { mode: "legacy", complete: input.approvals.length > 0, missing: input.approvals.length > 0 ? [] : ["tecnica_legal", "economica"] };
      }
      presentado = (await repo.findSubmission(organizationId, proposal.id)) !== null;

      const stored = await repo.findLatestManifest(organizationId, proposal.id);
      if (stored) {
        const fresh = new PackageAssembler().buildManifest(input);
        paquete = { generatedAt: stored.generatedAt, storedStatus: stored.status, vigenteStatus: fresh.status, draftReasons: fresh.draftReasons };
        if (stored.storageRef) {
          // La lectura del blob corre en SAVEPOINT: un error de Postgres (p. ej. 22P02 por un storage_ref legacy que
          // no es uuid, o 57014 por timeout) no debe dejar abortada la transaccion compartida del request, porque
          // despues se sigue usando la sesion (aviso in-app) y el COMMIT. Cualquier fallo de lectura es "ilegible".
          const storageRef = stored.storageRef;
          const bytes = await runWithSavepointFallback<Uint8Array | null>({
            session: c.get("db"),
            primary: () => repo.readManifestZip(storageRef),
            isRecoverable: () => true,
            fallback: async () => null,
          });
          try {
            zip = bytes ? await verifyZipAgainstStoredManifest(bytes, { status: stored.status, manifest: stored.manifest }) : { state: "ilegible" };
          } catch {
            zip = { state: "ilegible" };
          }
        }
      }
    }

    const gate = evaluarGateSalaGuerra({ checklist, paquete, zip, aprobaciones, fechaCierre: tender.submissionDeadline, ahora: nowIso, zonaHoraria, presentado });

    let alerta: "emitida" | "sin_nuevas" | "no_disponible" | "error" | "no_aplica" = "no_aplica";
    if (gate.alerta24h) {
      // Sin PII: el texto sale del catalogo; la clave de dedupe es solo el id de la convocatoria.
      const emision = await emitirNotificacion(c.get("db"), { evento: "licitaciones.sala_guerra.paquete_no_listo", organizationId, clave: tenderId, entidadTipo: "convocatoria", entidadId: tenderId });
      alerta = emision.estado === "emitida" || emision.estado === "sin_nuevas" || emision.estado === "no_disponible" ? emision.estado : "error";
    }

    return c.json({
      now: nowIso,
      tender: { id: tender.id, title: tender.title, submissionDeadline: tender.submissionDeadline },
      proposalId: proposal?.id ?? null,
      presentado,
      gate,
      alerta,
    });
  });

  // ============================================================ L-29: bitacora

  /**
   * Bitacora visible de la convocatoria: une en orden temporal eventos que ya existen (auditoria de alta/edicion,
   * anotaciones de la sala de guerra, go/no-go, aprobaciones vigentes y presentacion). Solo lectura, paginada,
   * filtrable; las filas son de la organizacion del token (otra organizacion recibe 404, nunca filas ajenas).
   * Sin ids ni correos de otras personas. Base sin migrar: cada fuente ausente aporta una lista vacia.
   */
  app.get(paths.bitacora, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId")!;
    const repo = deps.licitacionesRepo(c.get("db"));
    await requireTender(c);

    const q = c.req.query();
    if (q.fuente !== undefined && !isBitacoraFuente(q.fuente)) throw Errors.validation(`fuente: se esperaba ${BITACORA_FUENTES.join(" | ")}.`);
    const fecha = (name: "desde" | "hasta"): string | undefined => {
      const raw = q[name];
      if (raw === undefined || raw === "") return undefined;
      if (Number.isNaN(Date.parse(raw))) throw Errors.validation(`${name}: fecha invalida (ISO 8601).`);
      return new Date(raw).toISOString();
    };
    const entero = (name: "limit" | "offset", def: number, min: number, max: number): number => {
      const raw = q[name];
      if (raw === undefined || raw === "") return def;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${name}: se esperaba un entero entre ${min} y ${max}.`);
      return n;
    };
    const filtros = { ...(q.fuente ? { fuente: q.fuente as (typeof BITACORA_FUENTES)[number] } : {}), desde: fecha("desde"), hasta: fecha("hasta") };
    const limit = entero("limit", BITACORA_DEFAULT_LIMIT, 1, BITACORA_MAX_LIMIT);
    const offset = entero("offset", 0, 0, 100_000);

    const sala = salaFor(c);
    const entradasSala = await readOrUnavailable(() => sala.listEntries(organizationId, tenderId, 500), []);
    const auditoria = await runWithSavepointFallback<TenderAuditLogEntry[]>({
      session: c.get("db"),
      primary: async () => {
        // La auditoria ya es paginada en el repositorio (orden total, migracion 026): se recorre por paginas con tope.
        const todas: TenderAuditLogEntry[] = [];
        let next: number | null = 0;
        for (let i = 0; next !== null && i < 20; i += 1) {
          const page = await repo.listTenderAuditLogPage(organizationId, tenderId, { limit: 100, offset: next });
          todas.push(...page.items);
          next = page.nextOffset;
        }
        return todas;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => [],
    });
    const goNoGo = await repo.listGoNoGoDecisions(organizationId, tenderId);
    const proposal = await repo.findProposal(organizationId, tenderId);
    const aprobaciones = proposal ? (await repo.listExpedienteStageApprovals(organizationId, proposal.id)).approvals : [];
    const presentacion = proposal ? await repo.findSubmission(organizationId, proposal.id) : null;

    const eventos = buildBitacoraEventos({ auditoria, salaGuerra: entradasSala.value, goNoGo, aprobaciones, presentacion }, c.get("userId"));
    return c.json({ available: entradasSala.available, ...paginarBitacora(eventos, filtros, { limit, offset }) });
  });

  // ============================================================ junta de aclaraciones

  app.get(paths.junta, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId")!;
    await requireTender(c);
    const sala = salaFor(c);
    const nowIso = new Date().toISOString();
    const config = await readOrUnavailable(() => sala.getJuntaConfig(organizationId, tenderId), null);
    const questions = await readOrUnavailable(() => sala.listQuestions(organizationId, tenderId), [] as readonly JuntaQuestionRecord[]);
    const reminders = await readOrUnavailable(() => sala.listQuestionReminders(organizationId, tenderId), []);
    // L-22: dias habiles que quedan para enviar preguntas y para la junta, segun el calendario efectivo.
    const calendario = await resolveCalendarioFor(deps, c, tenderId);
    const plazos = {
      preguntas: config.value?.questionsDeadlineAt ? describirPlazo(config.value.questionsDeadlineAt, nowIso, calendario) : null,
      junta: config.value?.meetingAt ? describirPlazo(config.value.meetingAt, nowIso, calendario) : null,
    };
    return c.json({
      available: config.available && questions.available && reminders.available,
      now: nowIso,
      plazos,
      config: config.value,
      questions: sortJuntaQuestions(questions.value),
      summary: buildJuntaSummary(questions.value, config.value, nowIso),
      reminders: reminders.value,
      // Honestidad de producto: este sistema no presenta preguntas ni lee actas de ningun portal.
      portalSubmission: false,
    });
  });

  app.put(paths.juntaConfig, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const input = parseJuntaConfig(await body(c));
      await requireTender(c);
      const config = await salaFor(c).upsertJuntaConfig(c.get("organizationId"), c.req.param("tenderId")!, input, c.get("userId"));
      return c.json(config);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.post(paths.questions, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const input = parseQuestionCapture(await body(c));
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const sala = salaFor(c);
      const existing = await sala.listQuestions(organizationId, tenderId);
      const similar = findSimilarQuestions(input.questionText, existing);
      const suggestion = suggestQuestionPriority(input.questionText, input.topic);
      try {
        const question = await sala.createQuestion(
          organizationId,
          tenderId,
          { questionText: input.questionText, baseReference: input.baseReference, topic: input.topic, priority: input.priority ?? suggestion.priority, dedupeKey: questionDedupeKey(input.questionText), origin: "manual", draftMissingData: [] },
          c.get("userId"),
        );
        await logEvent(c, sala, `Se capturo una pregunta para la junta de aclaraciones (prioridad ${question.priority}).`);
        return c.json({ question, similar: similar.map((s) => ({ ...summarizeQuestion(s.question), similarity: s.similarity })), suggestion }, 201);
      } catch (err) {
        if (err instanceof JuntaQuestionDuplicateError) {
          return duplicateResponse(c, err);
        }
        throw err;
      }
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.post(paths.draft, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const raw = await body(c, 64 * 1024);
      if (typeof raw.instruction !== "string" || raw.instruction.trim().length < 5 || raw.instruction.length > 1000) throw Errors.validation("instruction: se esperaba texto de 5 a 1000 caracteres.");
      if (!deps.llmGateway) throw Errors.serviceUnavailable("El asistente de IA no esta configurado en este ambiente (falta una API key de proveedor LLM).");
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      await requireTender(c);

      const extra = Array.isArray(raw.extraContext) ? raw.extraContext.filter((x): x is string => typeof x === "string") : [];
      const requirements = raw.includeRequirements === false ? [] : await deps.licitacionesRepo(c.get("db")).listRequirementItems(organizationId, tenderId);
      const basesContext = [...requirements.map((r) => (r.clause ? `${r.clause}: ${r.text}` : r.text)), ...extra];
      if (basesContext.length === 0) throw Errors.validation("No hay contexto de las bases: extrae los requisitos de la convocatoria o envia extraContext.");

      const agent = new JuntaQuestionDraftAgent(deps.llmGateway, { tenantId: organizationId });
      let result;
      try {
        result = await agent.draftQuestions({ actorId: c.get("userId"), actorRole: c.get("verticalRole")! as LicitacionesRole, instruction: raw.instruction, basesContext });
      } catch (err) {
        if (err instanceof GuardrailBlockedError) throw new ApiError(422, "guardrail_blocked", err.message);
        if (err instanceof DraftAgentRoleNotAllowedError) throw Errors.forbidden(err.message);
        if (err instanceof DraftAgentNoProposalError) throw new ApiError(422, "no_proposal", err.message);
        if (err instanceof DraftAgentGenerationFailedError) throw Errors.serviceUnavailable(err.message);
        throw err;
      }

      const sala = salaFor(c);
      const created: JuntaQuestionRecord[] = [];
      const skippedDuplicates: string[] = [];
      for (const proposal of result.proposals) {
        try {
          created.push(
            await sala.createQuestion(
              organizationId,
              tenderId,
              {
                questionText: proposal.questionText,
                baseReference: proposal.baseReference,
                topic: proposal.topic,
                priority: suggestQuestionPriority(proposal.questionText, proposal.topic).priority,
                dedupeKey: questionDedupeKey(proposal.questionText),
                origin: "agente",
                draftMissingData: result.missingData,
              },
              c.get("userId"),
            ),
          );
        } catch (err) {
          if (err instanceof JuntaQuestionDuplicateError) skippedDuplicates.push(proposal.questionText);
          else throw err;
        }
      }
      if (created.length > 0) await logEvent(c, sala, `El asistente propuso ${created.length} borrador(es) de pregunta para la junta; quedan pendientes de aprobacion humana.`);
      // Todo nace `borrador`: ninguna pregunta del asistente se aprueba ni se envia sola.
      return c.json({ created, skippedDuplicates, rejected: result.rejected, missingData: result.missingData }, 201);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.patch(paths.question, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const patch = parseQuestionPatch(await body(c));
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const sala = salaFor(c);
      const current = await sala.findQuestion(organizationId, tenderId, c.req.param("questionId")!);
      if (!current) throw Errors.notFound("Pregunta no encontrada.");
      if (patch.questionText !== undefined || patch.baseReference !== undefined || patch.topic !== undefined) assertQuestionEditable(current);
      if (current.status === "respondida" || current.status === "descartada") throw Errors.conflict(`Una pregunta "${current.status}" ya no se edita.`);
      try {
        const updated = await sala.updateQuestion(organizationId, tenderId, current.id, patch);
        if (!updated) throw Errors.notFound("Pregunta no encontrada.");
        return c.json(updated);
      } catch (err) {
        if (err instanceof JuntaQuestionDuplicateError) {
          return duplicateResponse(c, err);
        }
        throw err;
      }
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.post(paths.transition, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      const request = parseTransitionRequest(await body(c));
      // Aprobar es una decision (mismo conjunto que aprobar un expediente); se corta aqui con 403 explicito.
      if (request.to === "aprobada") assertVerticalRole(c, DECISION_ROLES);
      await requireTender(c);
      const organizationId = c.get("organizationId");
      const tenderId = c.req.param("tenderId")!;
      const sala = salaFor(c);
      const current = await sala.findQuestion(organizationId, tenderId, c.req.param("questionId")!);
      if (!current) throw Errors.notFound("Pregunta no encontrada.");
      assertQuestionTransition(current, request, c.get("verticalRole")! as LicitacionesRole);
      try {
        const updated = await sala.transitionQuestion(organizationId, tenderId, current.id, request, c.get("userId"));
        if (!updated) throw Errors.notFound("Pregunta no encontrada.");
        await logEvent(c, sala, `Pregunta de junta de aclaraciones: ${current.status} -> ${request.to}.`);
        return c.json(updated);
      } catch (err) {
        if (err instanceof JuntaQuestionDuplicateError) {
          return duplicateResponse(c, err);
        }
        throw err;
      }
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  app.post(paths.reminderAck, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    try {
      await requireTender(c);
      const reminder = await salaFor(c).acknowledgeQuestionReminder(c.get("organizationId"), c.req.param("reminderId")!, c.get("userId"));
      if (!reminder) throw Errors.notFound("Recordatorio no encontrado.");
      return c.json(reminder);
    } catch (err) {
      throw mapSalaError(err);
    }
  });

  return app;
}
