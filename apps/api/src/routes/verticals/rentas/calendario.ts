// Fase 13 -- calendario visual del panel de staff: cierra el hallazgo de auditoría
// "Calendario de reservas y bloqueos: backend completo sin UI" -- reservas.ts (Fase 1)
// y bloqueos.ts (Fase 4) ya exponían crear/modificar/cancelar reservas y crear/listar/
// liberar bloqueos, pero NO existía ningún GET que devolviera, para una unidad, TODAS
// sus ocupaciones (reserva de canal Y bloqueo) en una sola vista -- el listado mínimo
// indispensable para poder pintar un calendario real. Esta ruta agrega exactamente
// ese listado que faltaba (`listOcupaciones`, Fase 13 de @atiende/domain-rentas) más
// el descubrimiento de unidades de una property (`listUnidades`) que el selector de
// unidad del calendario necesita y que hasta ahora tampoco existía por HTTP.
//
// Mismo patrón arquitectónico que reservas.ts/bloqueos.ts: sesión de staff obligatoria
// (authMiddleware + dbSession + requirePropertyMembership), filtrado fino de rol con
// assertVerticalRole dentro de cada handler -- pero con `CALENDARIO_LECTURA_ROLES`
// (Fase 13) en vez de `ESCRITURA_CALENDARIO_ROLES`: estas dos rutas son de SOLO
// LECTURA, así que también se abren a `operador:solo_calendario` (el rol de "puede
// ver el calendario, no puede tocarlo" que ya existía en RENTAS_VERTICAL_ROLES desde
// la Fase 1 sin que ninguna ruta de calendario lo aceptara todavía -- ver el
// comentario de cabecera de esa constante en roles.ts). Deliberadamente NO se toca el
// rol de `GET .../bloqueos` (bloqueos.ts): esa ruta ya existía antes de esta fase con
// `ESCRITURA_CALENDARIO_ROLES` y ampliarla es un cambio de comportamiento fuera del
// alcance de este hallazgo.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { calcularNoches, CALENDARIO_LECTURA_ROLES, esFechaCalendario, esRangoValido } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

// Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad BAJA:
// "listados sin paginación en 4 verticales") -- GET .../ocupaciones devolvía TODO el
// historial de ocupaciones de la unidad (reservas Y bloqueos, activas Y canceladas)
// en un solo array. Una unidad con años de operación acumula cientos de filas.
const DEFAULT_OCUPACIONES_LIMIT = 100;
const MAX_OCUPACIONES_LIMIT = 300;

// Rn-06 -- calendario visual: lectura por VENTANA (el mes en pantalla), nunca el historial.
// Una vista de mes con semanas de relleno cubre como máximo 42 días; se permite un margen para la línea de tiempo.
const MAX_VENTANA_DIAS = 100;
const DEFAULT_VENTANA_LIMIT = 500;
const MAX_VENTANA_LIMIT = 1000;

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function rentasCalendarioRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const unidadesPath = "/rentas/:propertyId/unidades";
  const ocupacionesPath = "/rentas/:propertyId/unidades/:unidadId/ocupaciones";
  app.use(unidadesPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(ocupacionesPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  const ventanaPath = "/rentas/:propertyId/calendario";
  app.use(ventanaPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(unidadesPath, async (c) => {
    assertVerticalRole(c, CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasRepo(c.get("db"));

    const unidades = await repo.listUnidades(propertyId);
    return c.json({ unidades: unidades.map((u) => ({ id: u.id, nombre: u.name ?? u.id, duracionMinimaNoches: u.duracionMinimaNoches })) }, 200);
  });

  app.get(ocupacionesPath, async (c) => {
    assertVerticalRole(c, CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const repo = deps.rentasRepo(c.get("db"));

    // Defensa en profundidad, mismo criterio que reservas.ts/bloqueos.ts: nunca
    // confiar en que el cliente "sabe" que `unidadId` pertenece a `propertyId`.
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_OCUPACIONES_LIMIT, MAX_OCUPACIONES_LIMIT);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // Body sigue siendo `{ ocupaciones: [...] }` (compatibilidad con el cliente ya
    // existente) -- lo que cambia de verdad es que la QUERY ahora está acotada por
    // `limit`/`offset` reales (`listOcupacionesPage`, ver
    // @atiende/domain-rentas::repository.ts) en vez de traer TODO el historial; el
    // total real y el siguiente offset van en headers para quien sí quiera paginar.
    const page = await repo.listOcupacionesPage(propertyId, unidadId, { limit, offset });
    c.header("X-Total-Count", String(page.total));
    if (page.nextOffset !== null) c.header("X-Next-Offset", String(page.nextOffset));
    return c.json({ ocupaciones: page.items }, 200);
  });

  // Rn-06 -- `GET .../calendario?desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&unidadId=][&limit=]`: ocupaciones ACTIVAS (reservas
  // y bloqueos) de TODA la property que tocan la ventana `[desde, hasta)`, para pintar el mes/la línea de tiempo con una
  // sola lectura. Solo lectura, mismos roles que `GET .../ocupaciones`. Devuelve también la zona horaria de la property y
  // "hoy" en esa zona (Cancún, UTC-5 sin horario de verano, y CDMX, UTC-6, no comparten día durante una hora cada noche:
  // el día lo decide el servidor con la zona de la property, nunca el reloj del navegador). No expone el contacto del huésped (minimización de datos).
  app.get(ventanaPath, async (c) => {
    assertVerticalRole(c, CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const desde = c.req.query("desde") ?? "";
    const hasta = c.req.query("hasta") ?? "";
    if (!esFechaCalendario(desde) || !esFechaCalendario(hasta)) throw Errors.validation("desde y hasta: se esperaban fechas reales YYYY-MM-DD.");
    if (!esRangoValido({ inicio: desde, fin: hasta })) throw Errors.validation("hasta debe ser posterior a desde.");
    if (calcularNoches({ inicio: desde, fin: hasta }) > MAX_VENTANA_DIAS) throw Errors.validation(`La ventana admite como máximo ${MAX_VENTANA_DIAS} días.`);
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_VENTANA_LIMIT, MAX_VENTANA_LIMIT);

    const repo = deps.rentasRepo(c.get("db"));
    const unidadId = c.req.query("unidadId") || undefined;
    if (unidadId !== undefined && !(await repo.findUnidad(propertyId, unidadId))) throw Errors.notFound("Unidad no encontrada en esta property.");

    const zona = resolverZonaHorariaNegocio(await deps.rentasCalendarSyncRepo(c.get("db")).findZonaHorariaPropiedad(propertyId));
    const ventana = await repo.listOcupacionesVentana(propertyId, { desde, hasta, limit, ...(unidadId !== undefined ? { unidadId } : {}) });
    return c.json(
      {
        zona_horaria: zona,
        hoy: hoyFechaNegocio(zona),
        desde,
        hasta,
        total: ventana.total,
        truncado: ventana.total > ventana.items.length,
        ocupaciones: ventana.items.map((o) => ({
          id: o.id,
          unidadId: o.unidadId,
          capa: o.capa,
          rango: o.rango,
          razon: o.razon,
          estado: o.estado,
          canalCodigo: o.canalCodigo,
          huespedNombre: o.huespedNombre,
        })),
      },
      200,
    );
  });

  return app;
}
