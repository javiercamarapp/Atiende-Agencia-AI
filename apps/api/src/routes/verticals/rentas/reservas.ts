// R1 · /rentas/:propertyId/unidades/:unidadId/reservas: crear/modificar/cancelar
// reserva directa con anti-doble-reserva de calendario (ver diseño Fase 1 rentas §4,
// Flujo 1). Motor transaccional SIEMPRE en @atiende/domain-rentas
// (crearReservaConfirmada/modificarFechasReserva/cancelarOcupacion) — la ruta le pasa
// el `TenantDbSession` del request DIRECTO (satisface `EjecutorTransaccional` por
// structural typing), igual que domain-hoteles NO envuelve folioEngine en el
// repository: aquí tampoco se envuelve aplicacion/reservas.ts.
//
// Igual que las rutas de hoteles (a diferencia de restaurantes, públicas/sin sesión de
// staff), las 3 rutas de rentas SÍ requieren sesión de staff: authMiddleware +
// dbSession + requirePropertyMembership("propertyId") (sin allowedRoles de
// plataforma — el filtrado fino ocurre con assertVerticalRole dentro de cada handler).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { calcularCotizacion, calcularMovimientoReserva, CANCELAR_ROLES, cancelarOcupacion, crearReservaConfirmada, ESCRITURA_CALENDARIO_ROLES, FINANZAS_ESCRITURA_ROLES, modificarFechasReserva, RentasDomainError, tryEnqueueReservaEmail } from "@atiende/domain-rentas";
import type { NewReservaFinancieroInput, RangoFechas, RentasRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { INLINE_BATCH_SIZE, runRentasEmailDispatch, triggerRentasEmailDispatchInline } from "./email-dispatch.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  }
  return value;
}

function requireRango(raw: unknown): RangoFechas {
  if (!raw || typeof raw !== "object") throw Errors.validation("rango: se esperaba un objeto {inicio, fin}.");
  const r = raw as { inicio?: unknown; fin?: unknown };
  return { inicio: requireFecha(r.inicio, "rango.inicio"), fin: requireFecha(r.fin, "rango.fin") };
}

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

/** Traduce un `RentasDomainError` al status HTTP correspondiente — mismo patrón que
 * `domain-hoteles::QuoteError` mapeado en quotes.ts. `ocupacion_no_encontrada` como
 * 404 es defensa en profundidad (la ruta ya verificó pertenencia antes de llamar al
 * motor), nunca la vía principal de un 404 legítimo. */
export function mapRentasDomainError(err: RentasDomainError): ApiError {
  switch (err.code) {
    case "rango_invalido":
      return Errors.validation(err.message);
    case "unidad_no_encontrada":
    case "ocupacion_no_encontrada":
      return Errors.notFound(err.message);
    case "duracion_minima_no_alcanzada":
    case "transicion_no_permitida":
      return Errors.conflict(err.message);
    case "reserva_no_directa":
      return Errors.rentasReservaNoDirecta();
    // ---- limpieza/mantenimiento (Fase 8, ver ../../../../packages/domain-rentas/src/limpieza/aplicacion/tareas.ts)
    // -- montado por HTTP en Fase 17 (ver ./limpieza.ts: asignarTarea/
    // completarChecklistItem/completarTarea/registrarIncidencia). ----
    case "tarea_no_encontrada":
    case "checklist_item_no_encontrado":
    case "item_inventario_no_encontrado":
    case "incidencia_no_encontrada":
      return Errors.notFound(err.message);
    case "checklist_incompleto":
    case "bloqueo_mantenimiento_ya_confirmado":
      return Errors.conflict(err.message);
    case "bloqueo_mantenimiento_no_aplicable":
    case "bloqueo_mantenimiento_sin_rango":
      return Errors.validation(err.message);
    // ---- onboarding self-serve (Fase 11, ver ../../../../packages/domain-rentas/src/onboarding/*) ----
    case "onboarding_datos_invalidos":
      return Errors.validation(err.message);
    case "onboarding_organizacion_duplicada":
      return Errors.conflict(err.message);
    // ---- finanzas (Rn-18, ver ../../../../packages/domain-rentas/src/finanzas/regla-comision-por-defecto.ts) ----
    case "regla_comision_no_configurada":
      return Errors.rentasComisionCanalSinRegla(err.message);
    // ---- importacion del reporte de pagos de la OTA (Rn-P3-06) ----
    case "formato_reporte_no_soportado":
      return new ApiError(422, "formato_reporte_no_soportado", err.message);
    case "reporte_invalido":
      return Errors.validation(err.message);
    default: {
      // Exhaustividad: si RentasErrorCode gana un valor nuevo sin actualizar este
      // mapeo, TypeScript marca `err.code` aquí como no asignable a `never`.
      const _exhaustive: never = err.code;
      return Errors.validation(String(_exhaustive));
    }
  }
}

