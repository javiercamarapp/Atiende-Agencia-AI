// Fase 11 restaurantes — back-office CORE: CRUD real de promociones/marketing (ver
// domain-restaurantes/src/promotions.ts para el porqué completo del gap y por qué
// es deliberadamente nuevo respecto al original). Mismo patrón de montaje/roles
// exacto que admin-catalog.ts (Fase 5): `:propertyId` + `requirePropertyMembership`
// + `assertAccion(c, ...)` (matriz por accion de roles.ts, PL-23) dentro de cada handler — una promoción
// es organization-wide (nunca por-sucursal, igual que categorías/productos),
// `:propertyId` en el path solo sirve para resolver `organizationId` real vía
// `requirePropertyMembership`.
//
// Activar/desactivar una promoción NO es una ruta separada a propósito: es el
// mismo PATCH que edita cualquier otro campo, con `isActive` en el body — mismo
// criterio exacto que `isAvailable` en admin-catalog.ts (nunca duplicar una ruta
// solo para togglear un booleano que el PATCH genérico ya cubre).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { normalizePromotionCode, PROMOTION_CODE_PATTERN, RestaurantesConfigUnavailableError } from "@atiende/domain-restaurantes";
import type { CanalPedido, Promotion, PromotionType, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { UUID_PATTERN } from "@atiende/domain-restaurantes";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { assertAccion } from "./permisos-accion.ts";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function requireNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto no vacío de hasta ${maxLength} caracteres.`);
  }
  return value.trim();
}

function requireCode(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Errors.validation("code: se esperaba un texto no vacío.");
  }
  const code = normalizePromotionCode(value);
  if (!PROMOTION_CODE_PATTERN.test(code)) {
    throw Errors.validation('code: solo mayúsculas, dígitos, "-" y "_", de 3 a 40 caracteres (ej. "BIENVENIDA10").');
  }
  return code;
}

function optionalNullableString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto de hasta ${maxLength} caracteres.`);
  }
  return value;
}

function requireType(value: unknown): PromotionType {
  if (value !== "percentage" && value !== "fixed" && value !== "bogo" && value !== "cortesia") {
    throw Errors.validation('type: se esperaba "percentage", "fixed", "bogo" (2x1) o "cortesia" (combo de cortesía).');
  }
  return value;
}

/** `type` decide el techo real del valor -- un porcentaje nunca puede pasar de 100
 * (mismo CHECK que migrations/010), un fijo no tiene techo aquí (lo acota el total
 * real del pedido en promotions.ts::computePromotionDiscount, nunca aquí). */
function requireValue(value: unknown, type: PromotionType): number {
  // 2x1 y cortesia: el valor no se usa; la tabla exige value = 1 (migraciones 027 y 031). Se acepta omitido o 1.
  if (type === "bogo" || type === "cortesia") {
    if (value !== undefined && value !== 1) throw Errors.validation(`value: ${type === "bogo" ? "un 2x1 (bogo)" : "un combo de cortesía"} no lleva valor; omítalo o envíe 1.`);
    return 1;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw Errors.validation("value: se esperaba un número > 0.");
  }
  if (type === "percentage" && value > 100) {
    throw Errors.validation("value: un descuento porcentual no puede pasar de 100.");
  }
  return Math.round(value * 100) / 100;
}

function optionalNullableNonNegativeNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Errors.validation(`${field}: se esperaba un número >= 0 o null.`);
  }
  return Math.round(value * 100) / 100;
}

function optionalNullablePositiveInt(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw Errors.validation(`${field}: se esperaba un entero > 0 o null.`);
  }
  return value;
}

function optionalNullableIsoDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw Errors.validation(`${field}: se esperaba una fecha ISO o null.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Errors.validation(`${field}: fecha inválida.`);
  return parsed.toISOString();
}

function optionalNullableTime(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw Errors.validation(`${field}: se esperaba "HH:MM" (24h) o null.`);
  }
  return value;
}

function optionalNullableDaysOfWeek(value: unknown): readonly number[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 7 || value.some((v) => !Number.isInteger(v) || v < 0 || v > 6)) {
    throw Errors.validation("daysOfWeek: se esperaba un arreglo de enteros 0-6 (0=domingo) o null.");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

const CANALES_VALIDOS: readonly CanalPedido[] = ["domicilio", "recoger"];

function optionalNullableChannels(value: unknown): readonly CanalPedido[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => !CANALES_VALIDOS.includes(v as CanalPedido))) {
    throw Errors.validation('channels: se esperaba un arreglo no vacío con "domicilio" y/o "recoger", o null (todos los canales).');
  }
  return [...new Set(value as CanalPedido[])].sort();
}

/** Ids de producto elegibles: UUID válidos, máximo 50 y TODOS de esta organización (el arreglo de la
 * base no tiene FK, así que la pertenencia se comprueba aquí). */
async function optionalNullableProductIds(value: unknown, repo: RestaurantesRepository, organizationId: string, field = "productIds"): Promise<readonly string[] | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((v) => typeof v !== "string" || !UUID_PATTERN.test(v))) {
    throw Errors.validation(`${field}: se esperaba un arreglo de 1 a 50 ids de producto (UUID) o null.`);
  }
  const ids = [...new Set(value as string[])];
  for (const id of ids) {
    if (!(await repo.findProduct(organizationId, id))) throw Errors.validation(`${field}: el producto ${id} no existe en esta organización.`);
  }
  return ids;
}

function optionalCourtesyQuantity(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw Errors.validation("courtesyQuantity: se esperaba un entero de 1 a 10 (piezas de cortesía por cada producto de la promoción) o null.");
  }
  return value;
}

/** Reglas cruzadas de la forma FINAL de una promocion (ya mezclado el parche con lo existente). Mismas
 * condiciones que los CHECK de la migracion 031, con un mensaje accionable en vez de un 500/23514. */
function assertPromotionShape(p: {
  readonly type: PromotionType;
  readonly autoApply: boolean;
  readonly channels: readonly CanalPedido[] | null;
  readonly productIds: readonly string[] | null;
  readonly courtesyProductIds: readonly string[] | null;
  readonly courtesyQuantity: number | null;
}): void {
  if (p.autoApply && (!p.channels || p.channels.length === 0)) {
    throw Errors.validation('autoApply: una promoción automática exige channels explícito (por ejemplo ["recoger"]); así nunca se aplica a un canal por omisión.');
  }
  if (p.type === "cortesia") {
    if (!p.productIds || p.productIds.length === 0) throw Errors.validation("productIds: un combo de cortesía necesita los productos que lo disparan.");
    if (!p.courtesyProductIds || p.courtesyProductIds.length === 0) throw Errors.validation("courtesyProductIds: un combo de cortesía necesita la lista de productos de cortesía.");
    if (p.courtesyQuantity === null) throw Errors.validation("courtesyQuantity: un combo de cortesía necesita las piezas de cortesía por producto.");
    const disparadores = new Set(p.productIds);
    if (p.courtesyProductIds.some((id) => disparadores.has(id))) {
      throw Errors.validation("courtesyProductIds: un producto no puede ser a la vez disparador y de cortesía.");
    }
  } else if (p.courtesyProductIds !== null || p.courtesyQuantity !== null) {
    throw Errors.validation('courtesyProductIds/courtesyQuantity: solo aplican a promociones de tipo "cortesia".');
  }
}

/** Base sin las migraciones 027/031: las escrituras de campos nuevos (2x1, canales, automaticas, cortesia) lanzan
 * `RestaurantesConfigUnavailableError` -> 503 honesto con el motivo, nunca un 500. */
async function conCompatibilidad<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RestaurantesConfigUnavailableError) {
      throw Errors.serviceUnavailable("Las promociones 2x1, por canal, automáticas y de cortesía todavía no están disponibles en esta base de datos (falta aplicar las migraciones 027 y 031).");
    }
    throw err;
  }
}

/** Desde la 065 la policy de promotions solo deja escribir a un owner/admin cuya membresia cubre TODO el alcance de la promocion
 * (`property_ids` null = toda la organizacion = solo membresia sin acotar). Se valida aqui para dar un 403 claro en vez de que el
 * 42501 de la policy salga como un 503 de "base sin migrar". Esta API no escribe `property_ids`: una alta siempre es de toda la
 * organizacion, y editar una promocion existente exige que su alcance (`existing.propertyIds`) quede dentro del de la membresia. */
async function assertAlcancePromocion(deps: AppDeps, c: Context<CoreAuthHonoEnv>, alcance: readonly string[] | null | undefined): Promise<void> {
  const membresia = await resolveEffectivePropertyIds(deps, c, c.get("organizationId"), null);
  if (membresia === null) return;
  if (alcance && alcance.length > 0 && alcance.every((id) => membresia.includes(id))) return;
  throw Errors.forbidden("Tu acceso está limitado a algunas sucursales: solo un administrador con acceso a todas puede crear o cambiar promociones de toda la organización.");
}

function serializePromotion(p: Promotion) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    type: p.type,
    value: p.value,
    minOrderTotal: p.minOrderTotal,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    daysOfWeek: p.daysOfWeek,
    startTime: p.startTime,
    endTime: p.endTime,
    maxUses: p.maxUses,
    timesUsed: p.timesUsed,
    isActive: p.isActive,
    channels: p.channels,
    productIds: p.productIds,
    autoApply: p.autoApply,
    courtesyProductIds: p.courtesyProductIds,
    courtesyQuantity: p.courtesyQuantity,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

interface PromotionBody {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly type?: unknown;
  readonly value?: unknown;
  readonly minOrderTotal?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
  readonly daysOfWeek?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly maxUses?: unknown;
  readonly isActive?: unknown;
  readonly channels?: unknown;
  readonly productIds?: unknown;
  readonly autoApply?: unknown;
  readonly courtesyProductIds?: unknown;
  readonly courtesyQuantity?: unknown;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw Errors.validation(`${field}: se esperaba true o false.`);
  return value;
}

export function restaurantesAdminPromotionsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/promotions/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/promotions", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/v1/restaurantes/:propertyId/admin/promotions", async (c) => {
    assertAccion(c, "promociones.ver");
    const repo = deps.restaurantesRepo(c.get("db"));
    const promotions = await repo.listPromotions(c.get("organizationId"));
    return c.json({ promotions: promotions.map(serializePromotion) });
  });

  app.post("/v1/restaurantes/:propertyId/admin/promotions", async (c) => {
    assertAccion(c, "promociones.editar");
    await assertAlcancePromocion(deps, c, null);
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<PromotionBody>(c.req.raw, 8 * 1024);

    const code = requireCode(raw.code);
    const name = requireNonEmptyString(raw.name, "name", 160);
    const type = requireType(raw.type);
    const value = requireValue(raw.value, type);
    const description = optionalNullableString(raw.description, "description", 2000);
    const minOrderTotal = optionalNullableNonNegativeNumber(raw.minOrderTotal, "minOrderTotal");
    const startsAt = optionalNullableIsoDate(raw.startsAt, "startsAt");
    const endsAt = optionalNullableIsoDate(raw.endsAt, "endsAt");
    if (startsAt && endsAt && endsAt < startsAt) throw Errors.validation("endsAt no puede ser anterior a startsAt.");
    const daysOfWeek = optionalNullableDaysOfWeek(raw.daysOfWeek);
    const startTime = optionalNullableTime(raw.startTime, "startTime");
    const endTime = optionalNullableTime(raw.endTime, "endTime");
    const maxUses = optionalNullablePositiveInt(raw.maxUses, "maxUses");
    const isActive = raw.isActive === undefined ? undefined : Boolean(raw.isActive);
    const channels = optionalNullableChannels(raw.channels);
    const productIds = await optionalNullableProductIds(raw.productIds, repo, c.get("organizationId"));
    const autoApply = optionalBoolean(raw.autoApply, "autoApply");
    const courtesyProductIds = await optionalNullableProductIds(raw.courtesyProductIds, repo, c.get("organizationId"), "courtesyProductIds");
    const courtesyQuantity = optionalCourtesyQuantity(raw.courtesyQuantity);
    assertPromotionShape({
      type,
      autoApply: autoApply ?? false,
      channels: channels ?? null,
      productIds: productIds ?? null,
      courtesyProductIds: courtesyProductIds ?? null,
      courtesyQuantity: courtesyQuantity ?? null,
    });

    const existing = await repo.listPromotions(c.get("organizationId"));
    if (existing.some((p) => p.code === code)) {
      throw Errors.validation(`Ya existe una promoción con el código "${code}" en esta organización.`);
    }

    const created = await conCompatibilidad(() => repo.createPromotion(c.get("organizationId"), {
      code,
      name,
      type,
      value,
      ...(description !== undefined ? { description } : {}),
      ...(minOrderTotal !== undefined ? { minOrderTotal } : {}),
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(maxUses !== undefined ? { maxUses } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(channels !== undefined ? { channels } : {}),
      ...(productIds !== undefined ? { productIds } : {}),
      ...(autoApply !== undefined ? { autoApply } : {}),
      ...(courtesyProductIds !== undefined ? { courtesyProductIds } : {}),
      ...(courtesyQuantity !== undefined ? { courtesyQuantity } : {}),
    }));
    logEvent(c, "info", "restaurantes_admin_promocion_creada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), promotionId: created.id, code });

    // FASE 3 (producto) — alta de promoción (ver
    // packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql).
    // Best-effort real, nunca revierte la promoción ya creada.
    await repo.registrarAuditoria({
      organizationId: c.get("organizationId"),
      actorUserId: c.get("userId"),
      action: "promocion.creada",
      entityType: "promocion",
      entityId: created.id,
      campo: "code,type,value,isActive,channels,productIds,autoApply,courtesyProductIds,courtesyQuantity",
      antes: null,
      despues: `${created.code} (${created.type} ${created.value}${created.type === "percentage" ? "%" : ""}, activa=${created.isActive}, canales=${created.channels?.join("|") ?? "todos"}, productos=${created.productIds?.length ?? "todos"}, automatica=${created.autoApply}${created.type === "cortesia" ? `, cortesia=${created.courtesyQuantity}x${created.courtesyProductIds?.length ?? 0} productos` : ""})`,
    });

    return c.json({ promotion: serializePromotion(created) }, 201);
  });

  app.patch("/v1/restaurantes/:propertyId/admin/promotions/:promotionId", async (c) => {
    assertAccion(c, "promociones.editar");
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const promotionId = c.req.param("promotionId");
    const raw = await readJsonCapped<PromotionBody>(c.req.raw, 8 * 1024);

    const existing = await repo.findPromotion(organizationId, promotionId);
    if (!existing) throw Errors.notFound("Promoción no encontrada.");
    await assertAlcancePromocion(deps, c, existing.propertyIds);

    const code = raw.code !== undefined ? requireCode(raw.code) : undefined;
    if (code !== undefined && code !== existing.code) {
      const all = await repo.listPromotions(organizationId);
      if (all.some((p) => p.id !== promotionId && p.code === code)) {
        throw Errors.validation(`Ya existe una promoción con el código "${code}" en esta organización.`);
      }
    }
    const type = raw.type !== undefined ? requireType(raw.type) : undefined;
    // Cambiar el tipo sin mandar el valor dejaría el valor del tipo anterior (p. ej. 1 de un 2x1 como 1%).
    if (type !== undefined && type !== existing.type && type !== "bogo" && type !== "cortesia" && raw.value === undefined) {
      throw Errors.validation("value: al cambiar el tipo de la promoción envíe también el valor.");
    }
    const value = raw.value !== undefined || type === "bogo" || type === "cortesia" ? requireValue(raw.value, type ?? existing.type) : undefined;
    const startsAt = optionalNullableIsoDate(raw.startsAt, "startsAt");
    const endsAt = optionalNullableIsoDate(raw.endsAt, "endsAt");
    const effectiveStartsAt = startsAt !== undefined ? startsAt : existing.startsAt;
    const effectiveEndsAt = endsAt !== undefined ? endsAt : existing.endsAt;
    if (effectiveStartsAt && effectiveEndsAt && effectiveEndsAt < effectiveStartsAt) {
      throw Errors.validation("endsAt no puede ser anterior a startsAt.");
    }

    const channels = optionalNullableChannels(raw.channels);
    const productIds = await optionalNullableProductIds(raw.productIds, repo, organizationId);
    const autoApply = optionalBoolean(raw.autoApply, "autoApply");
    const courtesyProductIds = await optionalNullableProductIds(raw.courtesyProductIds, repo, organizationId, "courtesyProductIds");
    const courtesyQuantity = optionalCourtesyQuantity(raw.courtesyQuantity);
    // Forma FINAL (parche sobre lo existente): la combinacion es la que debe ser valida, no cada campo suelto.
    assertPromotionShape({
      type: type ?? existing.type,
      autoApply: autoApply ?? existing.autoApply,
      channels: channels !== undefined ? channels : existing.channels,
      productIds: productIds !== undefined ? productIds : existing.productIds,
      courtesyProductIds: courtesyProductIds !== undefined ? courtesyProductIds : existing.courtesyProductIds,
      courtesyQuantity: courtesyQuantity !== undefined ? courtesyQuantity : existing.courtesyQuantity,
    });

    const patch = {
      code,
      name: raw.name !== undefined ? requireNonEmptyString(raw.name, "name", 160) : undefined,
      description: optionalNullableString(raw.description, "description", 2000),
      type,
      value,
      minOrderTotal: optionalNullableNonNegativeNumber(raw.minOrderTotal, "minOrderTotal"),
      startsAt,
      endsAt,
      daysOfWeek: optionalNullableDaysOfWeek(raw.daysOfWeek),
      startTime: optionalNullableTime(raw.startTime, "startTime"),
      endTime: optionalNullableTime(raw.endTime, "endTime"),
      maxUses: optionalNullablePositiveInt(raw.maxUses, "maxUses"),
      isActive: raw.isActive === undefined ? undefined : Boolean(raw.isActive),
      channels,
      productIds,
      autoApply,
      courtesyProductIds,
      courtesyQuantity,
    };
    const updated = await conCompatibilidad(() => repo.updatePromotion(organizationId, promotionId, patch));
    if (!updated) throw Errors.notFound("Promoción no encontrada.");
    logEvent(c, "info", "restaurantes_admin_promocion_actualizada", { actorUserId: c.get("userId"), organizationId, promotionId });

    // FASE 3 (producto) — cambio/baja de promoción: "baja" en este vertical es
    // `isActive: false` (no hay DELETE, ver comentario de cabecera de este
    // archivo) — se distingue el action para que la bitácora lo muestre como lo
    // que es (alta/cambio/baja), aunque las tres pasen por el mismo PATCH.
    const huboCambioDeActivacion = patch.isActive !== undefined && patch.isActive !== existing.isActive;
    const action = huboCambioDeActivacion ? (patch.isActive ? "promocion.activada" : "promocion.desactivada") : "promocion.actualizada";
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action,
      entityType: "promocion",
      entityId: updated.id,
      campo: huboCambioDeActivacion ? "isActive" : "value,startsAt,endsAt,daysOfWeek,startTime,endTime,maxUses",
      antes: `${existing.code} (${existing.type} ${existing.value}, activa=${existing.isActive})`,
      despues: `${updated.code} (${updated.type} ${updated.value}, activa=${updated.isActive})`,
    });

    return c.json({ promotion: serializePromotion(updated) });
  });

  return app;
}
