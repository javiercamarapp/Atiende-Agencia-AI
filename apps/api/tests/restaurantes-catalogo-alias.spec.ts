// import-orig-14 — alias o palabras clave de un producto, mantenidos desde el panel (PATCH admin/products/:id).
// Los alias eran un seed estático que un desarrollador cargaba a mano; ahora el dueño los corrige. Aquí se prueba, sobre la
// ruta HTTP real y el repositorio en memoria, que (1) el PATCH guarda los alias normalizados (minúsculas, sin acentos, sin
// duplicados), (2) un alias guardado hace que `buscar_producto` (la herramienta del agente) encuentre el producto y quitarlo
// lo vuelve a esconder, y (3) los permisos por rol del PATCH son los del catálogo (owner/admin sí; staff y repartidor no).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };

type Ctx = Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>;
type App = ReturnType<typeof buildApp>;

async function crearProductoActivo(app: App, ctx: Ctx, name: string): Promise<string> {
  const creado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name, price: 30 }));
  expect(creado.status).toBe(201);
  const { product } = (await creado.json()) as { product: { id: string } };
  const activado = await app.request(
    `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${product.id}/branch-availability`,
    authedJson(ctx.staff.owner.token, { price: 30, isAvailable: true }, "PATCH"),
  );
  expect(activado.status).toBe(200);
  return product.id;
}

async function buscar(app: App, query: string): Promise<string[]> {
  const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query, branch_slug: "fco-montejo" }, TOOL_SECRET_HEADERS));
  expect(res.status).toBe(200);
  return ((await res.json()) as { productos: Array<{ name: string }> }).productos.map((p) => p.name);
}

function patchAlias(app: App, ctx: Ctx, token: string, productId: string, body: unknown) {
  return app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(token, body, "PATCH"));
}

