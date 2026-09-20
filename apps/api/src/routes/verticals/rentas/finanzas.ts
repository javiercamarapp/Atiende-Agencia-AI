// R3 · POST/GET /rentas/:propertyId/reservas/:ocupacionId/movimiento — movimiento
// financiero de una reserva (split canal/gestor, regla Finanzas-1: si el canal ya
// entrega neto de su comisión, NUNCA se vuelve a restar sobre el bruto original). Es
// el único punto del repo origen donde un bug de cálculo cuesta dinero real (ver
// diseño Fase 1 rentas §1-#3, reemplazo honesto del "depósito de garantía" que no
// existe). Ningún cálculo de dinero vive en esta ruta: @atiende/domain-rentas decide
// toda la aritmética.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { calcularMovimientoReserva, FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES } from "@atiende/domain-rentas";
import type { LineaGastoEntrada, LineaImpuestoEntrada } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw Errors.validation(`${field}: se esperaba un entero >= 0 (centavos, nunca decimal).`);
  }
  return value;
}

function requireBasisPoints(value: unknown, field: string): number {
  const n = requireNonNegativeInteger(value, field);
  if (n > 10000) throw Errors.validation(`${field}: no puede exceder 10000 (100.00%).`);
  return n;
}

function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

function requireGastos(raw: unknown): LineaGastoEntrada[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("gastos: se esperaba un arreglo.");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw Errors.validation(`gastos[${index}]: se esperaba un objeto.`);
    const g = item as { tipo?: unknown; descripcion?: unknown; montoCentavos?: unknown };
    return {
      tipo: requireString(g.tipo, `gastos[${index}].tipo`, 60),
      descripcion: g.descripcion === undefined || g.descripcion === null ? null : requireString(g.descripcion, `gastos[${index}].descripcion`, 300),
      montoCentavos: requireNonNegativeInteger(g.montoCentavos, `gastos[${index}].montoCentavos`),
    };
  });
}

function requireImpuestos(raw: unknown): LineaImpuestoEntrada[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("impuestos: se esperaba un arreglo.");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw Errors.validation(`impuestos[${index}]: se esperaba un objeto.`);
    const i = item as { tipo?: unknown; montoCentavos?: unknown };
    return { tipo: requireString(i.tipo, `impuestos[${index}].tipo`, 60), montoCentavos: requireNonNegativeInteger(i.montoCentavos, `impuestos[${index}].montoCentavos`) };
  });
}

interface MovimientoBody {
  readonly moneda?: unknown;
  readonly montoBrutoCentavos?: unknown;
  readonly comisionGestorBasisPoints?: unknown;
  readonly comisionGestorBase?: unknown;
  readonly gastos?: unknown;
  readonly impuestos?: unknown;
}

function serializeMovimiento(m: { moneda: string; ingresoBrutoCentavos: number; montoRecibidoCentavos: number; comisionCanalCentavos: number; comisionCanalFuente: string; comisionGestorCentavos: number; gastosCentavos: number; impuestosCentavos: number; netoCentavos: number }) {
  return {
    moneda: m.moneda,
    ingresoBrutoCentavos: m.ingresoBrutoCentavos,
    montoRecibidoCentavos: m.montoRecibidoCentavos,
    comisionCanalCentavos: m.comisionCanalCentavos,
    comisionCanalFuente: m.comisionCanalFuente,
    comisionGestorCentavos: m.comisionGestorCentavos,
    gastosCentavos: m.gastosCentavos,
    impuestosCentavos: m.impuestosCentavos,
    netoCentavos: m.netoCentavos,
  };
}

