// H-02 (P0) -- PRIVACIDAD de hoteles: aviso de privacidad versionado, ledger de consentimientos,
// solicitudes ARCO con plazos, bloqueo previo a la purga, retencion legal por incidente, registro de
// vulneraciones y acceso excepcional a identidades bloqueadas. Superficie HTTP de
// `@atiende/domain-hoteles::privacy` (modelo en packages/domain-hoteles/migrations/032_*.sql).
//
// AVISO: herramienta de registro y control; NO es asesoria legal (la respuesta de `/privacidad/info`
// lo dice y lista lo que un abogado debe confirmar). Los plazos son decisiones de producto.
//
// Principios:
//   - Roles: capturar/leer consentimientos, ver el aviso y REPORTAR incidentes = front-of-house
//     (owner/gm/frontdesk/reservations); todo lo demas (ARCO, retencion legal, bloqueo, acceso
//     excepcional, ajustes, bitacora, gestion de incidentes) = owner/gm. La base lo hace cumplir (RLS +
//     funciones security definer); esta capa es la segunda capa y traduce errores.
//   - El sistema NUNCA envia nada al titular ni a una autoridad: el recordatorio de notificar una
//     vulneracion (art. 19) es solo un campo calculado de la respuesta.
//   - REGLA DURA de compatibilidad con la base sin migrar: el repositorio degrada las lecturas a
//     `disponible: false` y las escrituras a 503 (SAVEPOINT) -- nunca un 500, nunca romper un flujo vigente.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  ARCO_RESPONSE_DAYS,
  ARCO_EXECUTION_DAYS,
  BLOCK_WINDOW_DAYS_DEFAULT,
  BLOCK_WINDOW_DAYS_MAX,
  BLOCK_WINDOW_DAYS_MIN,
  IDENTITY_ADMIN_ROLES,
  IDENTITY_CAPTURE_ROLES,
  IdentityVaultService,
  PRIVACY_LAWYER_CHECKLIST,
  PRIVACY_LEGAL_DISCLAIMER,
  PostgresIdentityRepository,
  arcoDeadline,
  arcoExtensionAvailable,
  incidentNotificationReminder,
  legalHoldReviewState,
  parseArcoAdvance,
  parseArcoInput,
  parseBlockWindowDays,
  parseConsentFields,
  parseIncidentAction,
  parseIncidentInput,
  parseLegalHoldInput,
  parsePrivacyNoticeInput,
  parsePrivacyReason,
  type ArcoRequestRecord,
  type BlockedAccessRequestRecord,
  type IdentityRepository,
  type LegalHoldRecord,
  type PrivacyEventRecord,
  type PrivacyIncidentRecord,
  type PrivacyNoticeRecord,
  type PrivacyRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseLimit, readBody, requireUuid, resolveCipher, serializeIdentity, toApiError } from "./identidad.ts";
import { privacyRepo, serializeConsent } from "./privacidad-comun.ts";

