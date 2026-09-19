// Fase 5 hoteles (H5, REQ-BO-001/002) — CFDI 4.0 de hospedaje. Port de
// hoteles/apps/api/src/routes/cfdi.ts sobre el `CfdiPort` de `@atiende/mcp-cfdi`
// (dual-PAC, ya construido en esta fase) + el motor de reglas fiscales de
// `@atiende/domain-hoteles::validarCfdiHospedaje`/`computeCfdiHospedajeBreakdown` —
// esta ruta NO reimplementa ningún cálculo fiscal, solo orquesta: lee cargos del
// folio, calcula el desglose, valida ANTES de timbrar (nunca se envía un CFDI mal
// formado a un PAC real — a diferencia de despachos/cfdi.ts, que ingiere un
// comprobante YA timbrado por un tercero), y persiste el resultado.
//
// Timbrado idempotente por folio+tipo (REQ-BO-002): reintentar la misma emisión
// devuelve el mismo UUID, delegado al propio `CfdiPort` (idempotente por
// `input.folio`) Y al índice único parcial de la migración
// (`cfdi_emision_folio_hospedaje_unq`/`..._payment_unq`).
//
// Propina NUNCA entra al subtotal (excluida del CFDI, ver
// `summarizeFacturableCharges`); los reversos ya vienen con monto negativo y
// cancelan naturalmente al cargo original que reversaron.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { CfdiFolioStampingInProgressError, PortUnavailableError } from "@atiende/mcp-cfdi";
import {
  CFDI_HOSPEDAJE_ROLES,
  IdempotencyConflictError,
  computeCfdiHospedajeBreakdown,
  resolveReceptorHospedaje,
  summarizeFacturableCharges,
  validarCfdiHospedaje,
  validateAnticipoRelacion,
  ReceptorHospedajeInvalidoError,
  tryEnqueueGuestEmail,
  type CfdiEmisionRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { triggerHotelesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

// Hallazgo de auditoría (ALTO, "packages/core-ratelimit cataloga la categoría
// 'mcp:cfdi' -- CERRADA, ver endpoint-policy.ts -- pero ningún handler real la
// invocaba: apps/api solo conectaba auth:login/auth:token-issue/auth:accept-invite/
// rentas:ical-feed-publico"). Cada ruta de este archivo que de verdad llama a
// `deps.hotelesCfdiPort` (timbrar hospedaje/pago, cancelar, consultar estado) paga
// dinero real por llamada de más al PAC (Finkok/SW Sapien) y arriesga folios/UUID
// duplicados ante el SAT -- exactamente la razón ya documentada de 'mcp:cfdi' en
// endpoint-policy.ts, nunca conectada hasta este fix. Límite generoso para operación
// real de un hotel (ningún staff timbra/cancela/consulta 20 CFDI en 5 minutos desde la
// misma IP+property en uso normal) y freno real contra un script/bug en bucle o una
// integración mal configurada reintentando sin control. Llave por IP + propertyId
// (mismo criterio que `rentas:ical-feed-publico`): un ataque no debe poder abrir cupo
// nuevo por folio/cfdiId, y una IP compartida (NAT de oficina) no debe agotar el cupo
// de otra property.
const CFDI_PAC_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;

// Hallazgo auditoría — en producción `deps.hotelesCfdiPort` es
// `DualPacCfdiPort(FinkokAdapter, SwSapienAdapter)`, y AMBOS adaptadores son
// esqueletos honestos que lanzan `PortUnavailableError` de forma INCONDICIONAL
// (sin CSD/credenciales reales de Finkok/SW Sapien configuradas en este entorno,
// ver comentario de cabecera de finkok-adapter.ts/sw-sapien-adapter.ts). Antes de
// este fix ese error llegaba tal cual a `app.onError` (app.ts), que solo conoce
// `ApiError` -- cualquier otro error se aplana a un 500 genérico "Error interno",
// indistinguible en la UI de un bug real. `DualPacCfdiPort.timbrar` envuelve el
// fallo de ambos PAC en un `AggregateError`; `.cancelar`/`.consultarEstado`
// intentan el primario y, si falla, propagan tal cual el error del secundario (un
// `PortUnavailableError` sin envolver). Se detectan ambas formas para responder
// 503 honesto en vez de un 500 que sugiere un bug.
function isPacUnavailableError(err: unknown): boolean {
  if (err instanceof PortUnavailableError) return true;
  if (err instanceof AggregateError) return err.errors.every((e) => e instanceof PortUnavailableError);
  return false;
}

function pacUnavailableApiError(accion: string) {
  return Errors.serviceUnavailable(
    `El servicio de timbrado CFDI (PAC) no está disponible en este entorno: no hay credenciales reales de Finkok/SW Sapien configuradas, así que no se pudo ${accion}. Esto es esperado en este ambiente (sin CSD/credenciales de un PAC real) -- configura las variables de entorno del PAC para habilitarlo.`,
  );
}

interface EmitirHospedajeBody {
  readonly rfcReceptor?: unknown;
  readonly usoCfdi?: unknown;
  readonly metodoPago?: unknown;
  readonly esExtranjero?: unknown;
  readonly esGlobal?: unknown;
  readonly esNoShow?: unknown;
  readonly esAplicacionAnticipo?: unknown;
  /** UUID de nuestro propio `cfdi_emision` de un anticipo previo. */
  readonly cfdiRelacionados?: unknown;
  readonly tipoRelacion?: unknown;
}

interface EmitirPagoBody {
  readonly paymentId?: unknown;
  readonly relacionadoCfdiId?: unknown;
}

interface CancelarBody {
  readonly motivo?: unknown;
  readonly folioSustitucion?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

interface EmitirHospedajeParsed {
  readonly rfcReceptor: string | undefined;
  readonly usoCfdi: string | undefined;
  readonly metodoPago: "PUE" | "PPD";
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
  readonly esAplicacionAnticipo: boolean;
  readonly cfdiRelacionados: readonly string[] | undefined;
  readonly tipoRelacion: string | undefined;
}

function parseEmitirHospedajeBody(raw: EmitirHospedajeBody): EmitirHospedajeParsed {
  const esExtranjero = raw.esExtranjero === true;
  const esGlobal = raw.esGlobal === true;
  const esNoShow = raw.esNoShow === true;
  const esAplicacionAnticipo = raw.esAplicacionAnticipo === true;
  const metodoPago: "PUE" | "PPD" = raw.metodoPago === "PPD" ? "PPD" : "PUE"; // default PUE, mismo que el original
  const cfdiRelacionados = Array.isArray(raw.cfdiRelacionados) ? (raw.cfdiRelacionados as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  const tipoRelacion = typeof raw.tipoRelacion === "string" ? raw.tipoRelacion : undefined;

  let rfcReceptor: string | undefined;
  let usoCfdi: string | undefined;
  if (!esExtranjero && !esGlobal) {
    rfcReceptor = requireString(raw.rfcReceptor, "rfcReceptor");
    usoCfdi = requireString(raw.usoCfdi, "usoCfdi");
  } else {
    if (raw.rfcReceptor !== undefined && typeof raw.rfcReceptor !== "string") throw Errors.validation("rfcReceptor: se esperaba un texto.");
    if (raw.usoCfdi !== undefined && typeof raw.usoCfdi !== "string") throw Errors.validation("usoCfdi: se esperaba un texto.");
  }

  return { rfcReceptor, usoCfdi, metodoPago, esExtranjero, esGlobal, esNoShow, esAplicacionAnticipo, cfdiRelacionados, tipoRelacion };
}

function serializeCfdi(record: CfdiEmisionRecord) {
  return {
    id: record.id,
    folioId: record.folioId,
    tipo: record.tipo,
    uuidFiscal: record.uuidFiscal,
    estado: record.status,
    pac: record.pac,
    subtotal: record.subtotal,
    iva: record.iva,
    impuestosLocales: { ishTasa: record.ishTasa, ishMonto: record.ishMonto, dsaMonto: record.dsaMonto },
    total: record.total,
    rfcReceptor: record.rfcReceptor,
    usoCfdi: record.usoCfdi,
    metodoPago: record.metodoPago,
    esExtranjero: record.esExtranjero,
    esGlobal: record.esGlobal,
    esNoShow: record.esNoShow,
    relacionadoCfdiId: record.relatedCfdiId,
    creadoEn: record.createdAt,
    canceladoEn: record.canceledAt,
  };
}

export function hotelesCfdiRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/folios/:folioId/cfdi/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/folios/:folioId/cfdi", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/cfdi/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/cfdi", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/hoteles/:propertyId/cfdi", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const cfdis = await repo.listCfdiEmisiones(c.req.param("propertyId"));
    return c.json(cfdis.map(serializeCfdi));
  });

  app.get("/hoteles/:propertyId/folios/:folioId/cfdi", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const cfdis = await repo.listCfdiEmisiones(c.req.param("propertyId"), { folioId: c.req.param("folioId") });
    return c.json(cfdis.map(serializeCfdi));
  });

  app.post("/hoteles/:propertyId/folios/:folioId/cfdi", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");

    const pacAllowed = await rateLimit(`mcp:cfdi:${requestActor(c.req.raw, propertyId)}`, CFDI_PAC_RATE_LIMIT.max, CFDI_PAC_RATE_LIMIT.windowMs, {
      category: "mcp:cfdi",
    });
    if (!pacAllowed) throw Errors.tooManyRequests("Demasiadas solicitudes de CFDI para esta property. Intenta de nuevo en unos minutos.");

    const raw = await readJsonCapped<EmitirHospedajeBody>(c.req.raw, 8 * 1024);
    const body = parseEmitirHospedajeBody(raw);

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");

    // REQ-BO-002: si este folio YA tiene un CFDI de hospedaje VIGENTE, se devuelve
    // tal cual (mismo UUID) sin volver a llamar al PAC — verificado ANTES de
    // `withIdempotency` para que también cubra un reintento con una Idempotency-Key
    // DISTINTA.
    //
    // Fix hallazgo auditoría — un CFDI "cancelado" NO cuenta para este corto-
    // circuito: normalmente SÍ debe poder reemitirse con un folio fiscal nuevo
    // (práctica estándar SAT tras una cancelación), y bloquearlo aquí para
    // siempre era el bug real. El índice único parcial de la migración
    // 015_cfdi_hospedaje_reemision_tras_cancelacion.sql (que reemplaza al de
    // 006_cfdi_hospedaje.sql) ahora solo exige UN hospedaje VIGENTE por folio, no
    // uno para siempre — este chequeo de aplicación reflaja esa misma regla.
    const existing = await repo.findCfdiEmisionByFolio(propertyId, folioId, "hospedaje");
    if (existing && existing.status !== "cancelado") return c.json(serializeCfdi(existing), 200);

    let receptor: { rfcReceptor: string; usoCfdi: string };
    try {
      receptor = resolveReceptorHospedaje({ esExtranjero: body.esExtranjero, esGlobal: body.esGlobal, rfcReceptor: body.rfcReceptor, usoCfdi: body.usoCfdi });
    } catch (err) {
      if (err instanceof ReceptorHospedajeInvalidoError) throw Errors.validation(err.message);
      throw err;
    }

    const anticipoIssue = validateAnticipoRelacion({ esAplicacionAnticipo: body.esAplicacionAnticipo, cfdiRelacionados: body.cfdiRelacionados, tipoRelacion: body.tipoRelacion });
    if (anticipoIssue) throw Errors.cfdiHospedajeInvalido([anticipoIssue.codigo]);

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "cfdi.hospedaje", key: idempotencyKey, body: { folioId, ...body } }, async () => {
        const fiscalConfig = await repo.loadHospedajeFiscalConfig(propertyId);
        if (!fiscalConfig.rfcEmisor) throw Errors.validation("Este hotel no tiene RFC emisor configurado todavía: no se puede timbrar CFDI.");

        const { ivaRate } = await repo.loadTaxConfig(propertyId);
        const charges = await repo.listChargesForCfdi(folioId);
        const resumen = summarizeFacturableCharges(charges);
        if (resumen.subtotalBase <= 0) throw Errors.conflict("El folio no tiene cargos facturables (fuera de propina) para timbrar un CFDI.");

        const breakdown = computeCfdiHospedajeBreakdown({ resumen, ivaRate, dsaPerNight: fiscalConfig.dsaPerNight });

        const validacion = validarCfdiHospedaje({
          rfcEmisor: fiscalConfig.rfcEmisor,
          rfcReceptor: receptor.rfcReceptor,
          usoCfdi: receptor.usoCfdi,
          metodoPago: body.metodoPago,
          regimenFiscalEmisor: "601",
          subtotal: breakdown.netAmount,
          iva: breakdown.ivaAmount,
          ishMonto: breakdown.ishAmount,
          dsaMonto: breakdown.dsaMonto,
          descuento: 0,
          total: breakdown.total,
          esExtranjero: body.esExtranjero,
          esGlobal: body.esGlobal,
          esNoShow: body.esNoShow,
          esAplicacionAnticipo: body.esAplicacionAnticipo,
          cfdiRelacionados: body.cfdiRelacionados,
          tipoRelacion: body.tipoRelacion,
        });
        if (!validacion.ok) throw Errors.cfdiHospedajeInvalido(validacion.issues.map((i) => i.codigo));

        // Fix hallazgo auditoría — el `folio` es la clave de idempotencia del PAC
        // (mismo criterio que un PAC real de producción: reenviar el mismo folio
        // con el mismo contenido devuelve el timbrado YA existente en vez de
        // generar uno nuevo, ver FakeGenericPacAdapter.timbrar). Si este folio de
        // hospedaje ya tuvo un CFDI cancelado antes (`existing`, resuelto arriba
        // del `withIdempotency`), reusar el MISMO string de folio para el PAC
        // congelaría cualquier reemisión al UUID cancelado para siempre —
        // exactamente el bug que este fix corrige. Se distingue con el id del
        // CFDI cancelado que se está reemplazando para que el PAC timbre un
        // comprobante genuinamente nuevo (UUID distinto) en cada reemisión.
        const pacFolio = existing ? `${folioId}:hospedaje:reemision:${existing.id}` : `${folioId}:hospedaje`;
        const timbrado = await deps.hotelesCfdiPort.timbrar({
          folio: pacFolio,
          rfcEmisor: fiscalConfig.rfcEmisor,
          rfcReceptor: receptor.rfcReceptor,
          subtotal: breakdown.netAmount,
          iva: breakdown.ivaAmount,
          impuestosLocales: { ishTasa: fiscalConfig.ishRate, ishMonto: breakdown.ishAmount, dsaMonto: breakdown.dsaMonto },
          total: breakdown.total,
          moneda: "MXN",
          usoCfdi: receptor.usoCfdi,
          metodoPago: body.metodoPago,
        });

        const created = await repo.insertCfdiEmision({
          organizationId,
          propertyId,
          folioId,
          tipo: "hospedaje",
          uuidFiscal: timbrado.uuid,
          status: timbrado.status,
          pac: timbrado.pac,
          subtotal: breakdown.netAmount,
          iva: breakdown.ivaAmount,
          ishTasa: fiscalConfig.ishRate,
          ishMonto: breakdown.ishAmount,
          dsaMonto: breakdown.dsaMonto,
          total: breakdown.total,
          rfcReceptor: receptor.rfcReceptor,
          usoCfdi: receptor.usoCfdi,
          metodoPago: body.metodoPago,
          esExtranjero: body.esExtranjero,
          esGlobal: body.esGlobal,
          esNoShow: body.esNoShow,
          relatedCfdiId: body.cfdiRelacionados?.[0] ?? null,
          paymentId: null,
        });

        // Hallazgo ALTA — aviso real por correo al huésped de que su CFDI de
        // hospedaje ya quedó timbrado (best-effort: sin correo en archivo, o
        // cualquier otra falla, NUNCA tumba un CFDI ya timbrado y persistido).
        // Solo si el PAC de verdad devolvió un UUID fiscal (nunca un aviso de
        // "disponible" sobre un timbrado sin UUID real).
        if (created.uuidFiscal) {
          await tryEnqueueGuestEmail(repo, propertyId, organizationId, "cfdi.issued", folio.reservationId, {
            cfdi: { uuidFiscal: created.uuidFiscal, total: created.total, folioLabel: folio.label },
          });
          // Cluster #3 (CRÍTICO) de la auditoría final — disparo inline
          // best-effort del correo recién encolado arriba, mismo
          // `repo`/transacción (ver comentario de cabecera de email-dispatch.ts).
          // Ruta de sesión de STAFF, dentro de `repo.withIdempotency` (arriba),
          // DESPUÉS de timbrar en el PAC: sin el SAVEPOINT del hotfix de
          // auditoría a2, la transacción abortada hacía fallar con 500 el UPDATE
          // de `idempotency_key` de abajo -- un CFDI YA timbrado en el PAC, sin
          // registro local, y un reintento con la misma Idempotency-Key
          // re-timbraba (la llave también se revertía).
          await triggerHotelesEmailDispatchInline(deps, c.get("db"), repo);
        }

        return { status: 201 as const, body: serializeCfdi(created) };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      if (err instanceof CfdiFolioStampingInProgressError) throw Errors.cfdiTimbradoEnCurso();
      if (isPacUnavailableError(err)) throw pacUnavailableApiError("timbrar el CFDI de hospedaje");
      throw err;
    }
  });

  // Complemento de pago: CFDI tipo 'pago' que referencia el CFDI de hospedaje (PPD)
  // al que corresponde — subtotal/IVA en $0 (el impuesto ya se declaró en el CFDI
  // original), total = monto del pago.
  app.post("/hoteles/:propertyId/folios/:folioId/cfdi/pago", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");

    const pacAllowed = await rateLimit(`mcp:cfdi:${requestActor(c.req.raw, propertyId)}`, CFDI_PAC_RATE_LIMIT.max, CFDI_PAC_RATE_LIMIT.windowMs, {
      category: "mcp:cfdi",
    });
    if (!pacAllowed) throw Errors.tooManyRequests("Demasiadas solicitudes de CFDI para esta property. Intenta de nuevo en unos minutos.");

    const raw = await readJsonCapped<EmitirPagoBody>(c.req.raw, 2 * 1024);
    const paymentId = requireString(raw.paymentId, "paymentId");
    const relacionadoCfdiId = requireString(raw.relacionadoCfdiId, "relacionadoCfdiId");

    const repo = deps.hotelesRepo(c.get("db"));
    const existing = await repo.findCfdiEmisionByPayment(propertyId, paymentId);
    if (existing) return c.json(serializeCfdi(existing), 200);

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "cfdi.pago", key: idempotencyKey, body: { folioId, paymentId, relacionadoCfdiId } }, async () => {
        const folio = await repo.findFolio(propertyId, folioId);
        if (!folio) throw Errors.notFound("Folio no encontrado.");
        const payment = folio.payments.find((p) => p.id === paymentId);
        if (!payment) throw Errors.notFound("Pago no encontrado en este folio.");
        if (payment.status !== "capturado") throw Errors.conflict("Solo se emite complemento de pago sobre un pago capturado.");

        const related = await repo.findCfdiEmision(propertyId, relacionadoCfdiId);
        if (!related || related.folioId !== folioId) throw Errors.notFound("El CFDI de hospedaje relacionado no existe en este folio.");

        const fiscalConfig = await repo.loadHospedajeFiscalConfig(propertyId);
        if (!fiscalConfig.rfcEmisor) throw Errors.validation("Este hotel no tiene RFC emisor configurado todavía.");

        const timbrado = await deps.hotelesCfdiPort.timbrar({
          folio: `${folioId}:pago:${paymentId}`,
          rfcEmisor: fiscalConfig.rfcEmisor,
          rfcReceptor: related.rfcReceptor,
          subtotal: 0,
          iva: 0,
          impuestosLocales: { ishTasa: 0, ishMonto: 0 },
          total: payment.amount,
          moneda: "MXN",
          usoCfdi: "CP01",
          metodoPago: "PPD",
        });

        const created = await repo.insertCfdiEmision({
          organizationId,
          propertyId,
          folioId,
          tipo: "pago",
          uuidFiscal: timbrado.uuid,
          status: timbrado.status,
          pac: timbrado.pac,
          subtotal: 0,
          iva: 0,
          ishTasa: 0,
          ishMonto: 0,
          dsaMonto: 0,
          total: payment.amount,
          rfcReceptor: related.rfcReceptor,
          usoCfdi: "CP01",
          metodoPago: "PPD",
          esExtranjero: false,
          esGlobal: false,
          esNoShow: false,
          relatedCfdiId: relacionadoCfdiId,
          paymentId,
        });

        return { status: 201 as const, body: serializeCfdi(created) };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      if (err instanceof CfdiFolioStampingInProgressError) throw Errors.cfdiTimbradoEnCurso();
      if (isPacUnavailableError(err)) throw pacUnavailableApiError("timbrar el complemento de pago");
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/cfdi/:cfdiId/cancelar", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const propertyId = c.req.param("propertyId");
    const cfdiId = c.req.param("cfdiId");

    const pacAllowed = await rateLimit(`mcp:cfdi:${requestActor(c.req.raw, propertyId)}`, CFDI_PAC_RATE_LIMIT.max, CFDI_PAC_RATE_LIMIT.windowMs, {
      category: "mcp:cfdi",
    });
    if (!pacAllowed) throw Errors.tooManyRequests("Demasiadas solicitudes de CFDI para esta property. Intenta de nuevo en unos minutos.");

    const raw = await readJsonCapped<CancelarBody>(c.req.raw, 2 * 1024);
    if (raw.motivo !== "01" && raw.motivo !== "02" && raw.motivo !== "03" && raw.motivo !== "04") {
      throw Errors.validation("motivo: se esperaba 01|02|03|04 (catálogo SAT c_MotivoCancelacion).");
    }
    const motivo = raw.motivo;
    const folioSustitucion = typeof raw.folioSustitucion === "string" ? raw.folioSustitucion : undefined;

    const repo = deps.hotelesRepo(c.get("db"));
    const cfdi = await repo.findCfdiEmision(propertyId, cfdiId);
    if (!cfdi) throw Errors.notFound("CFDI no encontrado.");
    if (!cfdi.uuidFiscal) throw Errors.conflict("Este CFDI no tiene UUID fiscal (no fue timbrado con éxito).");
    if (cfdi.status === "cancelado") throw Errors.conflict("Este CFDI ya está cancelado.");

    let cancelacion: Awaited<ReturnType<AppDeps["hotelesCfdiPort"]["cancelar"]>>;
    try {
      cancelacion = await deps.hotelesCfdiPort.cancelar({ uuid: cfdi.uuidFiscal, motivo, folioSustitucion, idempotencyKey });
    } catch (err) {
      if (isPacUnavailableError(err)) throw pacUnavailableApiError("cancelar el CFDI");
      throw err;
    }
    // Hallazgo auditoría — el PAC puede devolver 'en_proceso_cancelacion' (el
    // proceso de aceptación/rechazo de cancelación 2022+ del SAT no es
    // instantáneo): `updateCfdiEmisionCancelacion` NUNCA marca `canceledAt` salvo
    // que el status sea 'cancelado' de verdad (ver su propio comentario) -- antes
    // de este fix se marcaba `canceled_at = now()` con CUALQUIER status devuelto
    // por el PAC, dejando el registro con fecha de cancelación pero sin haber
    // cancelado en realidad, y sin ninguna ruta que permitiera consultar el
    // estado real después (ver endpoint .../consultar-estado más abajo).
    await repo.updateCfdiEmisionCancelacion(cfdiId, cancelacion.status);

    return c.json({ id: cfdiId, estado: cancelacion.status });
  });

  // Hallazgo auditoría — 'en_proceso_cancelacion' era un callejón sin salida: una
  // vez que el PAC devolvía ese status desde /cancelar, ninguna ruta invocaba
  // jamás `CfdiPort.consultarEstado`, así que el CFDI se quedaba para siempre sin
  // confirmar si el SAT terminó aceptando o rechazando la cancelación (y, por el
  // corto-circuito de idempotencia de arriba y el índice único parcial de
  // 015_cfdi_hospedaje_reemision_tras_cancelacion.sql, tampoco se podía reemitir
  // mientras tanto -- correcto, sigue "vigente"). Ruta manual (staff con acceso a
  // CFDI, mismo rol que cancelar) en vez de un cron interno de plataforma: a
  // diferencia de los cron sweep de rentas (ver checkout-sweep-cron.ts), aquí no
  // hay forma de recorrer TODOS los CFDI pendientes cross-organización sin
  // tropezar con el mismo bloqueador de RLS ya documentado ahí
  // (`withAppSession({ userId: null })` nunca satisface
  // `hoteles.can_access_money(property_id)`) -- una ruta manual por CFDI, scopeada
  // a la property vía `requirePropertyMembership`, evita ese problema y le da al
  // staff un botón real para desatorar el estado (ver botón en Cfdi.tsx).
  app.post("/hoteles/:propertyId/cfdi/:cfdiId/consultar-estado", async (c) => {
    assertVerticalRole(c, CFDI_HOSPEDAJE_ROLES);
    const propertyId = c.req.param("propertyId");
    const cfdiId = c.req.param("cfdiId");

    const pacAllowed = await rateLimit(`mcp:cfdi:${requestActor(c.req.raw, propertyId)}`, CFDI_PAC_RATE_LIMIT.max, CFDI_PAC_RATE_LIMIT.windowMs, {
      category: "mcp:cfdi",
    });
    if (!pacAllowed) throw Errors.tooManyRequests("Demasiadas solicitudes de CFDI para esta property. Intenta de nuevo en unos minutos.");

    const repo = deps.hotelesRepo(c.get("db"));
    const cfdi = await repo.findCfdiEmision(propertyId, cfdiId);
    if (!cfdi) throw Errors.notFound("CFDI no encontrado.");
    if (!cfdi.uuidFiscal) throw Errors.conflict("Este CFDI no tiene UUID fiscal (no fue timbrado con éxito): no hay nada que consultar contra el PAC.");
    if (cfdi.status !== "en_proceso_cancelacion") {
      throw Errors.conflict(`Este CFDI está en estado "${cfdi.status}", no en proceso de cancelación: no hay nada pendiente que consultar contra el PAC.`);
    }

    let estadoReal: CfdiEmisionRecord["status"];
    try {
      estadoReal = await deps.hotelesCfdiPort.consultarEstado(cfdi.uuidFiscal);
    } catch (err) {
      if (isPacUnavailableError(err)) throw pacUnavailableApiError("consultar el estado real de la cancelación");
      throw err;
    }

    // Solo se persiste cuando el PAC YA confirmó 'cancelado' -- si sigue
    // 'en_proceso_cancelacion' (SAT todavía no resuelve) o si el PAC informa que
    // la cancelación fue rechazada, este endpoint es de solo consulta: el estado
    // almacenado no se toca para no inventar una transición que el motivo de
    // cancelación conocido no sustenta, y el staff puede reintentar la consulta
    // más tarde.
    if (estadoReal === "cancelado") {
      await repo.updateCfdiEmisionCancelacion(cfdiId, "cancelado");
    }

    const actual = estadoReal === "cancelado" ? await repo.findCfdiEmision(propertyId, cfdiId) : cfdi;
    return c.json({ ...serializeCfdi(actual ?? cfdi), estadoReal });
  });

  return app;
}