export function rentasFinanzasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const path = "/rentas/:propertyId/reservas/:ocupacionId/movimiento";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(path, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const ocupacionId = c.req.param("ocupacionId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));

    const ocupacion = await repo.findOcupacionParaMovimiento(propertyId, ocupacionId);
    if (!ocupacion || ocupacion.capa !== "reserva") throw Errors.notFound("Reserva no encontrada en esta property.");

    const raw = await readJsonCapped<MovimientoBody>(c.req.raw, 8 * 1024);
    const moneda = requireString(raw.moneda, "moneda", 3);
    if (!/^[A-Z]{3}$/.test(moneda)) throw Errors.validation("moneda: se esperaba un código ISO 4217 de 3 letras mayúsculas.");
    const montoBrutoCentavos = requireNonNegativeInteger(raw.montoBrutoCentavos, "montoBrutoCentavos");
    const comisionGestorBasisPoints = requireBasisPoints(raw.comisionGestorBasisPoints, "comisionGestorBasisPoints");
    if (raw.comisionGestorBase !== "bruto" && raw.comisionGestorBase !== "neto_de_canal") {
      throw Errors.validation("comisionGestorBase: se esperaba 'bruto' | 'neto_de_canal'.");
    }
    const comisionGestorBase = raw.comisionGestorBase;
    const gastos = requireGastos(raw.gastos);
    const impuestos = requireImpuestos(raw.impuestos);

    // Resuelve la regla vigente: property específica primero, regla global del
    // tenant si no hay una específica (fail-closed si no hay ninguna configurada —
    // nunca asume una comisión de 0%).
    const comisionCanal = await repo.findReglaComisionCanal(propertyId, ocupacion.canalId);

    const movimiento = calcularMovimientoReserva({
      ocupacionUnidadId: ocupacionId,
      moneda,
      montoBrutoCentavos,
      comisionCanal,
      comisionGestor: { basisPoints: comisionGestorBasisPoints, base: comisionGestorBase },
      gastos,
      impuestos,
    });

    const created = await repo.insertReservaFinanciero({
      organizationId,
      propertyId,
      ocupacionId,
      moneda,
      montoBrutoCentavos,
      yaNetoDeComision: comisionCanal.yaNetoDeComision,
      comisionCanalBasisPoints: comisionCanal.comisionBasisPoints,
      comisionCanalFuente: movimiento.comisionCanalFuente,
      comisionCanalCentavos: movimiento.comisionCanalCentavos,
      comisionGestorBasisPoints,
      comisionGestorBase,
      comisionGestorCentavos: movimiento.comisionGestorCentavos,
      montoRecibidoCentavos: movimiento.montoRecibidoCentavos,
      gastos,
      gastosCentavos: movimiento.gastosCentavos,
      impuestos,
      impuestosCentavos: movimiento.impuestosCentavos,
      netoCentavos: movimiento.netoCentavos,
      createdBy: userId,
    });

    // f3-rentas-bitacora-y-guards -- bitácora de auditoría: "movimiento financiero
    // de una reserva (cargo/abono/ajuste)", uno de los 4 huecos que esta fase cierra
    // (ver migrations/023_rentas_audit_log_cobertura_completa.sql). Reutiliza
    // `entity_type = 'reserva'` -- misma entidad que reserva.creada/modificada/
    // cancelada (reservas.ts), nunca un catálogo nuevo solo para esta acción.
    // Best-effort real (nunca revierte el movimiento ya insertado, ver el
    // comentario de cabecera de `PostgresRentasRepository.registrarAuditoria`).
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: userId,
      action: "reserva.movimiento_financiero_registrado",
      entityType: "reserva",
      entityId: ocupacionId,
      campo: "montoBrutoCentavos,netoCentavos",
      antes: null,
      despues: `bruto=${montoBrutoCentavos} neto=${movimiento.netoCentavos} ${moneda}`,
    });

    return c.json({ id: created.id, ocupacionId, creadoEn: created.createdAt, ...serializeMovimiento(movimiento) }, 201);
  });

  app.get(path, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const ocupacionId = c.req.param("ocupacionId");
    const repo = deps.rentasRepo(c.get("db"));

    const movimiento = await repo.findReservaFinanciero(propertyId, ocupacionId);
    if (!movimiento) throw Errors.notFound("No hay movimiento financiero registrado para esta reserva.");

    return c.json({ ocupacionId, ...serializeMovimiento(movimiento) }, 200);
  });

  return app;
}
