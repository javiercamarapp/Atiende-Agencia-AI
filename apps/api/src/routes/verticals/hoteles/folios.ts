// H5 · /hoteles/:propertyId/folios: cargos/pagos/descuentos/reverso/transferencia/
// split/cierre. Port ~directo de hoteles/apps/api/src/routes/folios.ts (ver diseño
// Fase 1 hoteles §4.1). Motor de montos SIEMPRE en @atiende/domain-hoteles
// (computeChargeAmounts/evaluateDiscountAuthorization/evaluateFolioClose) — ningún
// cálculo de dinero vive en esta ruta ni se delega a un LLM. Reversos/transferencias
// NUNCA borran una fila: insertan una nueva y usan `markChargeReversed()` (equivalente
// a `hoteles.mark_charge_reversed()`, SECURITY DEFINER, ver migrations/002) para
// marcar el origen (REQ-REC-004).
//
// A diferencia de las rutas de restaurantes de Fase 1 (públicas/sin sesión de staff),
// las 3 rutas de hoteles SÍ requieren sesión de staff: authMiddleware + dbSession +
// requirePropertyMembership("propertyId") (sin allowedRoles de plataforma — el
// filtrado fino ocurre con assertVerticalRole(MONEY_ROLES/ADMIN_ROLES) dentro de cada
// handler, mismo patrón que hoy `assertRole(c, MONEY_ROLES)` en el origen).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  computeChargeAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  assertRoomChargeIdentityVerified,
  ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY,
  MONEY_ROLES,
  ADMIN_ROLES,
  IdempotencyConflictError,
  tryEnqueueGuestEmail,
  type ChargeConcept,
  type ChargeRecord,
  type PaymentRecord,
} from "@atiende/domain-hoteles";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { runHotelesEmailDispatch, triggerHotelesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

const CHARGE_CONCEPT_VALUES = new Set<ChargeConcept>(["hospedaje", "ab", "extras", "ajuste", "propina", "otro"]);

// Hallazgo de auditoría (ALTO, "packages/core-ratelimit cataloga la categoría
// 'billing:charge' -- CERRADA, ver endpoint-policy.ts: 'disparar cargos/cobros
// repetidos sin freno mueve dinero real' -- pero ningún handler real la invocaba").
// `POST .../folios/:folioId/pagos` con `metodo: "tarjeta"` es el único punto real de
// este monorepo que llama a un adaptador de cobro (`deps.hotelesPaymentsPort.charge`,
// producción = Stripe PaymentIntents, ver production/hoteles-payments-port.ts) -- la
// idempotency-key ya evita duplicar UN cargo ante un reintento idéntico, pero nunca
// frenó una ráfaga de intentos DISTINTOS (tokens/montos distintos) contra el mismo
// folio/property. Límite generoso para cobro real en un hotel (ningún staff cobra 15
// tarjetas en 5 minutos sobre el mismo folio en operación normal) y freno real contra
// un script de fraude probando tokens o un bug en bucle. Llave por IP + propertyId,
// mismo criterio que `mcp:cfdi`/`rentas:ical-feed-publico`.
const BILLING_CHARGE_RATE_LIMIT = { max: 15, windowMs: 5 * 60_000 } as const;

interface ChargeBody {
  readonly descripcion?: unknown;
  readonly monto?: unknown;
  readonly impuesto?: unknown;
  readonly concepto?: unknown;
  readonly verificacionIdentidad?: { apellido?: unknown; telefonoUlt4?: unknown } | null;
  readonly autorizacionIdentidadPorUserId?: unknown;
}

interface DiscountBody {
  readonly descripcion?: unknown;
  readonly monto?: unknown;
  readonly autorizadoPorUserId?: unknown;
}

interface ReversoBody {
  readonly motivo?: unknown;
}

interface TransferBody {
  readonly folioDestinoId?: unknown;
  readonly motivo?: unknown;
}

interface SplitBody {
  readonly etiqueta?: unknown;
  readonly chargeIds?: unknown;
}

interface PaymentBody {
  readonly monto?: unknown;
  readonly metodo?: unknown;
  readonly tokenPago?: unknown;
  readonly referenciaExterna?: unknown;
}

interface CloseBody {
  readonly motivo?: unknown;
  readonly autorizadoPorUserId?: unknown;
}

function requireString(value: unknown, field: string, { min = 1, max = 10000 }: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de ${min}-${max} caracteres.`);
  }
  return value.trim();
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw Errors.validation(`${field}: se esperaba un número positivo.`);
  }
  return value;
}

function parseChargeBody(raw: ChargeBody) {
  const descripcion = requireString(raw.descripcion, "descripcion", { max: 300 });
  const monto = requirePositiveNumber(raw.monto, "monto");
  const impuesto = raw.impuesto === undefined ? null : typeof raw.impuesto === "number" ? raw.impuesto : (() => {
    throw Errors.validation("impuesto: se esperaba un número.");
  })();
  const concepto: ChargeConcept = typeof raw.concepto === "string" && CHARGE_CONCEPT_VALUES.has(raw.concepto as ChargeConcept) ? (raw.concepto as ChargeConcept) : "otro";
  const verificacionIdentidad =
    raw.verificacionIdentidad && typeof raw.verificacionIdentidad === "object"
      ? {
          apellido: requireString(raw.verificacionIdentidad.apellido, "verificacionIdentidad.apellido", { max: 120 }),
          telefonoUlt4: requireString(raw.verificacionIdentidad.telefonoUlt4, "verificacionIdentidad.telefonoUlt4", { min: 4, max: 4 }),
        }
      : null;
  const autorizacionIdentidadPorUserId = typeof raw.autorizacionIdentidadPorUserId === "string" ? raw.autorizacionIdentidadPorUserId : null;
  return { descripcion, monto, impuesto, concepto, verificacionIdentidad, autorizacionIdentidadPorUserId };
}

function computeBalance(charges: readonly ChargeRecord[], payments: readonly PaymentRecord[]): number {
  const totalCharges = charges.reduce((sum, ch) => sum + ch.amount + ch.taxAmount, 0);
  const totalPayments = payments.filter((p) => p.status === "capturado").reduce((sum, p) => sum + p.amount, 0);
  return Math.round((totalCharges - totalPayments) * 100) / 100;
}

function serializeFolio(deps: { id: string; status: string; reservationId: string; label: string; isPrimary: boolean; closedAt: string | null; closeReason: string | null; charges: readonly ChargeRecord[]; payments: readonly PaymentRecord[] }) {
  return {
    id: deps.id,
    estado: deps.status,
    reservationId: deps.reservationId,
    etiqueta: deps.label,
    esPrincipal: deps.isPrimary,
    cerradoEn: deps.closedAt,
    motivoCierre: deps.closeReason,
    cargos: deps.charges.map((ch) => ({
      id: ch.id,
      concepto: ch.concept,
      descripcion: ch.description,
      monto: ch.amount,
      impuesto: ch.taxAmount,
      revertidoPor: ch.reversedBy,
      reversaDe: ch.reversesChargeId,
      transferidoDe: ch.transferredFromChargeId,
      creadoEn: ch.createdAt,
    })),
    pagos: deps.payments.map((p) => ({
      id: p.id,
      monto: p.amount,
      metodo: p.method,
      estado: p.status,
      referenciaExterna: p.externalRef,
      creadoEn: p.createdAt,
    })),
    saldo: computeBalance(deps.charges, deps.payments),
  };
}

export function hotelesFoliosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/folios/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/reservas/:reservationId/folios", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/hoteles/:propertyId/reservas/:reservationId/folios", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const folios = await repo.listFoliosByReservation(c.req.param("propertyId"), c.req.param("reservationId"));
    return c.json(folios.map(serializeFolio));
  });

  app.get("/hoteles/:propertyId/folios/:folioId", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(c.req.param("propertyId"), c.req.param("folioId"));
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    return c.json(serializeFolio(folio));
  });

  app.post("/hoteles/:propertyId/folios/:folioId/cargos", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const verticalRole = c.get("verticalRole")!;
    const raw = await readJsonCapped<ChargeBody>(c.req.raw, 8 * 1024);
    const body = parseChargeBody(raw);

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos cargos.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "charge.create", key: idempotencyKey, body }, async () => {
        // REQ-AB-012: la verificación corre por el CONCEPTO REAL del cargo, nunca
        // condicionada a que el cliente haya elegido declararla.
        if (ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY.has(body.concepto)) {
          const guest = await repo.loadFolioGuestIdentity(folio.reservationId);
          const authorizedByAdmin = body.autorizacionIdentidadPorUserId ? await repo.isAdminStaff(propertyId, body.autorizacionIdentidadPorUserId) : false;
          const verification = assertRoomChargeIdentityVerified({
            concept: body.concepto,
            claim: body.verificacionIdentidad ? { declaredLastName: body.verificacionIdentidad.apellido, declaredPhoneLast4: body.verificacionIdentidad.telefonoUlt4 } : null,
            guestLastName: guest.lastName,
            guestPhoneLast4: guest.phoneLast4,
            actorHasAdminRole: (ADMIN_ROLES as readonly string[]).includes(verticalRole),
            authorizedByAdminUserId: authorizedByAdmin ? body.autorizacionIdentidadPorUserId : null,
          });
          if (!verification.allowed) throw Errors.forbidden(verification.reason);
        }

        // F1/REQ-BO-001: el impuesto SIEMPRE lo calcula el motor determinista desde
        // hoteles.tax_config — un cliente (incluido un rol de dinero) JAMÁS puede
        // fijarlo. Si igual lo manda, se exige que coincida EXACTO (tolerancia de un
        // centavo) con lo calculado aquí.
        const taxConfig = await repo.loadTaxConfig(propertyId);
        const calc = computeChargeAmounts({ concept: body.concepto, netAmount: body.monto, taxConfig });
        if (body.impuesto != null && Math.abs(body.impuesto - calc.taxAmount) > 0.01) {
          throw Errors.impuestoNoCoincide(calc.taxAmount, body.impuesto);
        }

        const created = await repo.insertCharge({
          organizationId,
          propertyId,
          folioId,
          description: body.descripcion,
          amount: calc.netAmount,
          taxAmount: calc.taxAmount,
          concept: body.concepto,
        });
        return { status: 201, body: { id: created.id, concepto: body.concepto, monto: calc.netAmount, impuesto: calc.taxAmount } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/descuentos", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const verticalRole = c.get("verticalRole")!;
    const raw = await readJsonCapped<DiscountBody>(c.req.raw, 4 * 1024);
    const descripcion = requireString(raw.descripcion, "descripcion", { max: 300 });
    const monto = requirePositiveNumber(raw.monto, "monto");
    const autorizadoPorUserId = typeof raw.autorizadoPorUserId === "string" ? raw.autorizadoPorUserId : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite descuentos.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "charge.discount", key: idempotencyKey, body: { descripcion, monto, autorizadoPorUserId } }, async () => {
        const { discountThreshold } = await repo.loadTaxConfig(propertyId);
        const authorizedByAdmin = autorizadoPorUserId ? await repo.isAdminStaff(propertyId, autorizadoPorUserId) : false;
        const authorization = evaluateDiscountAuthorization({
          amount: monto,
          thresholdAmount: discountThreshold,
          actorHasAdminRole: (ADMIN_ROLES as readonly string[]).includes(verticalRole),
          authorizedByAdminUserId: authorizedByAdmin ? autorizadoPorUserId : null,
        });
        if (!authorization.allowed) throw Errors.forbidden(authorization.reason);

        const created = await repo.insertCharge({
          organizationId,
          propertyId,
          folioId,
          description: descripcion,
          amount: -Math.abs(monto),
          taxAmount: 0,
          concept: "descuento",
          discountAuthorizedBy: autorizadoPorUserId,
        });
        return { status: 201, body: { id: created.id, monto } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/cargos/:chargeId/reverso", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const chargeId = c.req.param("chargeId");
    const raw = await readJsonCapped<ReversoBody>(c.req.raw, 2 * 1024);
    const motivo = requireString(raw.motivo, "motivo", { max: 300 });

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite reversos.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "charge.reverse", key: idempotencyKey, body: { chargeId, motivo } }, async () => {
        const original = await repo.findCharge(folioId, chargeId);
        if (!original) throw Errors.notFound("Cargo no encontrado en este folio.");
        if (original.reversedBy) throw Errors.conflict("Este cargo ya fue reversado anteriormente.");
        if (original.concept === "reverso") throw Errors.conflict("No se puede reversar un reverso.");

        const reversal = await repo.insertCharge({
          organizationId,
          propertyId,
          folioId,
          description: `Reverso: ${original.description} (${motivo})`,
          amount: -original.amount,
          taxAmount: -original.taxAmount,
          concept: "reverso",
          reversesChargeId: original.id,
        });
        await repo.markChargeReversed(original.id, reversal.id);
        return { status: 201, body: { id: reversal.id, reversaDe: original.id } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/cargos/:chargeId/transferir", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const chargeId = c.req.param("chargeId");
    const raw = await readJsonCapped<TransferBody>(c.req.raw, 2 * 1024);
    const folioDestinoId = requireString(raw.folioDestinoId, "folioDestinoId", { max: 200 });
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : undefined;

    if (folioDestinoId === folioId) throw Errors.validation("El folio destino no puede ser el mismo folio origen.");

    const repo = deps.hotelesRepo(c.get("db"));
    try {
      const result = await repo.withIdempotency({ organizationId, scope: "charge.transfer", key: idempotencyKey, body: { chargeId, folioDestinoId, motivo } }, async () => {
        const source = await repo.findFolio(propertyId, folioId);
        const destination = await repo.findFolio(propertyId, folioDestinoId);
        if (!source) throw Errors.notFound("Folio origen no encontrado.");
        if (!destination) throw Errors.notFound("Folio destino no encontrado.");
        if (source.status !== "abierto") throw Errors.conflict("El folio origen está cerrado.");
        if (destination.status !== "abierto") throw Errors.conflict("El folio destino está cerrado.");

        const original = await repo.findCharge(folioId, chargeId);
        if (!original) throw Errors.notFound("Cargo no encontrado en el folio origen.");
        if (original.reversedBy) throw Errors.conflict("Este cargo ya fue reversado/transferido anteriormente.");
        if (original.concept === "reverso" || original.concept === "descuento") {
          throw Errors.validation("Solo se transfieren cargos reales, no reversos/descuentos.");
        }

        const reversal = await repo.insertCharge({
          organizationId,
          propertyId,
          folioId,
          description: `Transferido a otro folio: ${original.description}`,
          amount: -original.amount,
          taxAmount: -original.taxAmount,
          concept: "reverso",
          reversesChargeId: original.id,
        });
        await repo.markChargeReversed(original.id, reversal.id);

        const created = await repo.insertCharge({
          organizationId,
          propertyId,
          folioId: folioDestinoId,
          description: original.description,
          amount: original.amount,
          taxAmount: original.taxAmount,
          concept: original.concept,
          transferredFromChargeId: original.id,
        });

        return { status: 201, body: { id: created.id, folioDestinoId } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/split", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const raw = await readJsonCapped<SplitBody>(c.req.raw, 4 * 1024);
    const etiqueta = requireString(raw.etiqueta, "etiqueta", { max: 80 });
    if (!Array.isArray(raw.chargeIds) || raw.chargeIds.length === 0 || !raw.chargeIds.every((id) => typeof id === "string")) {
      throw Errors.validation("chargeIds: se esperaba un arreglo no vacío de ids.");
    }
    const chargeIds = raw.chargeIds as string[];

    const repo = deps.hotelesRepo(c.get("db"));
    try {
      const result = await repo.withIdempotency({ organizationId, scope: "folio.split", key: idempotencyKey, body: { etiqueta, chargeIds } }, async () => {
        const source = await repo.findFolio(propertyId, folioId);
        if (!source) throw Errors.notFound("Folio origen no encontrado.");
        if (source.status !== "abierto") throw Errors.conflict("El folio origen está cerrado.");

        const newFolio = await repo.createFolio(propertyId, organizationId, source.reservationId, etiqueta);

        for (const chargeId of chargeIds) {
          const original = await repo.findCharge(folioId, chargeId);
          if (!original) throw Errors.notFound(`Cargo ${chargeId} no encontrado en el folio origen.`);
          if (original.reversedBy) throw Errors.conflict(`El cargo ${chargeId} ya fue reversado/transferido.`);
          if (original.concept === "reverso" || original.concept === "descuento") {
            throw Errors.validation("Solo se transfieren cargos reales en un split, no reversos/descuentos.");
          }

          const reversal = await repo.insertCharge({
            organizationId,
            propertyId,
            folioId,
            description: `Movido al folio "${etiqueta}": ${original.description}`,
            amount: -original.amount,
            taxAmount: -original.taxAmount,
            concept: "reverso",
            reversesChargeId: original.id,
          });
          await repo.markChargeReversed(original.id, reversal.id);

          await repo.insertCharge({
            organizationId,
            propertyId,
            folioId: newFolio.id,
            description: original.description,
            amount: original.amount,
            taxAmount: original.taxAmount,
            concept: original.concept,
            transferredFromChargeId: original.id,
          });
        }

        return { status: 201, body: { id: newFolio.id, etiqueta } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/pagos", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const raw = await readJsonCapped<PaymentBody>(c.req.raw, 4 * 1024);
    const monto = requirePositiveNumber(raw.monto, "monto");
    if (raw.metodo !== "efectivo" && raw.metodo !== "transferencia" && raw.metodo !== "tarjeta") {
      throw Errors.validation("metodo: se esperaba efectivo|transferencia|tarjeta.");
    }
    const metodo = raw.metodo;
    const tokenPago = typeof raw.tokenPago === "string" ? raw.tokenPago : undefined;
    const referenciaExterna = typeof raw.referenciaExterna === "string" ? raw.referenciaExterna : null;

    if (metodo === "tarjeta" && !tokenPago) {
      throw Errors.validation("Un pago con tarjeta requiere tokenPago (nunca se acepta un número de tarjeta).");
    }

    // Hallazgo de auditoría (ALTO) — ver comentario de cabecera del archivo. Solo el
    // método que de verdad dispara un cargo real (tarjeta -> PaymentsPort.charge)
    // consume este cupo; efectivo/transferencia son registro manual sin llamada a un
    // procesador externo, no el "cobro repetido que mueve dinero real" que cataloga
    // 'billing:charge'. Evaluado ANTES de tocar `repo`/el folio, para que una ráfaga
    // ni siquiera pague el costo de esa consulta.
    if (metodo === "tarjeta") {
      const chargeAllowed = await rateLimit(`billing:charge:${requestActor(c.req.raw, propertyId)}`, BILLING_CHARGE_RATE_LIMIT.max, BILLING_CHARGE_RATE_LIMIT.windowMs, {
        category: "billing:charge",
      });
      if (!chargeAllowed) throw Errors.tooManyRequests("Demasiados intentos de cobro para esta property. Intenta de nuevo en unos minutos.");
    }

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    if (folio.status !== "abierto") throw Errors.conflict("El folio está cerrado: no admite nuevos pagos.");

    try {
      const result = await repo.withIdempotency({ organizationId, scope: "payment.create", key: idempotencyKey, body: { monto, metodo, tokenPago, referenciaExterna } }, async () => {
        let status: "capturado" | "pendiente" | "fallido" = "capturado";
        let externalRef: string | null = referenciaExterna;
        let tokenRef: string | null = null;

        if (metodo === "tarjeta") {
          const paymentResult = await deps.hotelesPaymentsPort.charge({
            amount: monto,
            currency: "MXN",
            paymentMethodToken: tokenPago!,
            idempotencyKey: `${organizationId}:${folioId}:${idempotencyKey}`,
          });
          status = paymentResult.status;
          externalRef = paymentResult.externalPaymentId;
          tokenRef = paymentResult.externalPaymentId;
        }

        const created = await repo.insertPayment({ organizationId, propertyId, folioId, amount: monto, method: metodo, status, externalRef, tokenRef });
        return { status: 201, body: { id: created.id, monto, metodo, estado: status } };
      });
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw err;
    }
  });

  app.post("/hoteles/:propertyId/folios/:folioId/cerrar", async (c) => {
    assertVerticalRole(c, MONEY_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const folioId = c.req.param("folioId");
    const verticalRole = c.get("verticalRole")!;
    const userId = c.get("userId");
    const raw = await readJsonCapped<CloseBody>(c.req.raw, 2 * 1024);
    if (raw.motivo !== "saldo_cero" && raw.motivo !== "cuenta_por_cobrar") {
      throw Errors.validation("motivo: se esperaba saldo_cero|cuenta_por_cobrar.");
    }
    const motivo = raw.motivo;
    const autorizadoPorUserId = typeof raw.autorizadoPorUserId === "string" ? raw.autorizadoPorUserId : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const folio = await repo.findFolio(propertyId, folioId);
    if (!folio) throw Errors.notFound("Folio no encontrado.");
    if (folio.status !== "abierto") throw Errors.conflict("El folio ya está cerrado.");

    const balance = computeBalance(folio.charges, folio.payments);
    const authorizedByOtherAdmin = autorizadoPorUserId ? await repo.isAdminStaff(propertyId, autorizadoPorUserId) : false;
    const evaluation = evaluateFolioClose({
      balance,
      reason: motivo,
      actorHasAdminRole: (ADMIN_ROLES as readonly string[]).includes(verticalRole) || authorizedByOtherAdmin,
    });
    if (!evaluation.allowed) throw Errors.conflict(evaluation.reason ?? "No se puede cerrar el folio con estos parámetros.");

    const arApprovedBy = motivo === "cuenta_por_cobrar" ? (autorizadoPorUserId ?? userId) : null;
    await repo.closeFolio(folioId, motivo, arApprovedBy);

    // Hallazgo ALTA — recibo real por correo al huésped al cerrar su cuenta
    // (best-effort: sin correo en archivo, o cualquier otra falla, NUNCA tumba el
    // cierre de folio ya persistido). Mismos totales que `serializeFolio`/`balance`
    // de arriba, nunca recalculados aparte.
    const totalCargos = folio.charges.reduce((sum, ch) => sum + ch.amount + ch.taxAmount, 0);
    const totalPagos = folio.payments.filter((p) => p.status === "capturado").reduce((sum, p) => sum + p.amount, 0);
    await tryEnqueueGuestEmail(repo, propertyId, organizationId, "folio.closed", folio.reservationId, {
      folio: { folioId, label: folio.label, closeReason: motivo, totalCargos, totalPagos, saldo: balance },
    });
    // Cluster #3 (CRÍTICO) de la auditoría final — disparo inline best-effort del
    // correo recién encolado arriba, mismo `repo`/transacción (ver comentario de
    // cabecera de email-dispatch.ts), en vez de esperar al cron diario. Ruta de
    // sesión de STAFF (ver `app.use` de arriba): `db` es el MISMO
    // `TenantDbSession` de esta transacción, necesario para el SAVEPOINT del
    // hotfix de auditoría a2 (ver comentario de cabecera de la función). En
    // sesión de staff este intento SIEMPRE es un no-op seguro (42501, guard de
    // sesión de sistema) -- el envío real lo hace la tarea post-commit de abajo.
    await triggerHotelesEmailDispatchInline(deps, c.get("db"), repo);
    // Arreglo de fondo (auditoría a2, parte 3) — el drenado real solo puede
    // pasar DESPUÉS de que esta transacción confirme, en sesión de SISTEMA
    // (runHotelesEmailDispatch ya existe y pasa el guard auth.uid() is null).
    // Encolar aquí una sesión nueva DENTRO de este request no sirve: no vería
    // el correo recién encolado sin commit (ver citas/email-dispatch.ts).
    c.get("postCommitTasks").push(() => runHotelesEmailDispatch(deps).then(() => undefined));

    return c.json({ id: folioId, estado: "cerrado", motivoCierre: motivo, saldo: balance });
  });

  return app;
}
