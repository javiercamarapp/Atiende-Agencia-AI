// Rn-23 · además de los 5 POST: GET .../configuracion-precios (lee todo lo guardado) y
// PATCH/DELETE por id de temporada, descuento por duración, min-stay y regla de canal.
// La tarifa base se versiona por `vigente_desde` (se edita con el mismo POST, nunca se borra).
// DELETE de temporada/descuento/min-stay requiere la migración 030: contra la base sin migrar
// Postgres responde 42501 y la ruta contesta 503 honesto ("no disponible aún"), nunca 500.
//
// Flujo 4 (Fase 2) · CRUD de configuración de pricing —
// POST /rentas/:propertyId/unidades/:unidadId/{tarifa-base,temporadas,
// descuentos-duracion,min-stay,reglas-canal}. Ver diseño Fase 2 rentas §3: el motor de
// cálculo sigue siendo `pricing/cotizacion.ts` (Fase 1, sin cambios) — estas rutas
// SOLO validan y persisten la configuración que ese motor consume. `002_pricing_schema.sql`
// dejó estas 5 tablas en solo-lectura ("el endpoint de escritura es Fase 2"):
// `004_pricing_escritura_rls.sql` habilita la escritura en la base de datos real; aquí
// se habilita en la API.
//
// Dos guardias cierran brechas REALES del repo origen (nunca las tenía, ver diseño
// §3.1/§3.2/§3.4):
//  1. Nunca mezclar monedas dentro de una misma unidad (tarifa-base).
//  2. Nunca dos temporadas/reglas min-stay traslapadas -- `cotizacion.ts` resuelve el
//     precio de una noche con el PRIMER match del arreglo, así que un traslape produce
//     un precio no determinista para el huésped (depende del orden de la query SQL).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import { runWithSavepointFallback } from "@atiende/db";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { encontrarMinStaySolapada, encontrarTemporadaSolapada, esRangoValido, PRICING_ESCRITURA_ROLES } from "@atiende/domain-rentas";
import type { RangoFechas, RentasCalendarSyncRepository, RentasRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEDA_RE = /^[A-Z]{3}$/;

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw Errors.validation(`${field}: se esperaba un entero >= 0.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const n = requireNonNegativeInteger(value, field);
  if (n < 1) throw Errors.validation(`${field}: se esperaba un entero >= 1.`);
  return n;
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

function requireMoneda(value: unknown): string {
  const moneda = requireString(value, "moneda", 3);
  if (!MONEDA_RE.test(moneda)) throw Errors.validation("moneda: se esperaba un código ISO 4217 de 3 letras mayúsculas.");
  return moneda;
}

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  return value;
}

function requireRango(raw: unknown): RangoFechas {
  if (!raw || typeof raw !== "object") throw Errors.validation("rango: se esperaba un objeto {inicio, fin}.");
  const r = raw as { inicio?: unknown; fin?: unknown };
  const rango = { inicio: requireFecha(r.inicio, "rango.inicio"), fin: requireFecha(r.fin, "rango.fin") };
  if (!esRangoValido(rango)) throw Errors.validation("rango.fin debe ser posterior a rango.inicio.");
  return rango;
}

function requireDiaSemanaOptional(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 6) {
    throw Errors.validation("diaSemanaCheckIn: se esperaba null o un entero 0-6 (0=domingo).");
  }
  return value;
}

// Bug real (revisión r6, misma causa raíz que `../despachos/vencimientos.ts::todayIso` --
// ver su comentario de cabecera): el default de `vigenteDesde` (cuando el caller no lo
// manda) usaba el día UTC del proceso -- corrido un día adelante del real en CDMX entre
// las 18:00 y las 23:59 hora local. Ahora usa `@atiende/core-tenancy::hoyFechaNegocio()`.
//
// auditoría f3-zona-horaria-citas-rentas -- CONFIRMADO y CONECTADO: `rentas.
// property_config.zona_horaria` SÍ existe (NOT NULL, migración 001) y esta ruta SÍ
// conoce `propertyId` en este punto (parámetro de la ruta, ya usado por
// `requireUnidad`) -- el gap real que dejó pendiente r6 no era que la columna no
// existiera, sino que `RentasRepository` (el repo principal de esta ruta) no la
// expone. Se resuelve reutilizando `RentasCalendarSyncRepository.
// findZonaHorariaPropiedad` (ya existe, ya tiene SELECT otorgado a `authenticated`
// desde 001_rentas_schema.sql -- SOLO LECTURA, ningún GRANT/policy nuevo) en vez de
// agregar un método nuevo a `RentasRepository` para lo mismo. `resolverZonaHorariaNegocio`
// es la defensa en profundidad real aquí: `findZonaHorariaPropiedad` cae a `"UTC"`
// (nunca `null`) cuando la property no tiene fila en `property_config` todavía (ver
// su propio comentario: "nunca debería alcanzarse en producción, solo protege un
// fixture de prueba sin sembrar") -- un valor `"UTC"` real pasa intacto por
// `resolverZonaHorariaNegocio` (es un timezone IANA válido), así que el default de
// plataforma (`America/Mexico_City`) solo se usa si el valor guardado fuera
// inválido/corrupto, no como sustituto de "UTC".
async function hoyIso(syncRepo: RentasCalendarSyncRepository, propertyId: string): Promise<string> {
  const zonaHoraria = resolverZonaHorariaNegocio(await syncRepo.findZonaHorariaPropiedad(propertyId));
  return hoyFechaNegocio(zonaHoraria);
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Ejecuta una escritura de edición/borrado dentro de un SAVEPOINT (la sesión es UNA transacción
 *  por request: un error de Postgres sin SAVEPOINT la deja abortada). 42501 = la base real aún
 *  no tiene las políticas/GRANT de la migración 030 -> 503 honesto; 23505 = duplicado -> 409. */
async function escrituraPricing<T>(db: TenantDbSession, primary: () => Promise<T>): Promise<T> {
  return runWithSavepointFallback<T>({
    session: db,
    primary,
    isRecoverable: (err) => pgCode(err) === "42501" || pgCode(err) === "23505",
    fallback: async (err) => {
      if (pgCode(err) === "23505") throw Errors.conflict("Ya existe una configuración con esos datos para esta unidad.");
      throw Errors.serviceUnavailable("No disponible aún: la base de datos todavía no tiene la migración de edición de precios (030).");
    },
  });
}

function requireAlgunCampo(raw: Record<string, unknown>, campos: readonly string[]): void {
  if (!campos.some((c) => raw[c] !== undefined)) throw Errors.validation(`Se esperaba al menos uno de: ${campos.join(", ")}.`);
}

interface TarifaBaseBody {
  readonly precioNocheCentavos?: unknown;
  readonly moneda?: unknown;
  readonly vigenteDesde?: unknown;
}

interface TemporadaBody {
  readonly nombre?: unknown;
  readonly rango?: unknown;
  readonly precioNocheCentavos?: unknown;
  readonly moneda?: unknown;
}

interface DescuentoDuracionBody {
  readonly nochesMinimas?: unknown;
  readonly porcentajeDescuentoBasisPoints?: unknown;
  readonly fuente?: unknown;
}

interface MinStayBody {
  readonly rango?: unknown;
  readonly diaSemanaCheckIn?: unknown;
  readonly nochesMinimas?: unknown;
}

interface ReglaCanalBody {
  readonly canalCodigo?: unknown;
  readonly markupBasisPoints?: unknown;
  readonly activo?: unknown;
}

export function rentasPricingConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/unidades/:unidadId";
  const paths = [
    `${base}/tarifa-base`,
    `${base}/temporadas`,
    `${base}/descuentos-duracion`,
    `${base}/min-stay`,
    `${base}/reglas-canal`,
    `${base}/configuracion-precios`,
    `${base}/temporadas/:id`,
    `${base}/descuentos-duracion/:id`,
    `${base}/min-stay/:id`,
    `${base}/reglas-canal/:id`,
  ];
  for (const path of paths) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  async function requireUnidad(repo: RentasRepository, propertyId: string, unidadId: string) {
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");
    return unidad;
  }

  // ---- 3.1: POST .../tarifa-base ----
  app.post(`${base}/tarifa-base`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<TarifaBaseBody>(c.req.raw, 2 * 1024);
    const precioNocheCentavos = requireNonNegativeInteger(raw.precioNocheCentavos, "precioNocheCentavos");
    const moneda = requireMoneda(raw.moneda);
    const vigenteDesde =
      raw.vigenteDesde === undefined ? await hoyIso(deps.rentasCalendarSyncRepo(c.get("db")), propertyId) : requireFecha(raw.vigenteDesde, "vigenteDesde");

    // Guardia nueva (ver diseño §3.1): nunca mezclar monedas dentro de la misma
    // unidad -- el motor de cotización nunca convierte tipo de cambio.
    const monedaExistente = await repo.findMonedaExistentePricing(unidadId, vigenteDesde);
    if (monedaExistente && monedaExistente !== moneda) throw Errors.rentasPricingMonedaInconsistente(monedaExistente);

    const { id } = await repo.upsertTarifaBase({ organizationId: unidad.organizationId, propertyId, unidadId, precioNocheCentavos, moneda, vigenteDesde, createdBy: userId });
    // r5 -- bitácora de auditoría (cambio de precio/tarifa). Nunca rompe esta
    // request si falla -- ver comentario de cabecera de
    // PostgresRentasRepository.registrarAuditoria.
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.tarifa_base.actualizada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "precio_noche_centavos",
      antes: monedaExistente ? `moneda previa: ${monedaExistente}` : null,
      despues: `${precioNocheCentavos} ${moneda} desde ${vigenteDesde}`,
    });
    return c.json({ id, unidadId, precioNocheCentavos, moneda, vigenteDesde }, 201);
  });

  // ---- 3.2: POST .../temporadas ----
  app.post(`${base}/temporadas`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<TemporadaBody>(c.req.raw, 2 * 1024);
    const nombre = requireString(raw.nombre, "nombre", 200);
    const rango = requireRango(raw.rango);
    const precioNocheCentavos = requireNonNegativeInteger(raw.precioNocheCentavos, "precioNocheCentavos");
    const moneda = requireMoneda(raw.moneda);

    // Guardia nueva (ver diseño §3.1): misma guardia anti-mezcla-de-monedas que
    // tarifa-base -- una temporada en una moneda distinta a la tarifa-base/otras
    // temporadas de la misma unidad dejaría un dato inconsistente en la base aunque
    // el motor de cotización no la use hoy (nunca convierte tipo de cambio).
    const monedaExistente = await repo.findMonedaExistentePricing(unidadId);
    if (monedaExistente && monedaExistente !== moneda) throw Errors.rentasPricingMonedaInconsistente(monedaExistente);

    // Guardia nueva (ver diseño §3.2): dos temporadas de la misma unidad NUNCA pueden
    // traslaparse -- el origen no lo comprueba, y `cotizacion.ts` resuelve el precio
    // de una noche con el PRIMER match del arreglo (precio no determinista si hay
    // traslape).
    const existentes = await repo.listTemporadas(unidadId);
    const conflicto = encontrarTemporadaSolapada(existentes, rango);
    if (conflicto) throw Errors.rentasPricingSolapado(conflicto.nombre, conflicto.rango);

    const { id } = await repo.insertTemporada({ organizationId: unidad.organizationId, propertyId, unidadId, nombre, rango, precioNocheCentavos, moneda, createdBy: userId });
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.temporada.creada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "temporada",
      antes: null,
      despues: `"${nombre}": ${precioNocheCentavos} ${moneda} (${rango.inicio} a ${rango.fin})`,
    });
    return c.json({ id, unidadId, nombre, rango, precioNocheCentavos, moneda }, 201);
  });

  // ---- 3.3: POST .../descuentos-duracion ----
  app.post(`${base}/descuentos-duracion`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<DescuentoDuracionBody>(c.req.raw, 2 * 1024);
    const nochesMinimas = requirePositiveInteger(raw.nochesMinimas, "nochesMinimas");
    const porcentajeDescuentoBasisPoints = requireBasisPoints(raw.porcentajeDescuentoBasisPoints, "porcentajeDescuentoBasisPoints");
    // `fuente` obligatorio, nunca un porcentaje mudo -- mismo principio que
    // `ConfiguracionComisionCanal.fuente` (Fase 1, finanzas).
    const fuente = requireString(raw.fuente, "fuente", 300);

    const { id } = await repo.upsertDescuentoDuracion({ organizationId: unidad.organizationId, propertyId, unidadId, nochesMinimas, porcentajeDescuentoBasisPoints, fuente });
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.descuento_duracion.actualizado",
      entityType: "pricing",
      entityId: unidadId,
      campo: "porcentaje_descuento_basis_points",
      antes: null,
      despues: `${nochesMinimas}+ noches: ${porcentajeDescuentoBasisPoints}bp (${fuente})`,
    });
    return c.json({ id, unidadId, nochesMinimas, porcentajeDescuentoBasisPoints, fuente }, 201);
  });

  // ---- 3.4: POST .../min-stay ----
  app.post(`${base}/min-stay`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<MinStayBody>(c.req.raw, 2 * 1024);
    const rango = requireRango(raw.rango);
    const diaSemanaCheckIn = requireDiaSemanaOptional(raw.diaSemanaCheckIn);
    const nochesMinimas = requirePositiveInteger(raw.nochesMinimas, "nochesMinimas");

    // Guardia nueva (ver diseño §3.4): solo es conflicto cuando, además de traslaparse
    // en rango, ambas reglas comparten el MISMO `diaSemanaCheckIn` (una regla "todos
    // los días" y otra "solo sábado" en el mismo rango NO son conflicto real --
    // `evaluarViolacionesMinStay` ya las evalúa de forma independiente).
    const existentes = await repo.listReglasMinStay(unidadId);
    const conflicto = encontrarMinStaySolapada(existentes, { rango, diaSemanaCheckIn });
    if (conflicto) throw Errors.rentasPricingSolapado(`regla min-stay existente (día ${conflicto.diaSemanaCheckIn ?? "todos"})`, conflicto.rango);

    const { id } = await repo.insertReglaMinStay({ organizationId: unidad.organizationId, propertyId, unidadId, rango, diaSemanaCheckIn, nochesMinimas });
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.min_stay.creada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "noches_minimas",
      antes: null,
      despues: `${nochesMinimas} noches (${rango.inicio} a ${rango.fin}, día ${diaSemanaCheckIn ?? "todos"})`,
    });
    return c.json({ id, unidadId, rango, diaSemanaCheckIn, nochesMinimas }, 201);
  });

  // ---- 3.5: POST .../reglas-canal ----
  app.post(`${base}/reglas-canal`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const userId = c.get("userId");
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<ReglaCanalBody>(c.req.raw, 2 * 1024);
    const canalCodigo = requireString(raw.canalCodigo, "canalCodigo", 60);
    const markupBasisPoints = requireBasisPoints(raw.markupBasisPoints, "markupBasisPoints");
    if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba un booleano.");
    // `activo` default `false` -- NUNCA implícitamente `true` (mismo criterio que
    // `003_finanzas_schema.sql` para `regla_comision_canal`). Sin validación de
    // paridad de precios: ningún canal real declara `ratesPush: true` todavía (ver
    // diseño §3.5) -- portarla ahora simularía una capacidad que no existe.
    const activo = raw.activo === true;

    const canal = await repo.findCanalPorCodigo(canalCodigo);
    if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no existe en el catálogo.`);

    const { id } = await repo.upsertReglaCanalPricing({ organizationId: unidad.organizationId, propertyId, unidadId, canalId: canal.id, markupBasisPoints, activo });
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.regla_canal.actualizada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "markup_basis_points",
      antes: null,
      despues: `canal ${canalCodigo}: ${markupBasisPoints}bp (activo: ${activo})`,
    });
    return c.json({ id, unidadId, canalCodigo, markupBasisPoints, activo }, 201);
  });

  // ---- Rn-23: GET .../configuracion-precios ----
  // Lectura para CUALQUIER staff con acceso a la property (igual que el cotizador): RLS de
  // select ya es `has_property_access`. Solo lee tablas de 002_pricing_schema.sql.
  app.get(`${base}/configuracion-precios`, async (c) => {
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const repo = deps.rentasRepo(c.get("db"));
    await requireUnidad(repo, propertyId, unidadId);
    const hoy = await hoyIso(deps.rentasCalendarSyncRepo(c.get("db")), propertyId);
    const config = await repo.loadConfiguracionPricing(unidadId, hoy);
    return c.json({ unidadId, ...config });
  });

  // Monedas ya en uso por la unidad, SIN contar la fila `excluirId` (la que se está editando).
  async function monedaDeOtrasFilas(repo: RentasRepository, unidadId: string, hoy: string, excluirTemporadaId?: string): Promise<string | null> {
    const config = await repo.loadConfiguracionPricing(unidadId, hoy);
    const base = config.historialTarifaBase[0];
    if (base) return base.moneda;
    return config.temporadas.find((t) => t.id !== excluirTemporadaId)?.moneda ?? null;
  }

  // ---- PATCH / DELETE .../temporadas/:id ----
  app.patch(`${base}/temporadas/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const hoy = await hoyIso(deps.rentasCalendarSyncRepo(db), propertyId);

    const raw = await readJsonCapped<TemporadaBody>(c.req.raw, 2 * 1024);
    requireAlgunCampo(raw as Record<string, unknown>, ["nombre", "rango", "precioNocheCentavos", "moneda"]);
    const existentes = (await repo.loadConfiguracionPricing(unidadId, hoy)).temporadas;
    const actual = existentes.find((t) => t.id === id);
    if (!actual) throw Errors.notFound("Temporada no encontrada en esta unidad.");

    const nombre = raw.nombre === undefined ? actual.nombre : requireString(raw.nombre, "nombre", 200);
    const rango = raw.rango === undefined ? actual.rango : requireRango(raw.rango);
    const precioNocheCentavos = raw.precioNocheCentavos === undefined ? actual.precioNocheCentavos : requireNonNegativeInteger(raw.precioNocheCentavos, "precioNocheCentavos");
    const moneda = raw.moneda === undefined ? actual.moneda : requireMoneda(raw.moneda);

    const monedaExistente = await monedaDeOtrasFilas(repo, unidadId, hoy, id);
    if (monedaExistente && monedaExistente !== moneda) throw Errors.rentasPricingMonedaInconsistente(monedaExistente);
    const conflicto = encontrarTemporadaSolapada(existentes, rango, id);
    if (conflicto) throw Errors.rentasPricingSolapado(conflicto.nombre, conflicto.rango);

    const ok = await escrituraPricing(db, () => repo.updateTemporada({ unidadId, id, nombre, rango, precioNocheCentavos, moneda }));
    if (!ok) throw Errors.notFound("Temporada no encontrada en esta unidad.");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.temporada.actualizada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "temporada",
      antes: `"${actual.nombre}": ${actual.precioNocheCentavos} ${actual.moneda} (${actual.rango.inicio} a ${actual.rango.fin})`,
      despues: `"${nombre}": ${precioNocheCentavos} ${moneda} (${rango.inicio} a ${rango.fin})`,
    });
    return c.json({ id, unidadId, nombre, rango, precioNocheCentavos, moneda });
  });

  app.delete(`${base}/temporadas/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const hoy = await hoyIso(deps.rentasCalendarSyncRepo(db), propertyId);
    const actual = (await repo.loadConfiguracionPricing(unidadId, hoy)).temporadas.find((t) => t.id === id);
    if (!actual) throw Errors.notFound("Temporada no encontrada en esta unidad.");
    const ok = await escrituraPricing(db, () => repo.deleteTemporada(unidadId, id));
    // 0 filas con la fila visible = RLS la protege (falta la política de borrado): mismo 503 honesto.
    if (!ok) throw Errors.serviceUnavailable("No disponible aún: la base de datos todavía no permite borrar temporadas (migración 030 pendiente).");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.temporada.eliminada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "temporada",
      antes: `"${actual.nombre}": ${actual.precioNocheCentavos} ${actual.moneda} (${actual.rango.inicio} a ${actual.rango.fin})`,
      despues: null,
    });
    return c.json({ id, unidadId, eliminada: true });
  });

  // ---- PATCH / DELETE .../descuentos-duracion/:id ----
  app.patch(`${base}/descuentos-duracion/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<DescuentoDuracionBody>(c.req.raw, 2 * 1024);
    requireAlgunCampo(raw as Record<string, unknown>, ["nochesMinimas", "porcentajeDescuentoBasisPoints", "fuente"]);
    const existentes = await repo.listDescuentosDuracion(unidadId);
    const actual = existentes.find((d) => d.id === id);
    if (!actual) throw Errors.notFound("Descuento no encontrado en esta unidad.");

    const nochesMinimas = raw.nochesMinimas === undefined ? actual.nochesMinimas : requirePositiveInteger(raw.nochesMinimas, "nochesMinimas");
    const porcentajeDescuentoBasisPoints =
      raw.porcentajeDescuentoBasisPoints === undefined ? actual.porcentajeDescuentoBasisPoints : requireBasisPoints(raw.porcentajeDescuentoBasisPoints, "porcentajeDescuentoBasisPoints");
    const fuente = raw.fuente === undefined ? actual.fuente : requireString(raw.fuente, "fuente", 300);
    if (existentes.some((d) => d.id !== id && d.nochesMinimas === nochesMinimas)) {
      throw Errors.conflict(`Ya existe un descuento para ${nochesMinimas}+ noches en esta unidad.`);
    }

    const ok = await escrituraPricing(db, () => repo.updateDescuentoDuracion({ unidadId, id, nochesMinimas, porcentajeDescuentoBasisPoints, fuente }));
    if (!ok) throw Errors.notFound("Descuento no encontrado en esta unidad.");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.descuento_duracion.editado",
      entityType: "pricing",
      entityId: unidadId,
      campo: "porcentaje_descuento_basis_points",
      antes: `${actual.nochesMinimas}+ noches: ${actual.porcentajeDescuentoBasisPoints}bp (${actual.fuente})`,
      despues: `${nochesMinimas}+ noches: ${porcentajeDescuentoBasisPoints}bp (${fuente})`,
    });
    return c.json({ id, unidadId, nochesMinimas, porcentajeDescuentoBasisPoints, fuente });
  });

  app.delete(`${base}/descuentos-duracion/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const actual = (await repo.listDescuentosDuracion(unidadId)).find((d) => d.id === id);
    if (!actual) throw Errors.notFound("Descuento no encontrado en esta unidad.");
    const ok = await escrituraPricing(db, () => repo.deleteDescuentoDuracion(unidadId, id));
    if (!ok) throw Errors.serviceUnavailable("No disponible aún: la base de datos todavía no permite borrar descuentos (migración 030 pendiente).");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.descuento_duracion.eliminado",
      entityType: "pricing",
      entityId: unidadId,
      campo: "porcentaje_descuento_basis_points",
      antes: `${actual.nochesMinimas}+ noches: ${actual.porcentajeDescuentoBasisPoints}bp (${actual.fuente})`,
      despues: null,
    });
    return c.json({ id, unidadId, eliminado: true });
  });

  // ---- PATCH / DELETE .../min-stay/:id ----
  app.patch(`${base}/min-stay/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);

    const raw = await readJsonCapped<MinStayBody>(c.req.raw, 2 * 1024);
    requireAlgunCampo(raw as Record<string, unknown>, ["rango", "diaSemanaCheckIn", "nochesMinimas"]);
    const existentes = await repo.listReglasMinStay(unidadId);
    const actual = existentes.find((r) => r.id === id);
    if (!actual) throw Errors.notFound("Regla de estancia mínima no encontrada en esta unidad.");

    const rango = raw.rango === undefined ? actual.rango : requireRango(raw.rango);
    const diaSemanaCheckIn = raw.diaSemanaCheckIn === undefined ? actual.diaSemanaCheckIn : requireDiaSemanaOptional(raw.diaSemanaCheckIn);
    const nochesMinimas = raw.nochesMinimas === undefined ? actual.nochesMinimas : requirePositiveInteger(raw.nochesMinimas, "nochesMinimas");
    const conflicto = encontrarMinStaySolapada(existentes, { rango, diaSemanaCheckIn }, id);
    if (conflicto) throw Errors.rentasPricingSolapado(`regla min-stay existente (día ${conflicto.diaSemanaCheckIn ?? "todos"})`, conflicto.rango);

    const ok = await escrituraPricing(db, () => repo.updateReglaMinStay({ unidadId, id, rango, diaSemanaCheckIn, nochesMinimas }));
    if (!ok) throw Errors.notFound("Regla de estancia mínima no encontrada en esta unidad.");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.min_stay.editada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "noches_minimas",
      antes: `${actual.nochesMinimas} noches (${actual.rango.inicio} a ${actual.rango.fin}, día ${actual.diaSemanaCheckIn ?? "todos"})`,
      despues: `${nochesMinimas} noches (${rango.inicio} a ${rango.fin}, día ${diaSemanaCheckIn ?? "todos"})`,
    });
    return c.json({ id, unidadId, rango, diaSemanaCheckIn, nochesMinimas });
  });

  app.delete(`${base}/min-stay/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const actual = (await repo.listReglasMinStay(unidadId)).find((r) => r.id === id);
    if (!actual) throw Errors.notFound("Regla de estancia mínima no encontrada en esta unidad.");
    const ok = await escrituraPricing(db, () => repo.deleteReglaMinStay(unidadId, id));
    if (!ok) throw Errors.serviceUnavailable("No disponible aún: la base de datos todavía no permite borrar reglas de estancia mínima (migración 030 pendiente).");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.min_stay.eliminada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "noches_minimas",
      antes: `${actual.nochesMinimas} noches (${actual.rango.inicio} a ${actual.rango.fin}, día ${actual.diaSemanaCheckIn ?? "todos"})`,
      despues: null,
    });
    return c.json({ id, unidadId, eliminada: true });
  });

  // ---- PATCH / DELETE .../reglas-canal/:id ----
  app.patch(`${base}/reglas-canal/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const hoy = await hoyIso(deps.rentasCalendarSyncRepo(db), propertyId);

    const raw = await readJsonCapped<ReglaCanalBody>(c.req.raw, 2 * 1024);
    requireAlgunCampo(raw as Record<string, unknown>, ["markupBasisPoints", "activo"]);
    const actual = (await repo.loadConfiguracionPricing(unidadId, hoy)).reglasCanal.find((r) => r.id === id);
    if (!actual) throw Errors.notFound("Regla de canal no encontrada en esta unidad.");

    const markupBasisPoints = raw.markupBasisPoints === undefined ? actual.markupBasisPoints : requireBasisPoints(raw.markupBasisPoints, "markupBasisPoints");
    if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba un booleano.");
    const activo = raw.activo === undefined ? actual.activo : raw.activo;

    const ok = await escrituraPricing(db, () => repo.updateReglaCanalPricing({ unidadId, id, markupBasisPoints, activo }));
    if (!ok) throw Errors.notFound("Regla de canal no encontrada en esta unidad.");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.regla_canal.editada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "markup_basis_points",
      antes: `canal ${actual.canalCodigo}: ${actual.markupBasisPoints}bp (activo: ${actual.activo})`,
      despues: `canal ${actual.canalCodigo}: ${markupBasisPoints}bp (activo: ${activo})`,
    });
    return c.json({ id, unidadId, canalCodigo: actual.canalCodigo, markupBasisPoints, activo });
  });

  app.delete(`${base}/reglas-canal/:id`, async (c) => {
    assertVerticalRole(c, PRICING_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const unidad = await requireUnidad(repo, propertyId, unidadId);
    const hoy = await hoyIso(deps.rentasCalendarSyncRepo(db), propertyId);
    const actual = (await repo.loadConfiguracionPricing(unidadId, hoy)).reglasCanal.find((r) => r.id === id);
    if (!actual) throw Errors.notFound("Regla de canal no encontrada en esta unidad.");
    const ok = await escrituraPricing(db, () => repo.deleteReglaCanalPricing(unidadId, id));
    if (!ok) throw Errors.serviceUnavailable("No disponible aún: la base de datos no permitió borrar la regla de canal.");
    await repo.registrarAuditoria({
      organizationId: unidad.organizationId,
      actorUserId: userId,
      action: "pricing.regla_canal.eliminada",
      entityType: "pricing",
      entityId: unidadId,
      campo: "markup_basis_points",
      antes: `canal ${actual.canalCodigo}: ${actual.markupBasisPoints}bp (activo: ${actual.activo})`,
      despues: null,
    });
    return c.json({ id, unidadId, eliminada: true });
  });

  return app;
}
