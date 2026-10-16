// Modelo PM (migración 023) — configuración editable POR SUCURSAL desde el panel:
//   - política: horario (turnos / doble turno / cierre pasada la medianoche), pedido mínimo
//     por canal y política de propina;
//   - cobertura de entrega: qué zonas conocidas (`known_zone`) cubre la sucursal;
//   - número de WhatsApp de la sucursal;
//   - marcas "no se vende a domicilio" de productos y categorías.
//
// Autorización: política, cobertura y WhatsApp son owner/admin (`STAFF_INVITE_ROLES`), mismo
// umbral que `admin-config.ts` y que las policies de la migración (RLS es la autoridad; esta
// capa da defensa en profundidad y un mejor mensaje). Las marcas no_domicilio (lectura) usan `MANAGER_ROLES`; escribirlas edita
// products/categories, asi que exigen la accion `catalogo.precio` (owner/admin, PL-23). Todas corren en la sesión
// de STAFF autenticado y respetan el alcance por membership (`resolveEffectivePropertyIds`):
// un staff acotado a una sucursal nunca edita otra aunque la ruta cuelgue de su `:propertyId`.
//
// Base sin migrar: las lecturas devuelven "sin configurar" (vacío honesto) y las escrituras
// responden 503 (`RestaurantesConfigUnavailableError`), nunca 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { assertAccion } from "./permisos-accion.ts";
import { MANAGER_ROLES, OrderValidationError, reporteColoniasAmbiguas, RestaurantesConfigUnavailableError, STAFF_INVITE_ROLES, WhatsappNumberInUseError, horarioDePuente, validarExcepcionHorario, validarHorario } from "@atiende/domain-restaurantes";
import type { BranchHoursException, BranchPolicy, PropinaPolitica } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { conAvisoOnboardingListo } from "./onboarding-aviso.ts";

const PHONE_NUMBER_ID_RE = /^\d{5,32}$/;
const PROPINA_POLITICAS: readonly PropinaPolitica[] = ["nunca", "siempre", "solo_tarjeta"];
const MAX_PEDIDO_MINIMO = 1_000_000;

interface PoliticaBody {
  readonly horario?: unknown;
  readonly pedidoMinimoDomicilio?: unknown;
  readonly pedidoMinimoRecoger?: unknown;
  readonly propinaPolitica?: unknown;
  // Migracion 070: opcionales; si no vienen se conserva lo que la sucursal ya tenia.
  readonly visibleEnDirectorio?: unknown;
  readonly aceptaDomicilio?: unknown;
  readonly diasDomicilio?: unknown;
  readonly deTemporada?: unknown;
}

function optionalBool(value: unknown, field: string, previo: boolean): boolean {
  if (value === undefined) return previo;
  if (typeof value !== "boolean") throw Errors.validation(`${field}: debe ser true o false.`);
  return value;
}

function parseDiasDomicilio(value: unknown, previo: readonly number[] | null): readonly number[] | null {
  if (value === undefined) return previo;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 7 || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw Errors.validation("diasDomicilio: debe ser una lista de 1 a 7 numeros 0 (domingo) a 6 (sabado), o null para todos los dias.");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function requiredNullableMoney(value: unknown, field: string): number | null {
  if (value === undefined) throw Errors.validation(`${field}: campo requerido (un monto o null).`);
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PEDIDO_MINIMO) {
    throw Errors.validation(`${field}: se esperaba un monto en pesos entre 0 y ${MAX_PEDIDO_MINIMO}, o null.`);
  }
  return Math.round(value * 100) / 100;
}

/** PUT reemplaza la política COMPLETA: cada campo es obligatorio (valor o null) para que un
 * cliente desactualizado nunca borre por omisión lo que no conoce. */
