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
import { CANCELAR_ROLES, cancelarOcupacion, crearReservaConfirmada, ESCRITURA_CALENDARIO_ROLES, modificarFechasReserva, RentasDomainError, tryEnqueueReservaEmail } from "@atiende/domain-rentas";
import type { RangoFechas } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

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
    // -- ningún HTTP route de este lote está montado todavía (ver README de
    // domain-rentas, sección "Fuera de fase"); estos casos existen únicamente para
    // que este switch exhaustivo siga compilando contra RentasErrorCode. ----
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
}

interface ModificarReservaBody {
  readonly rango?: unknown;
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

    const canalManual = await repo.findCanalPorCodigo("manual");
    if (!canalManual) throw new Error("Catálogo rentas.canal sin sembrar: falta el canal 'manual'.");

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
      // @atiende/domain-rentas::enqueueReservaEmailCore.
      await tryEnqueueReservaEmail(repo, organizationId, "reserva.creada", resultado.ocupacionId);

      return c.json({ id: resultado.ocupacionId, conflictosCapaCruzada: resultado.conflictosCapaCruzada.length }, 201);
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

    try {
      const resultado = await cancelarOcupacion(db, ocupacionId);
      return c.json({ id: ocupacionId, estado: "cancelado", estadoAnterior: resultado.estadoAnterior }, 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  return app;
}