describe("alias de producto — PATCH admin/products/:productId y buscar_producto", () => {
  it("un alias guardado hace que buscar_producto encuentre el producto; quitarlo lo esconde de nuevo", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");

    expect(await buscar(app, "flautas")).toEqual([]);

    const guardado = await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["flautas"] });
    expect(guardado.status).toBe(200);
    expect(((await guardado.json()) as { product: { searchKeywords: string[] } }).product.searchKeywords).toEqual(["flautas"]);
    expect(await buscar(app, "flautas")).toEqual(["Taco dorado de papa"]);

    const limpiado = await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: [] });
    expect(limpiado.status).toBe(200);
    expect(((await limpiado.json()) as { product: { searchKeywords: string[] } }).product.searchKeywords).toEqual([]);
    expect(await buscar(app, "flautas")).toEqual([]);
  });

  it("normaliza: minúsculas, sin acentos, espacios colapsados y sin duplicados", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");

    const res = await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["Flautas", "  flautas ", "Frijólito  Charro", "   "] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { product: { searchKeywords: string[] } }).product.searchKeywords).toEqual(["flautas", "frijolito charro"]);
    // El cliente escribe con acento y mayúsculas: sigue encontrando el producto.
    expect(await buscar(app, "FLAUTAS")).toEqual(["Taco dorado de papa"]);
  });

  it("rechaza alias con símbolos, demasiados o demasiado largos (400) y no toca los guardados", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");
    expect((await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["flautas"] })).status).toBe(200);

    expect((await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["<script>"] })).status).toBe(400);
    expect((await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["x".repeat(61)] })).status).toBe(400);
    expect((await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: Array.from({ length: 31 }, (_, i) => `alias${i}`) })).status).toBe(400);
    expect((await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: "flautas" })).status).toBe(400);
    expect(await buscar(app, "flautas")).toEqual(["Taco dorado de papa"]);
  });

  it("editar nombre y descripción sin mandar alias conserva los alias; desactivar el producto lo saca de la búsqueda", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");
    await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["flautas"] });

    const editado = await patchAlias(app, ctx, ctx.staff.admin.token, id, { name: "Flauta de papa", description: "Tres flautas crujientes" });
    expect(editado.status).toBe(200);
    const body = (await editado.json()) as { product: { name: string; description: string; searchKeywords: string[] } };
    expect(body.product).toMatchObject({ name: "Flauta de papa", description: "Tres flautas crujientes", searchKeywords: ["flautas"] });

    // «Desactivar en lugar de borrar»: el interruptor de la sucursal deja de ofrecerlo al agente.
    const apagado = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${id}/branch-availability`,
      authedJson(ctx.staff.admin.token, { isAvailable: false }, "PATCH"),
    );
    expect(apagado.status).toBe(200);
    expect(await buscar(app, "flautas")).toEqual([]);
  });

  it("permisos: owner y admin editan; staff, repartidor y otra organización no (403/404) y nada cambia", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");

    expect((await patchAlias(app, ctx, ctx.staff.staffSucursalA.token, id, { searchKeywords: ["intruso"] })).status).toBe(403);
    expect((await patchAlias(app, ctx, ctx.staff.repartidor.token, id, { searchKeywords: ["intruso"] })).status).toBe(403);
    expect((await patchAlias(app, ctx, ctx.staff.otroOrgOwner.token, id, { searchKeywords: ["intruso"] })).status).toBeGreaterThanOrEqual(403);
    expect(await buscar(app, "intruso")).toEqual([]);

    expect((await patchAlias(app, ctx, ctx.staff.admin.token, id, { searchKeywords: ["flautas"] })).status).toBe(200);
    expect(await buscar(app, "flautas")).toEqual(["Taco dorado de papa"]);
  });

  it("producto inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await patchAlias(app, ctx, ctx.staff.owner.token, "00000000-0000-4000-8000-000000000000", { searchKeywords: ["flautas"] });
    expect(res.status).toBe(404);
  });
});

describe("agotado «solo por hoy» (autopiloto, migración 050) y «Dejar de venderlo»", () => {
  async function productoAgotado(app: App, ctx: Ctx) {
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");
    await patchAlias(app, ctx, ctx.staff.owner.token, id, { searchKeywords: ["flautas"] });
    // Lo que deja `agotado_marcar`: apagado + reposición programada.
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${id}/branch-availability`, authedJson(ctx.staff.owner.token, { isAvailable: false }, "PATCH"));
    ctx.restaurantesRepo.marcarAgotadoHastaParaPruebas(ctx.propertyIdA, id, "2026-10-08");
    return id;
  }
  const listar = async (app: App, ctx: Ctx) => {
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    return ((await res.json()) as { products: Array<{ id: string; branch: { isAvailable: boolean; agotadoHasta?: string | null } | null }> }).products;
  };

  it("el listado del panel expone branch.agotadoHasta", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await productoAgotado(app, ctx);
    expect((await listar(app, ctx)).find((p) => p.id === id)!.branch).toMatchObject({ isAvailable: false, agotadoHasta: "2026-10-08" });
  });

  it("sin «Dejar de venderlo», el cron de reposición lo vuelve a poner a la venta (control)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await productoAgotado(app, ctx);
    expect(ctx.restaurantesRepo.reponerAgotadosVencidos("2026-10-09")).toEqual([{ propertyId: ctx.propertyIdA, productId: id }]);
    expect(await buscar(app, "flautas")).toEqual(["Taco dorado de papa"]);
  });

  it("owner/admin mandan isAvailable:false a propósito: se cancela la reposición y el cron NO lo reactiva", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await productoAgotado(app, ctx);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${id}/branch-availability`, authedJson(ctx.staff.admin.token, { isAvailable: false }, "PATCH"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: { isAvailable: boolean; agotadoHasta: string | null } }).branch).toMatchObject({ isAvailable: false, agotadoHasta: null });
    expect((await listar(app, ctx)).find((p) => p.id === id)!.branch).toMatchObject({ isAvailable: false, agotadoHasta: null });
    expect(ctx.restaurantesRepo.reponerAgotadosVencidos("2026-12-31")).toEqual([]);
    expect(await buscar(app, "flautas")).toEqual([]);
  });

  it("mandar solo precio (sin isAvailable) no cancela la reposición programada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await productoAgotado(app, ctx);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${id}/branch-availability`, authedJson(ctx.staff.admin.token, { price: 35 }, "PATCH"));
    expect((await listar(app, ctx)).find((p) => p.id === id)!.branch).toMatchObject({ agotadoHasta: "2026-10-08" });
  });

  it("base sin la 050: un producto sin agotadoHasta funciona igual (no falla ni inventa el dato)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await crearProductoActivo(app, ctx, "Taco dorado de papa");
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${id}/branch-availability`, authedJson(ctx.staff.owner.token, { isAvailable: false }, "PATCH"));
    expect(res.status).toBe(200);
    expect((await listar(app, ctx)).find((p) => p.id === id)!.branch!.agotadoHasta ?? null).toBeNull();
  });
});