function parsePolitica(raw: PoliticaBody, previa: BranchPolicy): BranchPolicy {
  let horario: BranchPolicy["horario"];
  if (raw.horario === undefined) throw Errors.validation("horario: campo requerido (lista de turnos o null).");
  if (raw.horario === null) horario = null;
  else {
    try {
      horario = validarHorario(raw.horario);
    } catch (err) {
      if (err instanceof OrderValidationError) throw Errors.validation(`horario: ${err.message}`);
      throw err;
    }
  }
  let propinaPolitica: PropinaPolitica | null;
  if (raw.propinaPolitica === undefined) throw Errors.validation("propinaPolitica: campo requerido (nunca | siempre | solo_tarjeta | null).");
  if (raw.propinaPolitica === null) propinaPolitica = null;
  else if (typeof raw.propinaPolitica === "string" && (PROPINA_POLITICAS as readonly string[]).includes(raw.propinaPolitica)) propinaPolitica = raw.propinaPolitica as PropinaPolitica;
  else throw Errors.validation("propinaPolitica: debe ser nunca, siempre, solo_tarjeta o null.");
  return {
    horario,
    pedidoMinimoDomicilio: requiredNullableMoney(raw.pedidoMinimoDomicilio, "pedidoMinimoDomicilio"),
    pedidoMinimoRecoger: requiredNullableMoney(raw.pedidoMinimoRecoger, "pedidoMinimoRecoger"),
    propinaPolitica,
    visibleEnDirectorio: raw.visibleEnDirectorio === undefined ? (previa.visibleEnDirectorio ?? null) : raw.visibleEnDirectorio === null ? null : optionalBool(raw.visibleEnDirectorio, "visibleEnDirectorio", false),
    aceptaDomicilio: optionalBool(raw.aceptaDomicilio, "aceptaDomicilio", previa.aceptaDomicilio ?? true),
    diasDomicilio: parseDiasDomicilio(raw.diasDomicilio, previa.diasDomicilio ?? null),
    deTemporada: optionalBool(raw.deTemporada, "deTemporada", previa.deTemporada ?? false),
  };
}

function serializePolitica(p: BranchPolicy) {
  return {
    horario: p.horario,
    pedidoMinimoDomicilio: p.pedidoMinimoDomicilio,
    pedidoMinimoRecoger: p.pedidoMinimoRecoger,
    propinaPolitica: p.propinaPolitica,
    visibleEnDirectorio: p.visibleEnDirectorio ?? null,
    aceptaDomicilio: p.aceptaDomicilio ?? true,
    diasDomicilio: p.diasDomicilio ?? null,
    deTemporada: p.deTemporada ?? false,
  };
}

// ---- puentes (migracion 031): excepciones de horario por fecha ----

interface PuenteBody {
  readonly branchIds?: unknown;
  readonly fechaDesde?: unknown;
  readonly fechaHasta?: unknown;
  /** Turnos que rigen TODOS los dias del puente: [{abre:"HH:MM", cierra:"HH:MM"}]. Parametrizable: la hora del
   * cambio de turno la define el negocio. Alternativa avanzada: `horario` completo (con `dias`). */
  readonly turnos?: unknown;
  readonly horario?: unknown;
  /** `true` = la sucursal queda CERRADA todo el rango (feriado, imprevisto): equivale a un horario vacio. Excluyente con `turnos`/`horario`. */
  readonly cerrado?: unknown;
  readonly motivo?: unknown;
}

const MAX_SUCURSALES_PUENTE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseHorarioPuente(raw: PuenteBody) {
  if (raw.cerrado !== undefined && typeof raw.cerrado !== "boolean") throw Errors.validation("cerrado: se esperaba true o false.");
  if (raw.cerrado === true) {
    if (raw.turnos !== undefined || raw.horario !== undefined) throw Errors.validation("Un cierre de fecha completa (`cerrado: true`) no lleva `turnos` ni `horario`.");
    try {
      return validarExcepcionHorario({ fechaDesde: raw.fechaDesde, fechaHasta: raw.fechaHasta, horario: [], motivo: raw.motivo });
    } catch (err) {
      if (err instanceof OrderValidationError) throw Errors.validation(err.message);
      throw err;
    }
  }
  if ((raw.turnos === undefined) === (raw.horario === undefined)) throw Errors.validation("Envíe `turnos` (lista de {abre, cierra} para todos los días del puente) o `horario` completo, no ambos ni ninguno.");
  try {
    let horario: unknown = raw.horario;
    if (raw.turnos !== undefined) {
      if (!Array.isArray(raw.turnos) || raw.turnos.length === 0 || raw.turnos.length > 4) throw new OrderValidationError("turnos: se esperaba una lista de 1 a 4 turnos {abre, cierra}.");
      horario = horarioDePuente(raw.turnos as { abre: string; cierra: string }[]);
    }
    return validarExcepcionHorario({ fechaDesde: raw.fechaDesde, fechaHasta: raw.fechaHasta, horario, motivo: raw.motivo });
  } catch (err) {
    if (err instanceof OrderValidationError) throw Errors.validation(err.message);
    throw err;
  }
}