interface ReservaBody {
  readonly rango?: unknown;
  readonly huespedNombre?: unknown;
  readonly huespedContacto?: unknown;
  // Rn-P3-07 -- movimiento financiero automatico de la reserva directa (todo opcional; sin monto nada cambia).
  readonly montoBrutoCentavos?: unknown;
  readonly moneda?: unknown;
  readonly cotizar?: unknown;
  readonly comisionGestorBasisPoints?: unknown;
  readonly comisionGestorBase?: unknown;
}

interface MovimientoDirectoPedido {
  readonly modo: "monto" | "cotizacion";
  readonly montoBrutoCentavos: number | null;
  readonly moneda: string | null;
  readonly comisionGestorBasisPoints: number;
  readonly comisionGestorBase: "bruto" | "neto_de_canal";
}

/** Valida los campos opcionales del movimiento automatico ANTES de crear la reserva. `null` = no se pidio movimiento. */
function leerMovimientoDirecto(raw: ReservaBody): MovimientoDirectoPedido | null {
  const pideMonto = raw.montoBrutoCentavos !== undefined && raw.montoBrutoCentavos !== null;
  const pideCotizar = raw.cotizar === true;
  if (!pideMonto && !pideCotizar) {
    if (raw.moneda !== undefined || raw.comisionGestorBasisPoints !== undefined || raw.comisionGestorBase !== undefined) {
      throw Errors.validation("moneda y comision del gestor solo aplican junto con montoBrutoCentavos o cotizar:true.");
    }
    return null;
  }
  if (pideMonto && pideCotizar) throw Errors.validation("Envia montoBrutoCentavos o cotizar:true, no ambos.");
  const bp = raw.comisionGestorBasisPoints;
  if (typeof bp !== "number" || !Number.isInteger(bp) || bp < 0 || bp > 10000) throw Errors.validation("comisionGestorBasisPoints: se esperaba un entero entre 0 y 10000 (se pide junto con el monto: no se asume 0 %).");
  if (raw.comisionGestorBase !== "bruto" && raw.comisionGestorBase !== "neto_de_canal") throw Errors.validation("comisionGestorBase: se esperaba 'bruto' | 'neto_de_canal'.");
  if (pideMonto) {
    const m = raw.montoBrutoCentavos;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0) throw Errors.validation("montoBrutoCentavos: se esperaba un entero >= 0 (centavos, nunca decimal).");
    if (typeof raw.moneda !== "string" || !/^[A-Z]{3}$/.test(raw.moneda)) throw Errors.validation("moneda: se esperaba un codigo ISO 4217 de 3 letras mayusculas.");
    return { modo: "monto", montoBrutoCentavos: m, moneda: raw.moneda, comisionGestorBasisPoints: bp, comisionGestorBase: raw.comisionGestorBase };
  }
  if (raw.moneda !== undefined) throw Errors.validation("Con cotizar:true la moneda sale de la tarifa de la unidad: no la envies.");
  return { modo: "cotizacion", montoBrutoCentavos: null, moneda: null, comisionGestorBasisPoints: bp, comisionGestorBase: raw.comisionGestorBase };
}

interface ModificarReservaBody {
  readonly rango?: unknown;
}

