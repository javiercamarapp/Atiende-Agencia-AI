// Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
// tarifas/huéspedes imposible sin SQL directo -- POST /reservas depende de
// tarifas sembradas manualmente"): hasta este archivo, `hoteles.room_type`/
// `hoteles.room`/`hoteles.rate_plan` solo tenían GRANT de SELECT para
// `authenticated` (ver migrations/001_hoteles_schema.sql) -- sin una sola tarifa
// sembrada por SQL directo, `POST .../reservas` SIEMPRE fallaba con `sin_tarifa`
// (quote.ts). Ver migrations/018_admin_catalogo_alta.sql para el GRANT/policy real
// (`hoteles.can_manage_catalog()`, owner/gm) que habilita las 4 rutas de este
// archivo.
//
// Alta de HUÉSPED (`POST .../huespedes`) y asignación de habitación al reservar
// (`PATCH .../reservas/:id/asignar-habitacion`) viven en reservas.ts, no aquí --
// son acciones de FRONT-OF-HOUSE cotidianas (gateadas por
// `MANAGE_RESERVATIONS_ROLES`, ya usado ahí para crear la reserva en sí), a
// diferencia de este archivo (gestión de CATÁLOGO -- tipos de habitación/
// habitaciones físicas/tarifas -- gateado por `ADMIN_ROLES`, owner/gm).
//
// Deliberadamente FUERA de este archivo (documentado, no un olvido): alta de
// ORGANIZACIÓN/PROPERTY nueva -- ver el comentario de cabecera de
// migrations/018_admin_catalogo_alta.sql para el porqué completo (decisión de
// plataforma, `core.organization`/`core.property` compartidas por las 6
// verticales, `service_role` no aprovisionado en este monorepo).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ADMIN_ROLES, type RoomSummary, type RoomTypeSummary } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Techo del rango de un solo submit de "crear tarifa" -- `upsertRatePlanRange`
// inserta UNA fila por fecha (ver postgres-repository.ts); sin techo, un rango mal
// tecleado (ej. año equivocado en `fechaFin`) podría intentar sembrar decenas de
// miles de filas en una sola request. 3 años (1096 días, cubre bisiestos) es
// generoso para cualquier temporada/tarifa anual real de un hotel.
const MAX_RATE_RANGE_DAYS = 1096;

interface CrearTipoHabitacionBody {
  readonly nombre?: unknown;
  readonly capacidadMaxima?: unknown;
}

interface CrearHabitacionBody {
  readonly codigo?: unknown;
}

interface CrearTarifaBody {
  readonly roomTypeId?: unknown;
  readonly fechaInicio?: unknown;
  readonly fechaFin?: unknown;
  readonly precio?: unknown;
  readonly moneda?: unknown;
  readonly estanciaMinima?: unknown;
  readonly cerradoLlegada?: unknown;
  readonly cerradoSalida?: unknown;
}

function serializeRoomType(rt: RoomTypeSummary) {
  return { id: rt.id, nombre: rt.name, capacidadMaxima: rt.maxOccupancy };
}

function serializeRoom(r: RoomSummary) {
  return { id: r.id, codigo: r.code, estado: r.status, roomTypeId: r.roomTypeId };
}

