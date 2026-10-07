// L-27 -- post-adjudicacion estructurada: garantias (cumplimiento, anticipo, vicios ocultos), hitos con responsable,
// convenios modificatorios y plazos de firma/entrega de garantia, por contrato.
//
//   GET   .../tenders/:tenderId/contract/post-award                    resumen completo (cualquier miembro)
//   PUT   .../contract/post-award/plazos        { falloNotificadoEn?, plazoFirmaDias?, firmadoEn?, plazoGarantiaDias? }   (WRITE_ROLES)
//   POST  .../contract/post-award/garantias     { tipo, monto, vigenciaDesde, vigenciaHasta, ... }                         (WRITE_ROLES + Idempotency-Key)
//   PATCH .../contract/post-award/garantias/:id { campos y/o estado }   liberar/ejecutar -> DECISION_ROLES, el resto WRITE_ROLES
//   POST  .../contract/post-award/hitos         { titulo, responsableId, fechaCompromiso, ... }                            (WRITE_ROLES + Idempotency-Key)
//   PATCH .../contract/post-award/hitos/:id     { campos y/o estado: cumplido | cancelado }                                (WRITE_ROLES)
//   POST  .../contract/post-award/convenios     { tipo, montoDelta?, nuevaFechaFin?, fechaFirma, motivo }                  (DECISION_ROLES + step-up + Idempotency-Key)
//   GET   .../contract/post-award/bitacora      bitacora append-only del contrato (cualquier miembro)
//   GET   .../contract/post-award/responsables  staff de la organizacion (selector de responsable)
//
// El servidor es la unica autoridad: valida la entrada (montos como cadena decimal, fechas reales, tipos y estados
// cerrados), calcula los plazos en dias HABILES con el calendario efectivo (L-22) y deja la bitacora en la base. La
// RLS y los triggers de la migracion 035 vuelven a exigir roles y la maquina de estados (defensa en profundidad).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (migracion 035): el repositorio lanza `PostAdjudicacionNotAvailableError` dentro
// de SAVEPOINT. Lecturas -> `available: false` con el resto vacio; escrituras -> 503. Nunca un 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  DECISION_ROLES,
  GARANTIA_ESTADOS_DE_DECISION,
  IdempotencyConflictError,
  PLAZOS_POST_ADJUDICACION_NORMA_ID,
  PostAdjudicacionForbiddenError,
  PostAdjudicacionNotAvailableError,
  PostAdjudicacionNotFoundError,
  PostAdjudicacionStateError,
  PostAdjudicacionValidationError,
  WRITE_ROLES,
  calcularPlazos,
  calendarioAvisos,
  evaluarGarantia,
  evaluarHito,
  mexicoCityDateKey,
  parseConvenioInput,
  parseGarantiaInput,
  parseGarantiaPatch,
  parseHitoInput,
  parseHitoPatch,
  parsePlazosInput,
  resumirPostAdjudicacion,
} from "@atiende/domain-licitaciones";
import type { ContractRecord, LicitacionesRepository, PostAdjudicacionRepository } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { requireStepUp } from "../../../second-factor.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveCalendarioFor } from "./calendario.ts";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY_BYTES = 16 * 1024;