interface DatosMovimientoDirecto {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ocupacionId: string;
  readonly canalId: string;
  readonly userId: string;
  readonly monto: { readonly montoBrutoCentavos: number; readonly moneda: string };
  readonly pedido: MovimientoDirectoPedido;
}

/** Rn-P3-07 -- crea el `reserva_financiero` de una reserva directa con la regla del canal `manual` (0 pb por defecto, o la configurada).
 *  La columna `origen` es de la migracion 035: contra la base sin migrar se reintenta SIN ella (SAVEPOINT; el movimiento se crea igual). */
export async function crearMovimientoDeReservaDirecta(db: Parameters<typeof runWithSavepointFallback>[0]["session"], repo: RentasRepository, d: DatosMovimientoDirecto) {
  const comisionCanal = await repo.findReglaComisionCanal(d.propertyId, d.canalId);
  const calculo = calcularMovimientoReserva({
    ocupacionUnidadId: d.ocupacionId,
    moneda: d.monto.moneda,
    montoBrutoCentavos: d.monto.montoBrutoCentavos,
    comisionCanal,
    comisionGestor: { basisPoints: d.pedido.comisionGestorBasisPoints, base: d.pedido.comisionGestorBase },
    gastos: [],
    impuestos: [],
  });
  const base: NewReservaFinancieroInput = {
    organizationId: d.organizationId,
    propertyId: d.propertyId,
    ocupacionId: d.ocupacionId,
    moneda: d.monto.moneda,
    montoBrutoCentavos: d.monto.montoBrutoCentavos,
    yaNetoDeComision: comisionCanal.yaNetoDeComision,
    comisionCanalBasisPoints: comisionCanal.comisionBasisPoints,
    comisionCanalFuente: calculo.comisionCanalFuente,
    comisionCanalCentavos: calculo.comisionCanalCentavos,
    comisionGestorBasisPoints: d.pedido.comisionGestorBasisPoints,
    comisionGestorBase: d.pedido.comisionGestorBase,
    comisionGestorCentavos: calculo.comisionGestorCentavos,
    montoRecibidoCentavos: calculo.montoRecibidoCentavos,
    gastos: [],
    gastosCentavos: 0,
    impuestos: [],
    impuestosCentavos: 0,
    netoCentavos: calculo.netoCentavos,
    createdBy: d.userId,
  };
  await runWithSavepointFallback({
    session: db,
    primary: () => repo.insertReservaFinanciero({ ...base, origen: "directa_automatica" }),
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: () => repo.insertReservaFinanciero(base),
  });
  await repo.registrarAuditoria({
    organizationId: d.organizationId,
    actorUserId: d.userId,
    action: "reserva.movimiento_financiero_registrado",
    entityType: "reserva",
    entityId: d.ocupacionId,
    campo: "montoBrutoCentavos,netoCentavos",
    antes: null,
    despues: `bruto=${d.monto.montoBrutoCentavos} neto=${calculo.netoCentavos} ${d.monto.moneda} (automatico, reserva directa)`,
  });
  return { moneda: d.monto.moneda, montoBrutoCentavos: d.monto.montoBrutoCentavos, comisionCanalCentavos: calculo.comisionCanalCentavos, comisionGestorCentavos: calculo.comisionGestorCentavos, netoCentavos: calculo.netoCentavos, origen: "directa_automatica" as const };
}

