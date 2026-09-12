// Flujo 5 (Fase 2) · Owner statement — generación (con idempotencia H-062) + lectura.
// Ver diseño Fase 2 rentas §4: una request transaccional normal de la misma familia
// que `POST .../reservas/:ocupacionId/movimiento` (Fase 1), NUNCA un proceso batch —
// la "agregación" es un SELECT + un for en memoria (`generarOwnerStatement`, función
// pura sin IO).
//
// Idempotencia (§4.2, réplica de la corrección D-DSD-15 del repo origen, NO de la
// versión que su propia auditoría adversarial encontró rota): el advisory lock
// (`bloquearOwnerStatementEnTransaccion`) serializa dos requests concurrentes para el
// MISMO (owner, property, periodo) ANTES de decidir si crear una versión nueva --
// nunca se depende del `UNIQUE` de base de datos para decidir la respuesta HTTP (eso
// es lo que producía un 500 sin traducir en el repo origen bajo concurrencia real).
//
// Decisión de alcance (§4.1): el statement se genera POR PROPERTY, nunca consolidado
// por owner a través de toda la organización -- `requirePropertyMembership` es la
// única primitiva de autorización disponible hoy.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { bloquearOwnerStatementEnTransaccion, esMismoContenidoQueVersionAnterior, esRangoValido, FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES, generarOwnerStatement } from "@atiende/domain-rentas";
import type { RangoFechas } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  return value;
}

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

interface GenerarStatementBody {
  readonly periodoInicio?: unknown;
  readonly periodoFin?: unknown;
  readonly motivoVersion?: unknown;
}

export function rentasFinanzasStatementsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const ownerPath = "/rentas/:propertyId/owners/:ownerId/statements";
  const detallePath = "/rentas/:propertyId/statements/:id";
  app.use(ownerPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(detallePath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(ownerPath, async (c) => {
    assertVerticalRole(c, FINANZAS_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const ownerId = c.req.param("ownerId");
    const userId = c.get("userId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const raw = await readJsonCapped<GenerarStatementBody>(c.req.raw, 2 * 1024);
    const periodo: RangoFechas = { inicio: requireFecha(raw.periodoInicio, "periodoInicio"), fin: requireFecha(raw.periodoFin, "periodoFin") };
    if (!esRangoValido(periodo)) throw Errors.validation("periodoFin debe ser posterior a periodoInicio.");
    const motivoVersionRaw = requireOptionalString(raw.motivoVersion, "motivoVersion", 500);

    const owner = await repo.findOwnerConUnidadesEnProperty(propertyId, ownerId);
    if (!owner) throw Errors.notFound("Propietario no encontrado, o sin ninguna unidad en esta property.");

    // Primera línea, antes de leer nada más -- serializa cualquier request
    // concurrente para el MISMO (owner, property, periodo) (ver diseño §4.2).
    await bloquearOwnerStatementEnTransaccion(db, ownerId, propertyId, periodo.inicio, periodo.fin);

    const reservas = await repo.findMovimientosPeriodoParaOwner(propertyId, ownerId, periodo);
    if (reservas.length === 0) throw Errors.validation("No hay movimientos financieros en ese periodo para este propietario.");

    const anterior = await repo.findUltimaVersionOwnerStatement(propertyId, ownerId, periodo);

    // El statement es en la moneda de sus propios movimientos -- `generarOwnerStatement`
    // lanza si alguno viene en una moneda distinta (el motor nunca convierte tipo de
    // cambio, ver finanzas/statement.ts).
    const moneda = reservas[0]!.moneda;
    let resultado;
    try {
      resultado = generarOwnerStatement({ ownerId, propertyId, periodo, moneda, reservas });
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }

    if (anterior && esMismoContenidoQueVersionAnterior(resultado.hashContenido, anterior.hashContenido)) {
      // Idempotente: mismo contenido que la última versión -- nunca inserta una fila
      // nueva por una re-ejecución (mismo botón presionado dos veces, un reintento de
      // red, o la segunda mitad de una carrera que el advisory lock ya serializó).
      return c.json({ id: anterior.id, version: anterior.version, creado: false }, 200);
    }

    // Contenido nuevo -> versión nueva. Si ya existía una versión previa, exige
    // `motivoVersion` -- nunca una corrección silenciosa de un statement ya entregado
    // al propietario (validación de la ruta, no del dominio).
    if (anterior && !motivoVersionRaw) {
      throw Errors.validation("motivoVersion es obligatorio al generar una nueva versión de un statement ya existente.");
    }

    const version = (anterior?.version ?? 0) + 1;
    const creado = await repo.insertOwnerStatement({
      organizationId,
      propertyId,
      ownerId,
      periodo,
      version,
      moneda,
      totales: resultado.totales,
      lineas: resultado.lineas,
      hashContenido: resultado.hashContenido,
      motivoVersion: motivoVersionRaw,
      generadoPor: userId,
    });

    return c.json({ id: creado.id, version, creado: true, generadoEn: creado.generadoEn, totales: resultado.totales }, 201);
  });

  app.get(ownerPath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const ownerId = c.req.param("ownerId");
    const repo = deps.rentasRepo(c.get("db"));

    const owner = await repo.findOwnerConUnidadesEnProperty(propertyId, ownerId);
    if (!owner) throw Errors.notFound("Propietario no encontrado, o sin ninguna unidad en esta property.");

    const statements = await repo.listOwnerStatements(propertyId, ownerId);
    return c.json({ ownerId, statements }, 200);
  });

  app.get(detallePath, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const repo = deps.rentasRepo(c.get("db"));

    const statement = await repo.findOwnerStatementDetalle(propertyId, id);
    if (!statement) throw Errors.notFound("Statement no encontrado en esta property.");

    return c.json(statement, 200);
  });

  return app;
}