function serializePuente(e: BranchHoursException) {
  return { id: e.id, branchId: e.propertyId, fechaDesde: e.fechaDesde, fechaHasta: e.fechaHasta, horario: e.horario, motivo: e.motivo };
}

function asUnavailable(err: unknown): never {
  if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
  throw err;
}

export function restaurantesAdminModeloPmRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const branchBase = "/v1/restaurantes/:propertyId/admin/config/sucursales/:branchId";
  const politicaPath = `${branchBase}/politica`;
  const zonasRepartoPath = `${branchBase}/zonas-reparto`;
  const whatsappPath = `${branchBase}/whatsapp`;
  const coloniasAmbiguasPath = "/v1/restaurantes/:propertyId/admin/config/colonias-ambiguas";
  const puentesPath = "/v1/restaurantes/:propertyId/admin/config/puentes";
  const puentePath = `${puentesPath}/:exceptionId`;
  const noDomicilioPath = "/v1/restaurantes/:propertyId/admin/config/no-domicilio";
  const noDomicilioProductoPath = `${noDomicilioPath}/productos/:productId`;
  const noDomicilioCategoriaPath = `${noDomicilioPath}/categorias/:categoryId`;

  for (const path of [politicaPath, zonasRepartoPath, whatsappPath, coloniasAmbiguasPath, puentesPath, puentePath, noDomicilioPath, noDomicilioProductoPath, noDomicilioCategoriaPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  /** La sucursal debe existir en ESTA organización y estar dentro del alcance del staff. */
  async function resolveBranch(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId") ?? "";
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(branchId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    const branch = await deps.restaurantesRepo(c.get("db")).findBranchById(organizationId, branchId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return { organizationId, branch, repo: deps.restaurantesRepo(c.get("db")) };
  }

  // ---- puentes: excepciones de horario por fecha (owner/admin, como la política) ----
  // Lista las vigentes y futuras de las sucursales dentro del alcance del staff. Base sin migrar -> lista vacia.
  app.get(puentesPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const desde = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const todas = await deps.restaurantesRepo(c.get("db")).listUpcomingBranchHoursExceptions(organizationId, desde);
    return c.json({ puentes: todas.filter((e) => scope === null || scope.includes(e.propertyId)).map(serializePuente) });
  });

  // Crea el MISMO puente para varias sucursales a la vez (p. ej. las dos que abren ambos turnos en un puente).
  app.post(puentesPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<PuenteBody>(c.req.raw, 16 * 1024);
    if (!Array.isArray(raw.branchIds) || raw.branchIds.length === 0 || raw.branchIds.length > MAX_SUCURSALES_PUENTE || raw.branchIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
      throw Errors.validation(`branchIds: se esperaba una lista de 1 a ${MAX_SUCURSALES_PUENTE} ids de sucursal.`);
    }
    const branchIds = [...new Set(raw.branchIds as string[])];
    const datos = parseHorarioPuente(raw);
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    for (const branchId of branchIds) {
      if (scope !== null && !scope.includes(branchId)) throw Errors.forbidden("No tienes acceso a una de las sucursales indicadas.");
      if (!(await repo.findBranchById(organizationId, branchId))) throw Errors.notFound(`Sucursal no encontrada: ${branchId}`);
    }
    const creados: BranchHoursException[] = [];
    try {
      for (const branchId of branchIds) {
        creados.push(await repo.createBranchHoursException(organizationId, { propertyId: branchId, ...datos }));
      }
    } catch (err) {
      return asUnavailable(err);
    }
    logEvent(c, "info", "restaurantes_admin_puente_creado", { actorUserId: c.get("userId"), organizationId, sucursales: branchIds.length, fechaDesde: datos.fechaDesde, fechaHasta: datos.fechaHasta });
    for (const e of creados) {
      await repo.registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "configuracion.puente_creado",
        entityType: "configuracion",
        entityId: e.propertyId,
        campo: "puente",
        antes: null,
        despues: JSON.stringify({ fechaDesde: e.fechaDesde, fechaHasta: e.fechaHasta, turnos: e.horario.length, motivo: e.motivo }),
      });
    }
    return c.json({ puentes: creados.map(serializePuente) }, 201);
  });

  app.delete(puentePath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const exceptionId = c.req.param("exceptionId") ?? "";
    if (!UUID_RE.test(exceptionId)) throw Errors.validation("exceptionId: se esperaba un UUID.");
    // Alcance: el staff acotado a una sucursal solo borra puentes de SU sucursal.
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const existente = (await repo.listUpcomingBranchHoursExceptions(organizationId, "1970-01-01")).find((e) => e.id === exceptionId);
    if (!existente) throw Errors.notFound("Puente no encontrado.");
    if (scope !== null && !scope.includes(existente.propertyId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    let borrado: boolean;
    try {
      borrado = await repo.deleteBranchHoursException(organizationId, exceptionId);
    } catch (err) {
      return asUnavailable(err);
    }
    if (!borrado) throw Errors.notFound("Puente no encontrado.");
    logEvent(c, "info", "restaurantes_admin_puente_eliminado", { actorUserId: c.get("userId"), organizationId, exceptionId });
    return c.json({ ok: true });
  });

  // ---- política por sucursal ----
  app.get(politicaPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { branch, repo } = await resolveBranch(c);
    return c.json(serializePolitica(await repo.findBranchPolicy(branch.propertyId)));
  });

  app.put(politicaPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const anterior = await repo.findBranchPolicy(branch.propertyId);
    const nueva = parsePolitica(await readJsonCapped<PoliticaBody>(c.req.raw, 16 * 1024), anterior);

    let guardada: BranchPolicy;
    try {
      guardada = await conAvisoOnboardingListo(deps, c, organizationId, () => repo.upsertBranchPolicy(organizationId, branch.propertyId, nueva));
    } catch (err) {
      return asUnavailable(err);
    }

    logEvent(c, "info", "restaurantes_admin_politica_sucursal_actualizada", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.politica_sucursal_actualizada",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "politica",
      antes: JSON.stringify(serializePolitica(anterior)),
      despues: JSON.stringify(serializePolitica(guardada)),
    });
    return c.json(serializePolitica(guardada));
  });

  // ---- cobertura de entrega ----
  app.get(zonasRepartoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { branch, repo } = await resolveBranch(c);
    return c.json({ zoneIds: await repo.listBranchDeliveryZoneIds(branch.propertyId) });
  });

  app.put(zonasRepartoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const raw = await readJsonCapped<{ zoneIds?: unknown }>(c.req.raw, 16 * 1024);
    if (!Array.isArray(raw.zoneIds) || raw.zoneIds.length > 500 || raw.zoneIds.some((id) => typeof id !== "string" || id.length > 64)) {
      throw Errors.validation("zoneIds: se esperaba una lista (máx. 500) de ids de zonas conocidas.");
    }
    const zoneIds = [...new Set(raw.zoneIds as string[])];
    const validas = new Set((await repo.listKnownZones(organizationId)).map((z) => z.id));
    const desconocida = zoneIds.find((id) => !validas.has(id));
    if (desconocida) throw Errors.validation("zoneIds: una de las zonas no existe o pertenece a otra organización.");

    const anterior = await repo.listBranchDeliveryZoneIds(branch.propertyId);
    let guardadas: readonly string[];
    try {
      guardadas = await repo.replaceBranchDeliveryZones(organizationId, branch.propertyId, zoneIds);
    } catch (err) {
      return asUnavailable(err);
    }
    logEvent(c, "info", "restaurantes_admin_zonas_reparto_actualizadas", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId, zonas: guardadas.length });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.zonas_reparto_actualizadas",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "zonasReparto",
      antes: String(anterior.length),
      despues: String(guardadas.length),
    });
    return c.json({ zoneIds: guardadas });
  });

  // ---- reporte de colonias ambiguas (X42): solo lectura, owner/admin sin alcance acotado a una sucursal ----
  // Muestra, por colonia, la sucursal que la cubre, los km del piloto original o calculados, la segunda sucursal y la marca "revisar". No
  // escribe nada y no trae datos personales. Contra la base sin la migracion 056 responde 200 con `disponible: false` (vacio honesto).
  app.get(coloniasAmbiguasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null) throw Errors.forbidden("El reporte de colonias abarca todas las sucursales: solo lo ve el staff sin alcance acotado a una sucursal.");
    return c.json(await reporteColoniasAmbiguas(deps.restaurantesRepo(c.get("db")), organizationId));
  });

  // ---- WhatsApp de la sucursal ----
  app.get(whatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const numero = (await repo.listWhatsappBranchChannels(organizationId)).find((n) => n.propertyId === branch.propertyId);
    return c.json({ phoneNumberId: numero?.phoneNumberId ?? null });
  });

  app.put(whatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const raw = await readJsonCapped<{ phoneNumberId?: unknown }>(c.req.raw, 1024);
    if (typeof raw.phoneNumberId !== "string" || !PHONE_NUMBER_ID_RE.test(raw.phoneNumberId)) {
      throw Errors.validation("phoneNumberId inválido -- se esperaban solo dígitos (5 a 32).");
    }
    const anterior = (await repo.listWhatsappBranchChannels(organizationId)).find((n) => n.propertyId === branch.propertyId);

    let guardado;
    try {
      guardado = await repo.upsertWhatsappBranchChannel(organizationId, branch.propertyId, raw.phoneNumberId);
    } catch (err) {
      if (err instanceof WhatsappNumberInUseError) throw Errors.conflict(err.message);
      return asUnavailable(err);
    }
    logEvent(c, "info", "restaurantes_admin_whatsapp_sucursal_actualizado", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.whatsapp_sucursal_actualizado",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "phoneNumberId",
      antes: anterior?.phoneNumberId ?? null,
      despues: guardado.phoneNumberId,
    });
    return c.json({ phoneNumberId: guardado.phoneNumberId });
  });

  app.delete(whatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    let eliminado: boolean;
    try {
      eliminado = await repo.deleteWhatsappBranchChannel(organizationId, branch.propertyId);
    } catch (err) {
      return asUnavailable(err);
    }
    if (!eliminado) throw Errors.notFound("Esta sucursal no tiene un número de WhatsApp propio.");
    logEvent(c, "info", "restaurantes_admin_whatsapp_sucursal_eliminado", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.whatsapp_sucursal_eliminado",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "phoneNumberId",
      antes: null,
      despues: null,
    });
    return c.json({ ok: true });
  });

  // ---- marcas no_domicilio (catálogo) ----
  app.get(noDomicilioPath, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const marks = await deps.restaurantesRepo(c.get("db")).listNoDomicilioMarks(c.get("organizationId"));
    return c.json({ productIds: marks.productIds, categoryIds: marks.categoryIds });
  });

  async function setMark(c: Context<CoreAuthHonoEnv>, kind: "producto" | "categoria", id: string) {
    // Escribe restaurantes.products/categories, que desde la 065 solo actualizan owner/admin: la misma accion que editar el catalogo.
    assertAccion(c, "catalogo.precio");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<{ noDomicilio?: unknown }>(c.req.raw, 1024);
    if (typeof raw.noDomicilio !== "boolean") throw Errors.validation("noDomicilio: se esperaba true o false.");
    const repo = deps.restaurantesRepo(c.get("db"));
    let encontrado: boolean;
    try {
      encontrado = kind === "producto" ? await repo.setProductNoDomicilio(organizationId, id, raw.noDomicilio) : await repo.setCategoryNoDomicilio(organizationId, id, raw.noDomicilio);
    } catch (err) {
      return asUnavailable(err);
    }
    if (!encontrado) throw Errors.notFound(kind === "producto" ? "Producto no encontrado." : "Categoría no encontrada.");
    logEvent(c, "info", "restaurantes_admin_no_domicilio_actualizado", { actorUserId: c.get("userId"), organizationId, kind, id, noDomicilio: raw.noDomicilio });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "catalogo.no_domicilio_actualizado",
      entityType: "producto",
      entityId: id,
      campo: kind === "producto" ? "noDomicilio" : "categoria.noDomicilio",
      antes: String(!raw.noDomicilio),
      despues: String(raw.noDomicilio),
    });
    return c.json({ id, noDomicilio: raw.noDomicilio });
  }

  app.put(noDomicilioProductoPath, (c) => setMark(c, "producto", c.req.param("productId") ?? ""));
  app.put(noDomicilioCategoriaPath, (c) => setMark(c, "categoria", c.req.param("categoryId") ?? ""));

  return app;
}