export function rentasReservasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/unidades/:unidadId/reservas";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/:ocupacionId`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/:ocupacionId/cancelar`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    assertVerticalRole(c, ESCRITURA_CALENDARIO_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    // Defensa en profundidad: nunca confiar en que el cliente "sabe" que `unidadId`
    // pertenece a `propertyId" — el motor de dominio también lo verifica, pero un
    // 404 explícito aquí evita filtrar detalles del error interno.
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const raw = await readJsonCapped<ReservaBody>(c.req.raw, 4 * 1024);
    const rango = requireRango(raw.rango);
    const huespedNombre = requireOptionalString(raw.huespedNombre, "huespedNombre", 200);
    const huespedContacto = requireOptionalString(raw.huespedContacto, "huespedContacto", 200);
    const pedidoMovimiento = leerMovimientoDirecto(raw);
    // El movimiento financiero se escribe bajo la RLS de finanzas (solo admin_gestora): sin este rol previo el INSERT daba 42501 -> 500 y revertia la reserva.
    if (pedidoMovimiento !== null) assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);

    const canalManual = await repo.findCanalPorCodigo("manual");
    if (!canalManual) throw new Error("Catálogo rentas.canal sin sembrar: falta el canal 'manual'.");

    // Con cotizar:true el monto sale del cotizador y se resuelve ANTES de crear nada: sin tarifa configurada se rechaza la peticion
    // completa (422) en vez de crear una reserva que quedaria sin movimiento sin que nadie se entere.
    let montoMovimiento: { montoBrutoCentavos: number; moneda: string } | null = null;
    if (pedidoMovimiento?.modo === "monto") montoMovimiento = { montoBrutoCentavos: pedidoMovimiento.montoBrutoCentavos!, moneda: pedidoMovimiento.moneda! };
    if (pedidoMovimiento?.modo === "cotizacion") {
      const contexto = await repo.loadPricingContext(propertyId, unidadId);
      if (!contexto) throw new ApiError(422, "cotizacion_no_disponible", "La unidad no tiene una tarifa base configurada: no se puede cotizar. Configura la tarifa o envia montoBrutoCentavos.");
      const cotizacion = calcularCotizacion({ contexto, rango, reglaCanal: await repo.loadReglaCanalPricing(unidadId, canalManual.codigo) });
      montoMovimiento = { montoBrutoCentavos: cotizacion.totalCentavos, moneda: cotizacion.moneda };
    }

    try {
      const resultado = await crearReservaConfirmada(db, {
        organizationId,
        propertyId,
        unidadId,
        rango,
        estado: "confirmado",
        bloqueante: true,
        canalOrigenId: canalManual.id,
        externalId: null,
      });

      if (resultado.conflicto) {
        throw Errors.rentasUnidadNoDisponible(resultado.conflicto.conflictoId);
      }

      if (huespedNombre || huespedContacto) {
        const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre: huespedNombre, contacto: huespedContacto });
        await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);
      }

      // Fase 9 — correo de confirmación real al huésped (best-effort: nunca
      // convierte en error una reserva que ya se creó con éxito). Encola vía
      // rentas.messaging_outbox (channel='email'); el envío real por Resend lo hace
      // el dispatcher de POST /internal/rentas/email-dispatch. Sin correo real en
      // huespedContacto (o sin huésped adjunto) simplemente no encola nada — ver
      // @atiende/domain-rentas::enqueueReservaEmailCore. Hallazgo de auditoría a3 —
      // se pasa `db` (MISMA transacción que crearReservaConfirmada/insertGuestMinimo
      // de arriba) para que este best-effort corra protegido por SAVEPOINT: un error
      // real de Postgres aquí ya NO puede abortar la transacción y perder la reserva
      // que ya se creó con éxito (ver el comentario de cabecera de
      // tryEnqueueReservaEmail).
      await tryEnqueueReservaEmail(repo, organizationId, "reserva.creada", resultado.ocupacionId, db);
      // Cierre del hallazgo "rentas no tiene disparo inline de correo" (ver
      // ./email-dispatch.ts::triggerRentasEmailDispatchInline) — mismo `repo`/
      // transacción del request, best-effort real.
      await triggerRentasEmailDispatchInline(deps, db, repo);
      // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
      // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
      // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
      // sistema (runRentasEmailDispatch ya pasa el guard auth.uid() is null).
      c.get("postCommitTasks").push(() => runRentasEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));

      // Rn-P3-07 -- movimiento financiero en la MISMA transaccion que la reserva (si el insert falla, la reserva no se crea).
      const movimiento = montoMovimiento && pedidoMovimiento
        ? await crearMovimientoDeReservaDirecta(c.get("db"), repo, { organizationId, propertyId, ocupacionId: resultado.ocupacionId, canalId: canalManual.id, userId: c.get("userId"), monto: montoMovimiento, pedido: pedidoMovimiento })
        : null;

      return c.json({ id: resultado.ocupacionId, conflictosCapaCruzada: resultado.conflictosCapaCruzada.length, ...(movimiento ? { movimiento } : {}) }, 201);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  app.patch(`${base}/:ocupacionId`, async (c) => {
    assertVerticalRole(c, ESCRITURA_CALENDARIO_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const ocupacionId = c.req.param("ocupacionId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const ocupacion = await repo.findOcupacion(propertyId, unidadId, ocupacionId);
    if (!ocupacion) throw Errors.notFound("Reserva no encontrada en esta unidad.");
    if (ocupacion.capa !== "reserva") throw Errors.rentasReservaNoDirecta();

    // Nunca tocar una reserva de canal externo (regla heredada del origen, D-006/
    // D-011, se porta literal): solo se admite modificar una reserva sin canal de
    // origen o creada como 'manual' (reserva directa).
    const canalManual = await repo.findCanalPorCodigo("manual");
    if (ocupacion.canalOrigenId !== null && ocupacion.canalOrigenId !== canalManual?.id) {
      throw Errors.rentasReservaNoDirecta();
    }

    const raw = await readJsonCapped<ModificarReservaBody>(c.req.raw, 2 * 1024);
    const rango = requireRango(raw.rango);

    try {
      const resultado = await modificarFechasReserva(db, ocupacionId, rango);

      if (resultado.conflicto) {
        throw Errors.rentasUnidadNoDisponible(resultado.conflicto.conflictoId);
      }

      // r5 -- bitácora de auditoría (modificación de reserva). Nunca rompe esta
      // request si falla -- ver comentario de cabecera de
      // PostgresRentasRepository.registrarAuditoria.
      await repo.registrarAuditoria({
        organizationId: unidad.organizationId,
        actorUserId: c.get("userId"),
        action: "reserva.modificada",
        entityType: "reserva",
        entityId: ocupacionId,
        campo: "rango_fechas",
        antes: null,
        despues: `${resultado.rangoEfectivo.inicio} a ${resultado.rangoEfectivo.fin}`,
      });

      return c.json({ id: resultado.ocupacionId, rango: resultado.rangoEfectivo, conflictosCapaCruzada: resultado.conflictosCapaCruzada.length }, 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  app.post(`${base}/:ocupacionId/cancelar`, async (c) => {
    assertVerticalRole(c, CANCELAR_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const ocupacionId = c.req.param("ocupacionId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const ocupacion = await repo.findOcupacion(propertyId, unidadId, ocupacionId);
    if (!ocupacion) throw Errors.notFound("Reserva no encontrada en esta unidad.");
    if (ocupacion.capa !== "reserva") throw Errors.rentasReservaNoDirecta();

    // Rn-P3-29 -- misma guarda que `modificar` (D-006/D-011): una reserva importada
    // de un canal externo (Airbnb/Booking/Vrbo) NO se cancela desde aquí. Si se
    // cancelara, las noches quedarían libres en Atiende y en los feeds de
    // exportación mientras el canal sigue con la reserva viva (doble reserva
    // provocada por el propio producto). Solo se admite cancelar una reserva sin
    // canal de origen o del canal 'manual' (reserva directa).
    const canalManual = await repo.findCanalPorCodigo("manual");
    if (ocupacion.canalOrigenId !== null && ocupacion.canalOrigenId !== canalManual?.id) {
      throw Errors.rentasReservaNoDirecta();
    }

    try {
      const resultado = await cancelarOcupacion(db, ocupacionId);
      // r5 -- bitácora de auditoría (cancelación de reserva).
      await repo.registrarAuditoria({
        organizationId: unidad.organizationId,
        actorUserId: c.get("userId"),
        action: "reserva.cancelada",
        entityType: "reserva",
        entityId: ocupacionId,
        campo: "estado",
        antes: resultado.estadoAnterior,
        despues: "cancelado",
      });
      return c.json({ id: ocupacionId, estado: "cancelado", estadoAnterior: resultado.estadoAnterior }, 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  return app;
}
