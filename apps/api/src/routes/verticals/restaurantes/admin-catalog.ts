// Fase 5 restaurantes — back-office CORE: CRUD real de categorías/productos (ver
// diseño §1.1). `product-search.ts` (Fase 1-2) es SOLO lectura para el agente de
// voz/WhatsApp — este archivo agrega la escritura real que le faltaba al dominio:
// alta/edición de un producto y su categoría, y activar/desactivar su
// disponibilidad EN UNA SUCURSAL (branch_products, la fuente real de precio/
// disponibilidad que ya consulta searchProducts/quoteOrder — ver product-search.ts
// y postgres-repository.ts). Mismo patrón de montaje/roles que admin-kpis.ts
// (Fase 3): `:propertyId` + `requirePropertyMembership` + `assertVerticalRole(c,
// MANAGER_ROLES)` dentro de cada handler.
//
// El catálogo (categorías/productos) es organization-wide, no por-sucursal — un
// producto se crea UNA vez para toda la organización y luego se activa/con precio
// propio en cada sucursal donde se vende (mismo modelo que `restaurantes.products`
// + `restaurantes.branch_products`, ver migrations/001). `:propertyId` en el path
// solo sirve para resolver `organizationId` real vía `requirePropertyMembership` —
// igual que en admin-kpis.ts — y para el sub-recurso de disponibilidad por
// sucursal (`/branch-availability`), que sí es por-property.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES } from "@atiende/domain-restaurantes";
import type { Category, Product } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto no vacío de hasta ${maxLength} caracteres.`);
  }
  return value.trim();
}

function requireSlug(value: unknown, field = "slug"): string {
  const slug = requireNonEmptyString(value, field, 100);
  if (!SLUG_PATTERN.test(slug)) {
    throw Errors.validation(`${field}: solo minúsculas, dígitos y guiones (ej. "tacos-al-pastor").`);
  }
  return slug;
}

function optionalNullableString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto de hasta ${maxLength} caracteres.`);
  }
  return value;
}

function requirePrice(value: unknown, field = "price"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw Errors.validation(`${field}: se esperaba un número >= 0.`);
  }
  return Math.round(value * 100) / 100;
}

function optionalDisplayOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw Errors.validation("displayOrder: se esperaba un entero >= 0.");
  }
  return value;
}

function optionalSearchKeywords(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30 || value.some((v) => typeof v !== "string" || v.length > 60)) {
    throw Errors.validation("searchKeywords: se esperaba un arreglo de hasta 30 textos cortos.");
  }
  return value as readonly string[];
}

function serializeCategory(c: Category) {
  return { id: c.id, name: c.name, slug: c.slug, displayOrder: c.displayOrder };
}

function serializeProduct(p: Product) {
  return {
    id: p.id,
    categoryId: p.categoryId,
    categoryName: p.categoryName,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.imageUrl,
    isPopular: p.isPopular,
    isAvailable: p.isAvailable,
    displayOrder: p.displayOrder,
    searchKeywords: p.searchKeywords,
  };
}

interface CategoryBody {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly displayOrder?: unknown;
}

interface ProductBody {
  readonly categoryId?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly price?: unknown;
  readonly imageUrl?: unknown;
  readonly isPopular?: unknown;
  readonly isAvailable?: unknown;
  readonly displayOrder?: unknown;
  readonly searchKeywords?: unknown;
}

interface BranchAvailabilityBody {
  readonly price?: unknown;
  readonly isAvailable?: unknown;
}

function optionalCategoryId(raw: unknown, seen: boolean): string | null | undefined {
  if (!seen) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) {
    throw Errors.validation("categoryId: se esperaba un id de categoría o null.");
  }
  return raw;
}

export function restaurantesAdminCatalogRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/categories/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/categories", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/products/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/products", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/v1/restaurantes/:propertyId/admin/categories", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const categories = await repo.listCategories(c.get("organizationId"));
    return c.json({ categories: categories.map(serializeCategory) });
  });

  app.post("/v1/restaurantes/:propertyId/admin/categories", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<CategoryBody>(c.req.raw, 8 * 1024);
    const name = requireNonEmptyString(raw.name, "name", 120);
    const slug = requireSlug(raw.slug);
    const displayOrder = optionalDisplayOrder(raw.displayOrder);
    const created = await repo.createCategory(c.get("organizationId"), { name, slug, ...(displayOrder !== undefined ? { displayOrder } : {}) });
    logEvent(c, "info", "restaurantes_admin_categoria_creada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), categoryId: created.id });
    return c.json({ category: serializeCategory(created) }, 201);
  });

  app.patch("/v1/restaurantes/:propertyId/admin/categories/:categoryId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<CategoryBody>(c.req.raw, 8 * 1024);
    const patch = {
      name: raw.name !== undefined ? requireNonEmptyString(raw.name, "name", 120) : undefined,
      slug: raw.slug !== undefined ? requireSlug(raw.slug) : undefined,
      displayOrder: optionalDisplayOrder(raw.displayOrder),
    };
    const updated = await repo.updateCategory(c.get("organizationId"), c.req.param("categoryId"), patch);
    if (!updated) throw Errors.notFound("Categoría no encontrada.");
    logEvent(c, "info", "restaurantes_admin_categoria_actualizada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), categoryId: updated.id });
    return c.json({ category: serializeCategory(updated) });
  });

  app.get("/v1/restaurantes/:propertyId/admin/products", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const products = await repo.listProducts(c.get("organizationId"));
    // Se anexa el estado real EN ESTA sucursal (precio/disponibilidad de
    // branch_products) a cada producto del catálogo — `null` cuando el producto
    // nunca se dio de alta ahí, nunca se asume un precio/disponibilidad implícitos.
    const withBranchState = await Promise.all(
      products.map(async (p) => ({ ...serializeProduct(p), branch: await repo.getBranchProductState(propertyId, p.id) })),
    );
    return c.json({ products: withBranchState });
  });

  app.post("/v1/restaurantes/:propertyId/admin/products", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<ProductBody>(c.req.raw, 16 * 1024);
    const name = requireNonEmptyString(raw.name, "name", 160);
    const price = requirePrice(raw.price);
    const description = optionalNullableString(raw.description, "description", 2000);
    const imageUrl = optionalNullableString(raw.imageUrl, "imageUrl", 2000);
    const categoryId = optionalCategoryId(raw.categoryId, raw.categoryId !== undefined);
    const isPopular = raw.isPopular === undefined ? undefined : Boolean(raw.isPopular);
    const isAvailable = raw.isAvailable === undefined ? undefined : Boolean(raw.isAvailable);
    const displayOrder = optionalDisplayOrder(raw.displayOrder);
    const searchKeywords = optionalSearchKeywords(raw.searchKeywords);

    const created = await repo.createProduct(c.get("organizationId"), {
      name,
      price,
      ...(description !== undefined ? { description } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(isPopular !== undefined ? { isPopular } : {}),
      ...(isAvailable !== undefined ? { isAvailable } : {}),
      ...(displayOrder !== undefined ? { displayOrder } : {}),
      ...(searchKeywords !== undefined ? { searchKeywords } : {}),
    });
    logEvent(c, "info", "restaurantes_admin_producto_creado", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), productId: created.id });
    return c.json({ product: { ...serializeProduct(created), branch: null } }, 201);
  });

  app.patch("/v1/restaurantes/:propertyId/admin/products/:productId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const productId = c.req.param("productId");
    const raw = await readJsonCapped<ProductBody>(c.req.raw, 16 * 1024);

    const patch = {
      name: raw.name !== undefined ? requireNonEmptyString(raw.name, "name", 160) : undefined,
      price: raw.price !== undefined ? requirePrice(raw.price) : undefined,
      description: optionalNullableString(raw.description, "description", 2000),
      imageUrl: optionalNullableString(raw.imageUrl, "imageUrl", 2000),
      categoryId: optionalCategoryId(raw.categoryId, raw.categoryId !== undefined),
      isPopular: raw.isPopular === undefined ? undefined : Boolean(raw.isPopular),
      isAvailable: raw.isAvailable === undefined ? undefined : Boolean(raw.isAvailable),
      displayOrder: optionalDisplayOrder(raw.displayOrder),
      searchKeywords: optionalSearchKeywords(raw.searchKeywords),
    };
    const updated = await repo.updateProduct(organizationId, productId, patch);
    if (!updated) throw Errors.notFound("Producto no encontrado.");
    logEvent(c, "info", "restaurantes_admin_producto_actualizado", { actorUserId: c.get("userId"), organizationId, productId: updated.id });
    const propertyId = c.req.param("propertyId");
    return c.json({ product: { ...serializeProduct(updated), branch: await repo.getBranchProductState(propertyId, updated.id) } });
  });

  // Alta/edición de precio+disponibilidad EN ESTA sucursal — la única forma real de
  // que un producto aparezca (o deje de aparecer) en búsqueda/cotización real (ver
  // product-search.ts::listAvailableProductsForBranch). Confirma primero que el
  // producto pertenece a esta organización — nunca se activa a ciegas un id ajeno.
  app.patch("/v1/restaurantes/:propertyId/admin/products/:productId/branch-availability", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const productId = c.req.param("productId");

    const product = await repo.findProduct(organizationId, productId);
    if (!product) throw Errors.notFound("Producto no encontrado.");

    const raw = await readJsonCapped<BranchAvailabilityBody>(c.req.raw, 4 * 1024);
    const existing = await repo.getBranchProductState(propertyId, productId);
    const price = raw.price !== undefined ? requirePrice(raw.price) : (existing?.price ?? product.price);
    const isAvailable = raw.isAvailable !== undefined ? Boolean(raw.isAvailable) : (existing?.isAvailable ?? true);

    const state = await repo.upsertBranchProductState(propertyId, productId, price, isAvailable);
    logEvent(c, "info", "restaurantes_admin_producto_disponibilidad_sucursal_actualizada", { actorUserId: c.get("userId"), organizationId, propertyId, productId, price, isAvailable });
    return c.json({ branch: state });
  });

  return app;
}
