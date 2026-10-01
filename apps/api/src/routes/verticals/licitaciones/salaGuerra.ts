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
import {
  DECISION_ROLES,
  DraftAgentGenerationFailedError,
  DraftAgentNoProposalError,
  DraftAgentRoleNotAllowedError,
  GO_NO_GO_ROLES,
  GuardrailBlockedError,
  JuntaQuestionDraftAgent,
  JuntaQuestionDuplicateError,
  JuntaQuestionRejectedError,
  SalaGuerraNotAvailableError,
  SalaGuerraValidationError,
  WRITE_ROLES,
  assertQuestionEditable,
  assertQuestionTransition,
  buildJuntaSummary,
  buildWarRoomBoard,
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
} from "@atiende/domain-licitaciones";
import type { JuntaQuestionRecord, LicitacionesRole, SalaGuerraRepository, WarRoomItemRecord } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

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
    const imported = new Set(items.value.map((i) => i.requirementItemId).filter((id): id is string => id !== null));
    return c.json({
      available: items.available && entries.available,
      now: nowIso,
      viewerUserId: c.get("userId"),
      tender: { id: tender.id, title: tender.title, submissionDeadline: tender.submissionDeadline, status: tender.status ?? null },
      board,
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
    return c.json({
      available: config.available && questions.available && reminders.available,
      now: nowIso,
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