export function hotelesAdminCatalogoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const tiposHabitacionPath = "/hoteles/:propertyId/tipos-habitacion";
  const habitacionesDeUnTipoPath = "/hoteles/:propertyId/tipos-habitacion/:roomTypeId/habitaciones";
  const habitacionesPath = "/hoteles/:propertyId/habitaciones";
  const tarifasPath = "/hoteles/:propertyId/tarifas";

  app.use(tiposHabitacionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(habitacionesDeUnTipoPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(habitacionesPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(tarifasPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // `GET .../tipos-habitacion` (catálogo de solo lectura) ya vive en reservas.ts --
  // este POST es el único handler nuevo en esta ruta.
  app.post(tiposHabitacionPath, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CrearTipoHabitacionBody>(c.req.raw, 2 * 1024);

    if (typeof raw.nombre !== "string" || raw.nombre.trim().length === 0) throw Errors.validation("nombre requerido.");
    const nombre = raw.nombre.trim();
    let capacidadMaxima = 2;
    if (raw.capacidadMaxima !== undefined) {
      if (typeof raw.capacidadMaxima !== "number" || !Number.isInteger(raw.capacidadMaxima) || raw.capacidadMaxima <= 0) {
        throw Errors.validation("capacidadMaxima debe ser un entero positivo.");
      }
      capacidadMaxima = raw.capacidadMaxima;
    }

    const repo = deps.hotelesRepo(c.get("db"));
    try {
      const roomType = await repo.insertRoomType({ propertyId, organizationId, name: nombre, maxOccupancy: capacidadMaxima });
      return c.json(serializeRoomType(roomType), 201);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("nombre_duplicado")) throw Errors.conflict(err.message);
      throw err;
    }
  });

  // Habitaciones físicas de un tipo de habitación concreto -- insumo directo del
  // selector de "asignar habitación" en reservas.ts.
  app.get(habitacionesPath, async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const roomTypeId = c.req.query("roomTypeId") || null;
    const rooms = await repo.listRooms(propertyId, roomTypeId);
    return c.json(rooms.map(serializeRoom));
  });

  app.post(habitacionesDeUnTipoPath, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const roomTypeId = c.req.param("roomTypeId");
    const raw = await readJsonCapped<CrearHabitacionBody>(c.req.raw, 1024);

    if (typeof raw.codigo !== "string" || raw.codigo.trim().length === 0) throw Errors.validation("codigo requerido (ej. número de cuarto).");
    const codigo = raw.codigo.trim();

    const repo = deps.hotelesRepo(c.get("db"));
    const roomType = await repo.findRoomType(propertyId, roomTypeId);
    if (!roomType) throw Errors.notFound("Tipo de habitación no encontrado en esta property.");

    try {
      const room = await repo.insertRoom({ propertyId, organizationId, roomTypeId, code: codigo });
      return c.json(serializeRoom(room), 201);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("codigo_duplicado")) throw Errors.conflict(err.message);
      throw err;
    }
  });

  // La pieza que de verdad bloqueaba `POST .../reservas` con `sin_tarifa` --
  // siembra/corrige tarifa real para un RANGO de fechas de un tipo de habitación en
  // un solo submit (ver `upsertRatePlanRange`, `ON CONFLICT ... DO UPDATE`: un
  // rango que traslapa fechas ya sembradas las sobreescribe, nunca falla).
  app.post(tarifasPath, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CrearTarifaBody>(c.req.raw, 2 * 1024);

    if (typeof raw.roomTypeId !== "string" || raw.roomTypeId.length === 0) throw Errors.validation("roomTypeId requerido.");
    if (typeof raw.fechaInicio !== "string" || !DATE_RE.test(raw.fechaInicio)) throw Errors.validation("fechaInicio: formato esperado YYYY-MM-DD.");
    if (typeof raw.fechaFin !== "string" || !DATE_RE.test(raw.fechaFin)) throw Errors.validation("fechaFin: formato esperado YYYY-MM-DD.");
    if (raw.fechaFin < raw.fechaInicio) throw Errors.validation("fechaFin debe ser igual o posterior a fechaInicio.");
    const dayCount = Math.round((new Date(`${raw.fechaFin}T00:00:00Z`).getTime() - new Date(`${raw.fechaInicio}T00:00:00Z`).getTime()) / 86_400_000) + 1;
    if (dayCount > MAX_RATE_RANGE_DAYS) throw Errors.validation(`El rango no puede superar ${MAX_RATE_RANGE_DAYS} días en un solo submit.`);
    if (typeof raw.precio !== "number" || !Number.isFinite(raw.precio) || raw.precio < 0) throw Errors.validation("precio debe ser un número >= 0.");

    const moneda = typeof raw.moneda === "string" && raw.moneda.trim().length > 0 ? raw.moneda.trim().toUpperCase() : "MXN";
    let estanciaMinima = 1;
    if (raw.estanciaMinima !== undefined) {
      if (typeof raw.estanciaMinima !== "number" || !Number.isInteger(raw.estanciaMinima) || raw.estanciaMinima <= 0) {
        throw Errors.validation("estanciaMinima debe ser un entero positivo.");
      }
      estanciaMinima = raw.estanciaMinima;
    }
    const cerradoLlegada = raw.cerradoLlegada === true;
    const cerradoSalida = raw.cerradoSalida === true;

    const repo = deps.hotelesRepo(c.get("db"));
    const roomType = await repo.findRoomType(propertyId, raw.roomTypeId);
    if (!roomType) throw Errors.notFound("Tipo de habitación no encontrado en esta property.");

    const { datesWritten } = await repo.upsertRatePlanRange({
      propertyId,
      organizationId,
      roomTypeId: raw.roomTypeId,
      startDate: raw.fechaInicio,
      endDate: raw.fechaFin,
      price: raw.precio,
      currency: moneda,
      minStay: estanciaMinima,
      closedToArrival: cerradoLlegada,
      closedToDeparture: cerradoSalida,
    });

    return c.json({ roomTypeId: raw.roomTypeId, fechaInicio: raw.fechaInicio, fechaFin: raw.fechaFin, precio: raw.precio, moneda, nochesSembradas: datesWritten }, 201);
  });

  return app;
}
