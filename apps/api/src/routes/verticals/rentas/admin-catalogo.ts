// Rn-19 -- alta y edicion de propiedades, unidades y propietarios desde el panel (hasta ahora solo el registro
// inicial creaba esas filas y no habia forma de sumar una casa, una unidad o un propietario).
//   GET   /v1/rentas/:propertyId/admin/catalogo                        propiedad actual, propiedades, unidades y propietarios
//   PATCH /v1/rentas/:propertyId/admin/catalogo/propiedad              nombre, zona horaria IANA, moneda MXN/USD
//   POST  /v1/rentas/:propertyId/admin/catalogo/propiedades            propiedad nueva de la misma organizacion
//   POST  /v1/rentas/:propertyId/admin/catalogo/unidades               unidad nueva en la propiedad
//   PATCH /v1/rentas/:propertyId/admin/catalogo/unidades/:unidadId
//   PUT   /v1/rentas/:propertyId/admin/catalogo/unidades/:unidadId/responsable-limpieza   (paridad3: responsable por omision)
//   POST  /v1/rentas/:propertyId/admin/catalogo/propietarios
//   PATCH /v1/rentas/:propertyId/admin/catalogo/propietarios/:propietarioId
//
// Escritura solo admin_gestora (CATALOGO_ESCRITURA_ROLES), lectura ademas operador:acceso_total y contador. La
// autoridad real es la funcion SQL `security definer` de la migracion 027 (rol, alcance de property, propietario de
// otra organizacion, nombre duplicado, moneda inmutable con movimientos); estas rutas validan la forma (zona IANA,
// moneda MXN/USD, rangos), comprueban que la unidad/propietario pertenezca a la propiedad/organizacion del path y
// escriben la bitacora. Contra una base sin migrar, las escrituras responden 503 honesto, la lectura sigue sirviendo.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CATALOGO_ESCRITURA_ROLES,
  CATALOGO_LECTURA_ROLES,
  LIMPIEZA_RESPONSABLE_ROLES,
  MONEDAS_PERMITIDAS,
  validarEntradaActualizarPropiedad,
  validarEntradaActualizarPropietario,
  validarEntradaActualizarUnidad,
  validarEntradaCrearPropiedad,
  validarEntradaCrearPropietario,
  validarEntradaCrearUnidad,
} from "@atiende/domain-rentas";
import type { RentasAuditEntityType } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { catalogoRepo, valorOError } from "./catalogo-http.ts";
import { esMiembroAsignable } from "./limpieza.ts";