/** Errores tipados del dominio -> errores HTTP. El resto se repropaga. */
function mapError(err: unknown): never {
  if (err instanceof PostAdjudicacionValidationError) throw Errors.validation(err.message);
  if (err instanceof PostAdjudicacionStateError) throw Errors.conflict(err.message);
  if (err instanceof PostAdjudicacionForbiddenError) throw Errors.forbidden(err.message);
  if (err instanceof PostAdjudicacionNotFoundError) throw Errors.notFound(err.message);
  if (err instanceof PostAdjudicacionNotAvailableError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
  throw err;
}

function hoyIso(): string {
  return mexicoCityDateKey(new Date());
}

export function licitacionesPostAdjudicacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/contract/post-award";
  const factory = deps.licitacionesPostAdjudicacionRepo;

  app.use(`${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function requireContract(repo: LicitacionesRepository, organizationId: string, tenderId: string): Promise<ContractRecord> {
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const contract = await repo.findContractByTender(organizationId, tenderId);
    if (!contract) throw Errors.notFound("No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract.");
    return contract;
  }

  function requireFactory(): NonNullable<typeof factory> {
    if (!factory) throw Errors.serviceUnavailable("El seguimiento de garantías, hitos y convenios aún no está disponible en este ambiente.");
    return factory;
  }

  function requireIdempotencyKey(c: { req: { header: (n: string) => string | undefined } }): string {
    const key = c.req.header("idempotency-key");
    if (!key) throw Errors.idempotencyRequired();
    return key;
  }

  function isDecisionRole(role: string | undefined): boolean {
    return role !== undefined && (DECISION_ROLES as readonly string[]).includes(role);
  }

  async function buildOverview(c: Parameters<typeof resolveCalendarioFor>[1], repo: PostAdjudicacionRepository, contract: ContractRecord) {
    const organizationId = c.get("organizationId");
    const hoy = hoyIso();
    const calendario = await resolveCalendarioFor(deps, c, contract.tenderId);
    // En SECUENCIA, no en Promise.all: las 4 lecturas comparten la MISMA sesion transaccional y cada una
    // abre su SAVEPOINT (runWithSavepointFallback). Concurrentes, la cola SAVEPOINT a,b,c,d ... RELEASE a
    // destruye b..d y la transaccion termina abortada (3B001 / 25P02 -> ROLLBACK).
    const plazos = await repo.getPlazos(organizationId, contract.id);
    const garantias = await repo.listGarantias(organizationId, contract.id);
    const hitos = await repo.listHitos(organizationId, contract.id);
    const convenios = await repo.listConvenios(organizationId, contract.id);
    const calculados = calcularPlazos(plazos, calendario, hoy);
    const avisos = [calculados.fechaLimiteFirma, calculados.fechaLimiteEntregaGarantia].flatMap((f) => (f && plazos ? calendarioAvisos(calendario, plazos.falloNotificadoEn ?? plazos.firmadoEn ?? f, f) : []));
    return {
      available: true as const,
      hoy,
      contract: { id: contract.id, status: contract.status, endDate: contract.endDate },
      plazos,
      plazosCalculados: { ...calculados, avisos: [...new Set(avisos)] },
      garantias: garantias.map((g) => ({ ...g, vigencia: evaluarGarantia(g, hoy) })),
      hitos: hitos.map((h) => ({ ...h, vigencia: evaluarHito(h, hoy) })),
      convenios,
      resumen: resumirPostAdjudicacion({ garantias, hitos, convenios }, hoy),
    };
  }

  app.get(base, async (c) => {
    const licRepo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const contract = await requireContract(licRepo, organizationId, c.req.param("tenderId"));
    const permisos = { puedeEscribir: (WRITE_ROLES as readonly string[]).includes(c.get("verticalRole") ?? ""), puedeDecidir: isDecisionRole(c.get("verticalRole")) };
    if (!factory) return c.json({ available: false, hoy: hoyIso(), normaId: PLAZOS_POST_ADJUDICACION_NORMA_ID, ...permisos });
    try {
      const overview = await buildOverview(c, factory(c.get("db")), contract);
      return c.json({ ...overview, normaId: PLAZOS_POST_ADJUDICACION_NORMA_ID, ...permisos });
    } catch (err) {
      if (err instanceof PostAdjudicacionNotAvailableError) return c.json({ available: false, hoy: hoyIso(), normaId: PLAZOS_POST_ADJUDICACION_NORMA_ID, ...permisos });
      throw err;
    }
  });

  app.get(`${base}/bitacora`, async (c) => {
    const organizationId = c.get("organizationId");
    const contract = await requireContract(deps.licitacionesRepo(c.get("db")), organizationId, c.req.param("tenderId"));
    if (!factory) return c.json({ available: false, bitacora: [] });
    try {
      return c.json({ available: true, bitacora: await factory(c.get("db")).listBitacora(organizationId, contract.id, 100) });
    } catch (err) {
      if (err instanceof PostAdjudicacionNotAvailableError) return c.json({ available: false, bitacora: [] });
      throw err;
    }
  });

  app.get(`${base}/responsables`, async (c) => {
    const organizationId = c.get("organizationId");
    await requireContract(deps.licitacionesRepo(c.get("db")), organizationId, c.req.param("tenderId"));
    if (!factory) return c.json({ available: false, responsables: [] });
    try {
      return c.json({ available: true, responsables: await factory(c.get("db")).listResponsables(organizationId) });
    } catch (err) {
      if (err instanceof PostAdjudicacionNotAvailableError) return c.json({ available: false, responsables: [] });
      throw err;
    }
  });

  app.put(`${base}/plazos`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    const contract = await requireContract(deps.licitacionesRepo(c.get("db")), organizationId, c.req.param("tenderId"));
    try {
      const input = parsePlazosInput(raw);
      const repo = requireFactory()(c.get("db"));
      const plazos = await repo.upsertPlazos(organizationId, contract.id, input, c.get("userId"));
      const calendario = await resolveCalendarioFor(deps, c, contract.tenderId);
      const calculados = calcularPlazos(plazos, calendario, hoyIso());
      // La fecha limite de entrega de las garantias de cumplimiento aun pendientes sigue a los plazos nuevos.
      let garantiasActualizadas = 0;
      if (calculados.fechaLimiteEntregaGarantia) garantiasActualizadas = await repo.setLimiteEntregaPendientes(organizationId, contract.id, calculados.fechaLimiteEntregaGarantia);
      return c.json({ plazos, plazosCalculados: calculados, garantiasActualizadas });
    } catch (err) {
      return mapError(err);
    }
  });

  app.post(`${base}/garantias`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const key = requireIdempotencyKey(c);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    const licRepo = deps.licitacionesRepo(c.get("db"));
    const contract = await requireContract(licRepo, organizationId, c.req.param("tenderId"));
    try {
      const input = parseGarantiaInput(raw);
      const repo = requireFactory()(c.get("db"));
      const result = await licRepo.withIdempotency({ organizationId, scope: `postadj.garantia.create:${contract.id}`, key, body: raw }, async () => {
        let fechaLimiteEntrega = input.fechaLimiteEntrega ?? null;
        if (input.fechaLimiteEntrega === undefined && input.tipo === "cumplimiento" && !input.entregadaEn) {
          // Sin fecha declarada, la limite se calcula de los plazos del contrato en dias habiles (si ya se conocen).
          const calendario = await resolveCalendarioFor(deps, c, contract.tenderId);
          fechaLimiteEntrega = calcularPlazos(await repo.getPlazos(organizationId, contract.id), calendario, hoyIso()).fechaLimiteEntregaGarantia;
        }
        const garantia = await repo.createGarantia(organizationId, contract.id, { ...input, fechaLimiteEntrega }, c.get("userId"));
        return { status: 201, body: { ...garantia, vigencia: evaluarGarantia(garantia, hoyIso()) } };
      });
      return c.json(result.body, result.status as 201);
    } catch (err) {
      return mapError(err);
    }
  });

  app.patch(`${base}/garantias/:id`, async (c) => {
    const organizationId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id: se esperaba un UUID.");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    try {
      const parsed = parseGarantiaPatch(raw);
      // Liberar o ejecutar una garantia es una decision; editar o marcarla entregada/vencida, redaccion.
      const decide = parsed.estado !== undefined && GARANTIA_ESTADOS_DE_DECISION.includes(parsed.estado);
      assertVerticalRole(c, decide ? DECISION_ROLES : WRITE_ROLES);
      const contract = await requireContract(deps.licitacionesRepo(c.get("db")), organizationId, c.req.param("tenderId"));
      const repo = requireFactory()(c.get("db"));
      const actual = await repo.getGarantia(organizationId, id);
      if (!actual || actual.contractId !== contract.id) throw Errors.notFound("Garantía no encontrada.");
      // Marcarla entregada sin fecha: hoy (la base exige fecha de entrega para una garantia entregada).
      const patch = parsed.estado === "entregada" && parsed.entregadaEn === undefined ? { ...parsed, entregadaEn: hoyIso() } : parsed;
      const garantia = await repo.updateGarantia(organizationId, id, patch, { userId: c.get("userId"), canDecide: isDecisionRole(c.get("verticalRole")) });
      return c.json({ ...garantia, vigencia: evaluarGarantia(garantia, hoyIso()) });
    } catch (err) {
      return mapError(err);
    }
  });

  app.post(`${base}/hitos`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const key = requireIdempotencyKey(c);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    const licRepo = deps.licitacionesRepo(c.get("db"));
    const contract = await requireContract(licRepo, organizationId, c.req.param("tenderId"));
    try {
      const input = parseHitoInput(raw);
      const repo = requireFactory()(c.get("db"));
      // El responsable debe ser staff de la MISMA organizacion (la base lo exige tambien por RLS).
      const responsables = await repo.listResponsables(organizationId);
      if (!responsables.some((r) => r.userId === input.responsableId)) throw Errors.validation("responsableId: debe ser un miembro del equipo de tu organización.");
      const result = await licRepo.withIdempotency({ organizationId, scope: `postadj.hito.create:${contract.id}`, key, body: raw }, async () => {
        const hito = await repo.createHito(organizationId, contract.id, input, c.get("userId"));
        return { status: 201, body: { ...hito, vigencia: evaluarHito(hito, hoyIso()) } };
      });
      return c.json(result.body, result.status as 201);
    } catch (err) {
      return mapError(err);
    }
  });

  app.patch(`${base}/hitos/:id`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id: se esperaba un UUID.");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    const contract = await requireContract(deps.licitacionesRepo(c.get("db")), organizationId, c.req.param("tenderId"));
    try {
      const patch = parseHitoPatch(raw, hoyIso());
      const repo = requireFactory()(c.get("db"));
      const actual = await repo.getHito(organizationId, id);
      if (!actual || actual.contractId !== contract.id) throw Errors.notFound("Hito no encontrado.");
      if (patch.responsableId !== undefined) {
        const responsables = await repo.listResponsables(organizationId);
        if (!responsables.some((r) => r.userId === patch.responsableId)) throw Errors.validation("responsableId: debe ser un miembro del equipo de tu organización.");
      }
      const hito = await repo.updateHito(organizationId, id, patch, { userId: c.get("userId"), canDecide: isDecisionRole(c.get("verticalRole")) });
      return c.json({ ...hito, vigencia: evaluarHito(hito, hoyIso()) });
    } catch (err) {
      return mapError(err);
    }
  });

  app.post(`${base}/convenios`, async (c) => {
    // Un convenio modificatorio cambia monto y/o plazo del contrato: decision (como "modificar" en la maquina de
    // estados) y, ademas, segundo factor reciente cuando la base ya tiene la migracion de 2FA (L-01).
    assertVerticalRole(c, DECISION_ROLES);
    const key = requireIdempotencyKey(c);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    await requireStepUp(deps, { userId: c.get("userId"), organizationId, scope: "contract_sensitive", token: c.req.header("x-step-up-token"), db: c.get("db") });
    const licRepo = deps.licitacionesRepo(c.get("db"));
    const contract = await requireContract(licRepo, organizationId, c.req.param("tenderId"));
    try {
      const input = parseConvenioInput(raw);
      const repo = requireFactory()(c.get("db"));
      const result = await licRepo.withIdempotency({ organizationId, scope: `postadj.convenio.create:${contract.id}`, key, body: raw }, async () => {
        const convenio = await repo.createConvenio(organizationId, contract.id, input, c.get("userId"), contract.endDate);
        // La nueva fecha de fin pasa al contrato en la MISMA transaccion (la base tambien lo hace con un trigger: es idempotente).
        let endDate = contract.endDate;
        if (convenio.nuevaFechaFin) {
          const updated = await licRepo.updateContractMetadata(organizationId, contract.tenderId, { endDate: convenio.nuevaFechaFin });
          endDate = updated.endDate;
        }
        return { status: 201, body: { convenio, contratoFechaFin: endDate } };
      });
      return c.json(result.body, result.status as 201);
    } catch (err) {
      return mapError(err);
    }
  });

  return app;
}