function identityRepo(deps: AppDeps, c: Context<CoreAuthHonoEnv>): IdentityRepository {
  const db = c.get("db");
  return deps.hotelesIdentidadRepo ? deps.hotelesIdentidadRepo(db) : new PostgresIdentityRepository(db);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

async function businessToday(deps: AppDeps, c: Context<CoreAuthHonoEnv>, propertyId: string): Promise<string> {
  return hoyFechaNegocio(resolverZonaHorariaNegocio(await deps.hotelesRepo(c.get("db")).findPropertyTimezone(propertyId)));
}

export function serializeNotice(n: PrivacyNoticeRecord) {
  return {
    id: n.id, version: n.version, textoSimplificado: n.simplifiedText, urlIntegral: n.integralUrl, finalidadesObligatorias: n.mandatoryPurposes,
    finalidadesOpcionales: n.optionalPurposes, sha256: n.contentSha256, vigente: n.isCurrent, publicadoPor: n.publishedBy, publicadoEn: n.publishedAt,
  };
}
function serializeArco(r: ArcoRequestRecord, today: string) {
  const d = arcoDeadline(r, today);
  const ext = arcoExtensionAvailable(r);
  return {
    id: r.id, folio: r.folio, derecho: r.rightType, huespedId: r.guestId, identidadId: r.vaultId, solicitante: r.requesterName, contacto: r.requesterContact, canal: r.channel,
    descripcion: r.description, recibidaEn: r.receivedOn, respuestaLimite: r.responseDueOn, ejecucionLimite: r.executionDueOn, estado: r.status, decididaEn: r.decidedOn,
    notaDecision: r.decisionNote,
    prorroga: r.extensionPhase ? { fase: r.extensionPhase, motivo: r.extensionReason, en: r.extendedAt, por: r.extendedBy } : null,
    ejecutadaEn: r.executedAt, creadaPor: r.createdBy, creadaEn: r.createdAt,
    plazo: { fase: d.phase, vence: d.dueOn, diasRestantes: d.daysRemaining, estado: d.state },
    prorrogaDisponible: { disponible: ext.available, dias: ext.days },
  };
}
function serializeIncident(r: PrivacyIncidentRecord, now: Date) {
  const reminder = incidentNotificationReminder(r, now);
  return {
    id: r.id, folio: r.folio, tipo: r.incidentType, severidad: r.severity, titulo: r.title, descripcion: r.description, detectadoEn: r.detectedAt, afectados: r.affectedCount,
    riesgoSignificativo: r.significantRisk, estado: r.status, contenidoEn: r.containedAt,
    notificacion: r.notifiedAt ? { en: r.notifiedAt, por: r.notifiedBy, canal: r.notificationChannel, constancia: r.notificationRef } : null,
    motivoNoNotificar: r.noNotificationReason, cerradoEn: r.closedAt, cerradoPor: r.closedBy, notaCierre: r.closingNote, reportadoPor: r.reportedBy, creadoEn: r.createdAt,
    // Recordatorio del art. 19: SOLO informativo; el sistema no envia ninguna notificacion.
    recordatorio: { requerido: reminder.required, vencido: reminder.overdue, horasDesdeDeteccion: reminder.hoursSinceDetection, mensaje: reminder.message },
  };
}
function serializeHold(r: LegalHoldRecord, today: string) {
  return {
    id: r.id, identidadId: r.vaultId, incidenteId: r.incidentId, folio: r.folio, motivo: r.reason, autorizacion: r.authorizationRef, estado: r.status, aplicadaPor: r.placedBy,
    aplicadaEn: r.placedAt, revisarAntesDe: r.reviewDueOn, revision: legalHoldReviewState(r, today), liberadaPor: r.releasedBy, liberadaEn: r.releasedAt, notaLiberacion: r.releaseNote,
  };
}
function serializeAccess(r: BlockedAccessRequestRecord) {
  return {
    id: r.id, identidadId: r.vaultId, solicitadaPor: r.requestedBy, motivo: r.reason, estado: r.status, decididaPor: r.decidedBy, decididaEn: r.decidedAt, notaDecision: r.decisionNote,
    caducaEn: r.expiresAt, usadaEn: r.usedAt, creadaEn: r.createdAt,
  };
}
function serializeEvent(r: PrivacyEventRecord) {
  return { id: r.id, tipo: r.subjectType, sujetoId: r.subjectId, actorId: r.actorUserId, accion: r.action, nota: r.note, creadaEn: r.createdAt };
}

const EVENT_SUBJECTS = ["arco", "incidente", "retencion_legal", "aviso", "consentimiento", "configuracion", "acceso_excepcional"] as const;

export function hotelesPrivacidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/privacidad", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/privacidad/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const admin = (c: Context<CoreAuthHonoEnv>) => assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
  const frontOfHouse = (c: Context<CoreAuthHonoEnv>) => assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);

  // ---- Informacion legal estatica ----

  app.get("/hoteles/:propertyId/privacidad/info", (c) => {
    frontOfHouse(c);
    return c.json({
      avisoLegal: PRIVACY_LEGAL_DISCLAIMER,
      unAbogadoDebeConfirmar: PRIVACY_LAWYER_CHECKLIST,
      plazos: {
        arcoRespuestaDias: ARCO_RESPONSE_DAYS,
        arcoEjecucionDias: ARCO_EXECUTION_DAYS,
        diasNaturales: true,
        prorrogaUnicaPorIgualPlazo: true,
        ventanaBloqueoDias: { minimo: BLOCK_WINDOW_DAYS_MIN, maximo: BLOCK_WINDOW_DAYS_MAX, porDefecto: BLOCK_WINDOW_DAYS_DEFAULT },
      },
    });
  });

  // ---- Configuracion: ventana de bloqueo ----

  app.get("/hoteles/:propertyId/privacidad/configuracion", async (c) => {
    admin(c);
    const r = await guarded(() => privacyRepo(deps, c).getSettings(c.req.param("propertyId")));
    return c.json({ disponible: r.available, ventanaBloqueoDias: r.settings.blockWindowDays, esDefault: r.settings.isDefault, actualizadoPor: r.settings.updatedBy, actualizadoEn: r.settings.updatedAt });
  });

  app.put("/hoteles/:propertyId/privacidad/configuracion", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const body = await readBody(c);
    const days = await guarded(async () => parseBlockWindowDays(body.dias));
    await guarded(() => privacyRepo(deps, c).setBlockWindow(propertyId, days, c.get("userId")));
    return c.json({ ventanaBloqueoDias: days });
  });

  // ---- Aviso de privacidad ----

  app.get("/hoteles/:propertyId/privacidad/avisos", async (c) => {
    frontOfHouse(c);
    const r = await guarded(() => privacyRepo(deps, c).listNotices(c.req.param("propertyId"), { limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: r.available, items: r.items.map(serializeNotice) });
  });

  app.post("/hoteles/:propertyId/privacidad/avisos", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const input = await guarded(async () => parsePrivacyNoticeInput(await readBody(c)));
    const id = await guarded(() => privacyRepo(deps, c).publishNotice(propertyId, input, c.get("userId")));
    return c.json({ avisoId: id }, 201);
  });

  // ---- Ledger de consentimientos ----

  app.get("/hoteles/:propertyId/privacidad/consentimientos", async (c) => {
    frontOfHouse(c);
    const guestId = c.req.query("huespedId");
    const vaultId = c.req.query("identidadId");
    if (guestId !== undefined) requireUuid(guestId, "huespedId");
    if (vaultId !== undefined) requireUuid(vaultId, "identidadId");
    const r = await guarded(() => privacyRepo(deps, c).listConsents(c.req.param("propertyId"), { guestId, vaultId, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: r.available, items: r.items.map(serializeConsent) });
  });

  app.post("/hoteles/:propertyId/privacidad/consentimientos", async (c) => {
    frontOfHouse(c);
    const propertyId = c.req.param("propertyId");
    const body = await readBody(c);
    const guestId = requireUuid(typeof body.huespedId === "string" ? body.huespedId : "", "huespedId");
    const vaultId = body.identidadId === undefined || body.identidadId === null ? null : requireUuid(typeof body.identidadId === "string" ? body.identidadId : "", "identidadId");
    const fields = await guarded(async () => parseConsentFields(body));
    const record = await guarded(() =>
      privacyRepo(deps, c).recordConsent(propertyId, { id: randomUUID(), guestId, vaultId, noticeId: fields.noticeId, acceptedMandatory: fields.acceptedMandatory, acceptedOptional: fields.acceptedOptional, channel: fields.channel, evidenceMethod: fields.evidenceMethod, sensitiveData: fields.sensitiveData }, c.get("userId")),
    );
    return c.json({ consentimiento: serializeConsent(record) }, 201);
  });

  app.post("/hoteles/:propertyId/privacidad/consentimientos/:consentimientoId/revocar", async (c) => {
    frontOfHouse(c);
    const id = requireUuid(c.req.param("consentimientoId"), "consentimientoId");
    const reason = await guarded(async () => parsePrivacyReason(await readBody(c)));
    await guarded(() => privacyRepo(deps, c).revokeConsent(id, reason, c.get("userId")));
    return c.json({ resultado: "revocado" });
  });

  // ---- ARCO ----

  app.get("/hoteles/:propertyId/privacidad/arco", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado");
    if (estado !== undefined && !["recibida", "en_revision", "procedente", "improcedente", "ejecutada"].includes(estado)) throw Errors.validation("estado: recibida, en_revision, procedente, improcedente o ejecutada.");
    const [r, today] = await Promise.all([
      guarded(() => privacyRepo(deps, c).listArco(propertyId, { status: estado as ArcoRequestRecord["status"] | undefined, limit: parseLimit(c.req.query("limit")) })),
      businessToday(deps, c, propertyId),
    ]);
    return c.json({ disponible: r.available, hoy: today, items: r.items.map((x) => serializeArco(x, today)) });
  });

  app.post("/hoteles/:propertyId/privacidad/arco", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const today = await businessToday(deps, c, propertyId);
    const input = await guarded(async () => parseArcoInput(await readBody(c), today));
    const repo = privacyRepo(deps, c);
    const id = await guarded(() => repo.openArco(propertyId, input, c.get("userId")));
    const rec = await guarded(() => repo.findArco(propertyId, id));
    return c.json({ solicitudId: id, solicitud: rec ? serializeArco(rec, today) : null }, 201);
  });

  app.post("/hoteles/:propertyId/privacidad/arco/:solicitudId/avanzar", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("solicitudId"), "solicitudId");
    const input = await guarded(async () => parseArcoAdvance(await readBody(c)));
    const today = await businessToday(deps, c, propertyId);
    const repo = privacyRepo(deps, c);
    const result = await guarded(async () => {
      if (!(await repo.findArco(propertyId, id))) throw Errors.notFound("Solicitud ARCO no encontrada.");
      return repo.advanceArco(id, input.to, input.note, today, c.get("userId"));
    });
    const after = await guarded(() => repo.findArco(propertyId, id));
    return c.json({ resultado: result, solicitud: after ? serializeArco(after, today) : null });
  });

  app.post("/hoteles/:propertyId/privacidad/arco/:solicitudId/prorroga", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("solicitudId"), "solicitudId");
    const reason = await guarded(async () => parsePrivacyReason(await readBody(c)));
    const today = await businessToday(deps, c, propertyId);
    const repo = privacyRepo(deps, c);
    await guarded(async () => {
      if (!(await repo.findArco(propertyId, id))) throw Errors.notFound("Solicitud ARCO no encontrada.");
      await repo.extendArco(id, reason, c.get("userId"));
    });
    const after = await guarded(() => repo.findArco(propertyId, id));
    return c.json({ solicitud: after ? serializeArco(after, today) : null });
  });

  // ---- Incidentes / vulneraciones ----

  app.get("/hoteles/:propertyId/privacidad/incidentes", async (c) => {
    admin(c);
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "detectada" && estado !== "contenida" && estado !== "cerrada") throw Errors.validation("estado: detectada, contenida o cerrada.");
    const r = await guarded(() => privacyRepo(deps, c).listIncidents(c.req.param("propertyId"), { status: estado, limit: parseLimit(c.req.query("limit")) }));
    const now = new Date();
    return c.json({ disponible: r.available, items: r.items.map((i) => serializeIncident(i, now)) });
  });

  // Cualquier front-of-house puede REPORTAR (lo que ve en el momento); solo owner/gm gestionan y leen.
  app.post("/hoteles/:propertyId/privacidad/incidentes", async (c) => {
    frontOfHouse(c);
    const propertyId = c.req.param("propertyId");
    const now = new Date();
    const input = await guarded(async () => parseIncidentInput(await readBody(c), now));
    const id = await guarded(() => privacyRepo(deps, c).reportIncident(propertyId, input, c.get("userId")));
    return c.json({ incidenteId: id }, 201);
  });

  app.post("/hoteles/:propertyId/privacidad/incidentes/:incidenteId/accion", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("incidenteId"), "incidenteId");
    const input = await guarded(async () => parseIncidentAction(await readBody(c)));
    const repo = privacyRepo(deps, c);
    await guarded(async () => {
      if (!(await repo.findIncident(propertyId, id))) throw Errors.notFound("Incidente no encontrado.");
      await repo.updateIncident(id, input, c.get("userId"));
    });
    const after = await guarded(() => repo.findIncident(propertyId, id));
    return c.json({ incidente: after ? serializeIncident(after, new Date()) : null });
  });

  // ---- Bloqueo manual, retencion legal y acceso excepcional (por identidad) ----

  app.post("/hoteles/:propertyId/privacidad/identidades/:identidadId/bloquear", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const reason = await guarded(async () => parsePrivacyReason(await readBody(c)));
    await guarded(async () => {
      if (!(await identityRepo(deps, c).findIdentity(propertyId, id))) throw Errors.notFound("Identidad no encontrada.");
      await privacyRepo(deps, c).blockIdentity(id, reason, c.get("userId"));
    });
    const after = await guarded(() => identityRepo(deps, c).findIdentity(propertyId, id));
    return c.json({ identidad: after ? serializeIdentity(after) : null });
  });

  app.get("/hoteles/:propertyId/privacidad/retenciones", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const vaultId = c.req.query("identidadId");
    const estado = c.req.query("estado");
    if (vaultId !== undefined) requireUuid(vaultId, "identidadId");
    if (estado !== undefined && estado !== "activa" && estado !== "liberada") throw Errors.validation("estado: activa o liberada.");
    const [r, today] = await Promise.all([
      guarded(() => privacyRepo(deps, c).listLegalHolds(propertyId, { vaultId, status: estado, limit: parseLimit(c.req.query("limit")) })),
      businessToday(deps, c, propertyId),
    ]);
    return c.json({ disponible: r.available, items: r.items.map((h) => serializeHold(h, today)) });
  });

  app.post("/hoteles/:propertyId/privacidad/identidades/:identidadId/retencion", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const input = await guarded(async () => parseLegalHoldInput(await readBody(c), id));
    const repo = privacyRepo(deps, c);
    const holdId = await guarded(async () => {
      if (!(await identityRepo(deps, c).findIdentity(propertyId, id))) throw Errors.notFound("Identidad no encontrada.");
      return repo.placeLegalHold(input, c.get("userId"));
    });
    return c.json({ retencionId: holdId }, 201);
  });

  app.post("/hoteles/:propertyId/privacidad/retenciones/:retencionId/liberar", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("retencionId"), "retencionId");
    const note = await guarded(async () => parsePrivacyReason(await readBody(c), "nota"));
    const today = await businessToday(deps, c, propertyId);
    const repo = privacyRepo(deps, c);
    await guarded(async () => {
      if (!(await repo.findLegalHold(propertyId, id))) throw Errors.notFound("Retencion legal no encontrada.");
      await repo.releaseLegalHold(id, note, c.get("userId"));
    });
    const after = await guarded(() => repo.findLegalHold(propertyId, id));
    return c.json({ retencion: after ? serializeHold(after, today) : null });
  });

  app.post("/hoteles/:propertyId/privacidad/identidades/:identidadId/acceso-excepcional", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const reason = await guarded(async () => parsePrivacyReason(await readBody(c)));
    const requestId = await guarded(async () => {
      if (!(await identityRepo(deps, c).findIdentity(propertyId, id))) throw Errors.notFound("Identidad no encontrada.");
      return privacyRepo(deps, c).requestBlockedAccess(id, reason, c.get("userId"));
    });
    return c.json({ solicitudId: requestId }, 201);
  });

  app.get("/hoteles/:propertyId/privacidad/accesos-excepcionales", async (c) => {
    admin(c);
    const estado = c.req.query("estado");
    if (estado !== undefined && !["pendiente", "aprobada", "rechazada", "usada"].includes(estado)) throw Errors.validation("estado: pendiente, aprobada, rechazada o usada.");
    const r = await guarded(() => privacyRepo(deps, c).listBlockedAccess(c.req.param("propertyId"), { status: estado as BlockedAccessRequestRecord["status"] | undefined, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: r.available, items: r.items.map(serializeAccess) });
  });

  app.post("/hoteles/:propertyId/privacidad/accesos-excepcionales/:solicitudId/decidir", async (c) => {
    admin(c);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("solicitudId"), "solicitudId");
    const body = await readBody(c);
    if (typeof body.aprobar !== "boolean") throw Errors.validation("aprobar: se esperaba true o false.");
    let nota: string | null = null;
    if (body.nota !== undefined && body.nota !== null) {
      if (typeof body.nota !== "string" || body.nota.trim().length > 300) throw Errors.validation("nota: texto de hasta 300 caracteres.");
      nota = body.nota.trim() || null;
    }
    const repo = privacyRepo(deps, c);
    const resultado = await guarded(async () => {
      if (!(await repo.findBlockedAccess(propertyId, id))) throw Errors.notFound("Solicitud de acceso no encontrada.");
      return repo.decideBlockedAccess(id, body.aprobar as boolean, nota, c.get("userId"));
    });
    return c.json({ resultado });
  });

  // Entrega el documento de una identidad BLOQUEADA SOLO a quien pidio el acceso, con una aprobacion vigente
  // de otra persona (doble control), una sola vez; la base valida todo y deja huella en la misma transaccion.
  app.post("/hoteles/:propertyId/privacidad/accesos-excepcionales/:solicitudId/revelar", async (c) => {
    assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("solicitudId"), "solicitudId");
    const access = await guarded(() => privacyRepo(deps, c).findBlockedAccess(propertyId, id));
    if (!access) throw Errors.notFound("Solicitud de acceso no encontrada.");
    const service = new IdentityVaultService(identityRepo(deps, c), resolveCipher(deps));
    const { record, payload } = await guarded(() => service.revealBlocked({ propertyId, vaultId: access.vaultId, accessRequestId: id, actorUserId: c.get("userId") }));
    c.header("Cache-Control", "no-store");
    return c.json({
      identidad: serializeIdentity(record),
      documento: {
        nombreCompleto: payload.fullName,
        numeroDocumento: payload.documentNumber,
        fechaNacimiento: payload.birthDate,
        paisEmisor: payload.issuingCountry,
        vigenciaHasta: payload.expiryDate,
        mrz: payload.mrz,
      },
    });
  });

  // ---- Bitacora de privacidad ----

  app.get("/hoteles/:propertyId/privacidad/bitacora", async (c) => {
    admin(c);
    const tipo = c.req.query("tipo");
    const sujetoId = c.req.query("sujetoId");
    if (tipo !== undefined && !(EVENT_SUBJECTS as readonly string[]).includes(tipo)) throw Errors.validation(`tipo: ${EVENT_SUBJECTS.join(", ")}.`);
    if (sujetoId !== undefined) requireUuid(sujetoId, "sujetoId");
    const r = await guarded(() => privacyRepo(deps, c).listEvents(c.req.param("propertyId"), { subjectType: tipo as PrivacyEventRecord["subjectType"] | undefined, subjectId: sujetoId, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: r.available, items: r.items.map(serializeEvent) });
  });

  return app;
}