const MAX_BODY = 4 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `a=1 b=2` de los campos presentes: resumen minimo para la bitacora, nunca una fila completa. */
function pares(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`)
    .join(" ");
}

export function rentasAdminCatalogoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const raiz = "/v1/rentas/:propertyId/admin/catalogo";
  const rutas = [raiz, `${raiz}/propiedad`, `${raiz}/propiedades`, `${raiz}/unidades`, `${raiz}/unidades/:unidadId`, `${raiz}/unidades/:unidadId/responsable-limpieza`, `${raiz}/propietarios`, `${raiz}/propietarios/:propietarioId`];
  for (const path of rutas) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function auditar(
    c: Context<CoreAuthHonoEnv>,
    entityType: RentasAuditEntityType,
    action: string,
    entityId: string,
    campo: string,
    antes: string | null,
    despues: string | null,
  ): Promise<void> {
    await deps.rentasRepo(c.get("db")).registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action, entityType, entityId, campo, antes, despues });
  }

  app.get(raiz, async (c) => {
    assertVerticalRole(c, CATALOGO_LECTURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const repo = catalogoRepo(deps, c.get("db"));
    const [propiedades, unidades, propietarios] = await Promise.all([repo.listarPropiedades(organizationId), repo.listarUnidades(propertyId), repo.listarPropietarios(organizationId)]);
    const propiedad = propiedades.find((p) => p.propertyId === propertyId) ?? null;
    const puedeEditar = (CATALOGO_ESCRITURA_ROLES as readonly string[]).includes(c.get("verticalRole") ?? "");
    return c.json({ propiedad, propiedades, unidades, propietarios, monedas: MONEDAS_PERMITIDAS, puedeEditar });
  });

  app.patch(`${raiz}/propiedad`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const validada = validarEntradaActualizarPropiedad(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const repo = catalogoRepo(deps, c.get("db"));
    const previa = (await repo.listarPropiedades(c.get("organizationId"))).find((p) => p.propertyId === propertyId);
    valorOError(await repo.actualizarPropiedad(propertyId, validada.valor), "Editar la propiedad");
    await auditar(c, "propiedad", "propiedad.actualizada", propertyId, Object.keys(validada.valor).join(","), previa ? pares({ nombre: validada.valor.nombre === undefined ? undefined : previa.nombre, zonaHoraria: validada.valor.zonaHoraria === undefined ? undefined : previa.zonaHoraria, moneda: validada.valor.moneda === undefined ? undefined : previa.moneda }) : null, pares({ ...validada.valor }));
    return c.json({ propertyId });
  });

  app.post(`${raiz}/propiedades`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const validada = validarEntradaCrearPropiedad(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const { propertyId } = valorOError(await catalogoRepo(deps, c.get("db")).crearPropiedad(c.get("organizationId"), validada.valor), "Crear una propiedad");
    await auditar(c, "propiedad", "propiedad.creada", propertyId, "nombre,zonaHoraria,moneda", null, pares({ ...validada.valor }));
    return c.json({ propertyId }, 201);
  });

  app.post(`${raiz}/unidades`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const validada = validarEntradaCrearUnidad(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const { id } = valorOError(await catalogoRepo(deps, c.get("db")).crearUnidad(propertyId, validada.valor), "Crear una unidad");
    await auditar(c, "unidad", "unidad.creada", id, "nombre,propietarioId,duracionMinimaNoches", null, pares({ ...validada.valor }));
    return c.json({ id }, 201);
  });

  app.patch(`${raiz}/unidades/:unidadId`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const validada = validarEntradaActualizarUnidad(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const repo = catalogoRepo(deps, c.get("db"));
    // Solo unidades de ESTA propiedad: una de otra propiedad (o de otra organizacion) responde 404, igual que una inexistente.
    const previa = (await repo.listarUnidades(propertyId)).find((u) => u.id === unidadId);
    if (!previa) throw Errors.notFound("Unidad no encontrada en esta propiedad.");
    valorOError(await repo.actualizarUnidad(unidadId, validada.valor), "Editar la unidad");
    await auditar(
      c,
      "unidad",
      "unidad.actualizada",
      unidadId,
      Object.keys(validada.valor).join(","),
      pares({
        nombre: validada.valor.nombre === undefined ? undefined : previa.nombre,
        propietarioId: validada.valor.propietarioId === undefined ? undefined : previa.propietarioId,
        duracionMinimaNoches: validada.valor.duracionMinimaNoches === undefined ? undefined : previa.duracionMinimaNoches,
      }),
      pares({ ...validada.valor }),
    );
    return c.json({ id: unidadId });
  });

  // Responsable de limpieza por omision de la unidad (paridad3, migracion 033): la tarea de limpieza de cada checkout nace asignada a el.
  // admin_gestora y operador:acceso_total (LIMPIEZA_RESPONSABLE_ROLES, espejo de la funcion SQL, que es la autoridad real). Cuerpo
  // `{ responsableId: uuid | null }` (null lo quita). La persona debe ser miembro con acceso a la propiedad (422 si no).
  app.put(`${raiz}/unidades/:unidadId/responsable-limpieza`, async (c) => {
    assertVerticalRole(c, LIMPIEZA_RESPONSABLE_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const raw = await readJsonCapped<{ responsableId?: unknown }>(c.req.raw, MAX_BODY);
    if (raw.responsableId !== null && (typeof raw.responsableId !== "string" || !UUID_RE.test(raw.responsableId))) {
      throw Errors.validation("responsableId: se esperaba el id de una persona del equipo o null para quitarlo.");
    }
    const responsableId = raw.responsableId;
    const repo = catalogoRepo(deps, c.get("db"));
    // Solo unidades de ESTA propiedad: una de otra propiedad (o de otra organizacion) responde 404, igual que una inexistente.
    const previa = (await repo.listarUnidades(propertyId)).find((u) => u.id === unidadId);
    if (!previa) throw Errors.notFound("Unidad no encontrada en esta propiedad.");
    if (responsableId !== null && (await esMiembroAsignable(c.get("db"), propertyId, responsableId)) === false) throw Errors.rentasAsignadoNoValido();
    valorOError(await repo.fijarResponsableLimpieza(unidadId, responsableId), "Fijar el responsable de limpieza", "033");
    await auditar(c, "unidad", "unidad.responsable_limpieza", unidadId, "responsableLimpiezaId", previa.responsableLimpiezaId, responsableId);
    return c.json({ id: unidadId, responsableLimpiezaId: responsableId });
  });

  app.post(`${raiz}/propietarios`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const validada = validarEntradaCrearPropietario(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const { id } = valorOError(await catalogoRepo(deps, c.get("db")).crearPropietario(c.get("organizationId"), validada.valor), "Crear un propietario");
    // El correo del propietario es un dato personal: la bitacora (append-only) solo guarda que se dio de alta, nunca el correo.
    await auditar(c, "propietario", "propietario.creado", id, "nombre", null, validada.valor.nombre);
    return c.json({ id }, 201);
  });

  app.patch(`${raiz}/propietarios/:propietarioId`, async (c) => {
    assertVerticalRole(c, CATALOGO_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propietarioId = c.req.param("propietarioId");
    const validada = validarEntradaActualizarPropietario(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!validada.ok) throw Errors.validation(validada.error);
    const repo = catalogoRepo(deps, c.get("db"));
    const previo = (await repo.listarPropietarios(organizationId)).find((p) => p.id === propietarioId);
    if (!previo) throw Errors.notFound("Propietario no encontrado en esta organización.");
    valorOError(await repo.actualizarPropietario(organizationId, propietarioId, validada.valor), "Editar el propietario");
    // Sin correos en la bitacora (dato personal en una tabla append-only): solo que campos cambiaron y el nombre.
    await auditar(c, "propietario", "propietario.actualizado", propietarioId, Object.keys(validada.valor).join(","), validada.valor.nombre === undefined ? null : previo.nombre, validada.valor.nombre ?? null);
    return c.json({ id: propietarioId });
  });

  return app;
}
