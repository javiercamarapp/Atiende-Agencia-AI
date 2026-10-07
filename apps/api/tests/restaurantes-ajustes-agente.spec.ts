// Ajustes del agente por organizacion (migración 055) + conocimiento automatico + lado sistema del servicio de llamadas. Cada caso afirma el EFECTO
// (que se guardo, que NO se escribio, que se audito), no solo el status.
import { describe, expect, it } from "vitest";
import { AJUSTES_AGENTE_POR_DEFECTO, InMemoryAjustesAgenteRepository, MODELOS_AGENTE } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

async function construir(opts: { sinRepo?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const ajustes = new InMemoryAjustesAgenteRepository();
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { ajustesAgenteRepo: () => ajustes }) };
  return { ctx, ajustes, deps, app: envolver(buildApp(deps)), base: `/v1/restaurantes/${ctx.propertyIdA}/admin/agente` };
}

const OK = { ...AJUSTES_AGENTE_POR_DEFECTO, whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.3, vozTemperatura: 0.5, vozRitmo: "pausado", vozEstilo: "calido", vozFondoActivo: true, vozFondoVolumen: 10 };

describe("GET/PUT .../admin/agente/ajustes", () => {
  it("sin ajustes guardados: valores de siempre, lista permitida con costo estimado y los estados honestos", async () => {
    const { ctx, app, base } = await construir();
    const r = await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token))).json();
    expect(r).toMatchObject({ disponible: true, configurados: false, ajustes: { whatsappModelo: null, vozFondoActivo: false, vozRitmo: "normal" } });
    expect(r.modelos.map((m: { id: string }) => m.id)).toEqual(MODELOS_AGENTE.map((m) => m.id));
    const luna = r.modelos.find((m: { id: string }) => m.id === "openai/gpt-6-luna");
    expect(luna).toMatchObject({ predeterminado: true, aceptaTemperatura: false, costoWhatsappMicroUsdPorMensaje: 800 });
    expect(r.clonacionDeVoz).toMatchObject({ disponible: false });
    expect(r.documentosOmitidos.map((d: { tipo: string }) => d.tipo)).toEqual(["ventas", "personal"]);
    expect(r.aplicaEn.whatsappModeloYTemperatura).toBe("ahora");
    expect(r.aplicaEn.vozFondo).toMatch(/servicio de llamadas/);
    expect(r.supuestosCosto.nota).toMatch(/No es una factura/);
  });

  it("PUT guarda, se lee de vuelta y deja bitacora con el actor y solo ids/numeros (sin texto libre)", async () => {
    const { ctx, app, base, ajustes } = await construir();
    const put = await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, OK, "PUT"));
    expect(put.status).toBe(200);
    expect((await put.json()).ajustes).toMatchObject({ whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.3, vozFondoVolumen: 10 });
    expect(ajustes.escrituras).toHaveLength(1);
    expect(ajustes.escrituras[0]).toMatchObject({ organizationId: ctx.organizationId, actorUserId: ctx.staff.owner.id });
    const leido = await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.admin.token))).json();
    expect(leido).toMatchObject({ configurados: true, ajustes: { vozRitmo: "pausado", vozEstilo: "calido" } });

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.agente_ajustes_actualizados");
    expect(entrada).toMatchObject({ actorUserId: ctx.staff.owner.id, entityId: ctx.organizationId, antes: null });
    expect(JSON.parse(entrada!.despues!)).toMatchObject({ wa: ["google/gemini-2.5-flash-lite", 0.3], habla: ["pausado", "calido"], fondo: [true, 10] });

    await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...OK, whatsappModelo: "deepseek/deepseek-v4.1-flash" }, "PUT"));
    const segunda = ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.agente_ajustes_actualizados").at(-1)!;
    expect(JSON.parse(segunda.antes!).wa[0]).toBe("google/gemini-2.5-flash-lite");
    expect(JSON.parse(segunda.despues!).wa[0]).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("validacion: modelo fuera de la lista, temperatura a un modelo que no la admite, rangos, faltantes -> 400 y NADA se guarda", async () => {
    const { ctx, app, base, ajustes } = await construir();
    const casos: unknown[] = [
      {},
      { ...OK, whatsappModelo: "evil/modelo" },
      { ...OK, whatsappModelo: "anthropic/claude-sonnet-5.5", whatsappTemperatura: 0.2 },
      { ...OK, whatsappModelo: null, whatsappTemperatura: 0.2 }, // el predeterminado (Luna) no admite temperatura
      { ...OK, vozModeloCascada: "x/y" },
      { ...OK, vozTemperatura: 1.2 },
      { ...OK, vozRitmo: "rapidisimo" },
      { ...OK, vozFondoVolumen: 50 },
      { ...OK, vozFondoActivo: "si" },
    ];
    for (const body of casos) {
      const res = await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, body, "PUT"));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(ajustes.escrituras).toHaveLength(0);
    expect(ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.agente_ajustes_actualizados")).toHaveLength(0);
  });

  it("roles: staff y repartidor -> 403 (GET y PUT); owner de otra organizacion -> 403; sin sesion -> 401", async () => {
    const { ctx, app, base, ajustes } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base}/ajustes`, authedGet(token))).status).toBe(403);
      expect((await app.request(`${base}/ajustes`, authedJson(token, OK, "PUT"))).status).toBe(403);
    }
    expect((await app.request(`${base}/ajustes`)).status).toBe(401);
    expect(ajustes.escrituras).toHaveLength(0);
  });

  it("aislamiento entre organizaciones: guardar en una no cambia la otra", async () => {
    const { ctx, app, base } = await construir();
    await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, OK, "PUT"));
    const otra = await (await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/agente/ajustes`, authedGet(ctx.staff.otroOrgOwner.token))).json();
    expect(otra).toMatchObject({ configurados: false, ajustes: { whatsappModelo: null } });
  });

  it("base SIN migrar: GET 200 con disponible=false y los valores de siempre; PUT 503 (nunca 500) y no audita", async () => {
    const { ctx, app, base, ajustes } = await construir();
    ajustes.migrada = false;
    const get = await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ disponible: false, configurados: false, ajustes: { whatsappModelo: null } });
    const put = await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, OK, "PUT"));
    expect(put.status).toBe(503);
    expect(ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.agente_ajustes_actualizados")).toHaveLength(0);
  });

  it("la base niega la escritura (RLS): 403, sin bitacora; despliegue sin repositorio: 503", async () => {
    const { ctx, app, base, ajustes } = await construir();
    ajustes.rechazar = true;
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, OK, "PUT"))).status).toBe(403);
    expect(ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.agente_ajustes_actualizados")).toHaveLength(0);
    const sin = await construir({ sinRepo: true });
    expect((await sin.app.request(`${sin.base}/ajustes`, authedGet(sin.ctx.staff.owner.token))).status).toBe(503);
  });
});

describe("GET .../admin/agente/conocimiento (se genera de los datos, no se guarda)", () => {
  async function sembrar() {
    const t = await construir();
    const { ctx } = t;
    const repo = ctx.restaurantesRepo;
    await repo.upsertBranchPolicy(ctx.organizationId, ctx.propertyIdA, { horario: [{ dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "22:00" }], pedidoMinimoDomicilio: 150, pedidoMinimoRecoger: null, propinaPolitica: "nunca" });
    const cat = await repo.createCategory(ctx.organizationId, { name: "Tacos", slug: "tacos" });
    const p = await repo.createProduct(ctx.organizationId, { name: "Taco de pastor", price: 25, categoryId: cat.id, isAvailable: true });
    await repo.upsertBranchProductState(ctx.propertyIdA, p.id, 25, true);
    return { ...t, repo, producto: p };
  }

  it("genera los documentos con los datos vigentes, nunca texto a mano; cambiar un precio cambia el documento y la huella", async () => {
    const { ctx, app, base, repo, producto } = await sembrar();
    const a = await (await app.request(`${base}/conocimiento`, authedGet(ctx.staff.owner.token))).json();
    const doc = (r: { documentos: { tipo: string; contenido: string; vacio: boolean; enPrompt: boolean }[] }, tipo: string) => r.documentos.find((d) => d.tipo === tipo)!;
    expect(doc(a, "sucursales_horarios").contenido).toContain("lunes a viernes de 12:00 a 22:00");
    expect(doc(a, "sucursales_horarios").contenido).toContain("Pedido mínimo a domicilio: $150");
    expect(doc(a, "menu_precios").contenido).toContain("Taco de pastor");
    expect(doc(a, "menu_precios").contenido).toContain("$25");
    expect(doc(a, "menu_precios").enPrompt).toBe(true);
    expect(a.nota).toMatch(/No hay copia que se desactualice/);
    expect(a.prompt.topeCaracteres).toBe(6000);

    await repo.upsertBranchProductState(ctx.propertyIdA, producto.id, 30, true);
    const b = await (await app.request(`${base}/conocimiento`, authedGet(ctx.staff.owner.token))).json();
    expect(doc(b, "menu_precios").contenido).toContain("$30");
    expect(b.huella).not.toBe(a.huella);
  });

  it("solo owner/admin; otra organizacion no ve los datos de esta", async () => {
    const { ctx, app, base } = await sembrar();
    expect((await app.request(`${base}/conocimiento`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(`${base}/conocimiento`, authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(`${base}/conocimiento`)).status).toBe(401);
    const otra = await (await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/agente/conocimiento`, authedGet(ctx.staff.otroOrgOwner.token))).json();
    expect(otra.documentos.find((d: { tipo: string }) => d.tipo === "menu_precios").vacio).toBe(true);
    expect(JSON.stringify(otra)).not.toContain("Taco de pastor");
  });
});

describe("lado sistema: /internal/restaurantes/voz/ajustes-llamada", () => {
  const url = (org: string) => `/internal/restaurantes/voz/ajustes-llamada?organizationId=${org}`;

  it("sin secreto, con secreto equivocado o con JWT de staff: 401", async () => {
    const { ctx, app } = await construir();
    expect((await app.request(url(ctx.organizationId))).status).toBe(401);
    expect((await app.request(url(ctx.organizationId), { headers: { "x-atiende-internal-secret": "otro" } })).status).toBe(401);
    expect((await app.request(url(ctx.organizationId), authedGet(ctx.staff.owner.token))).status).toBe(401);
  });

  it("con el secreto: ajustes de la llamada (fondo apagado = volumen 0) y el bloque de conocimiento; organizationId invalido -> 400", async () => {
    const { ctx, app, deps, ajustes } = await construir();
    const headers = { "x-atiende-internal-secret": deps.env.internalSecret };
    const sin = await (await app.request(url(ctx.organizationId), { headers })).json();
    expect(sin).toMatchObject({ disponible: true, ajustes: { modeloCascada: null, temperatura: null, ritmo: "normal", fondo: { activo: false, volumen: 0 } } });
    expect(sin.conocimiento).toMatchObject({ incluidos: expect.any(Array) });

    await ajustes.guardar(ctx.organizationId, ctx.staff.owner.id, { ...AJUSTES_AGENTE_POR_DEFECTO, vozModeloCascada: "google/gemini-3.8-flash", vozTemperatura: 0.4, vozFondoActivo: true, vozFondoVolumen: 7, vozRitmo: "agil" });
    const con = await (await app.request(url(ctx.organizationId), { headers })).json();
    expect(con.ajustes).toMatchObject({ modeloCascada: "google/gemini-3.8-flash", temperatura: 0.4, ritmo: "agil", fondo: { activo: true, volumen: 7 } });
    expect((await app.request(url("no-es-uuid"), { headers })).status).toBe(400);
  });

  it("base sin migrar: 200 con los valores de siempre (el servicio de llamadas no se cae)", async () => {
    const { ctx, app, deps, ajustes } = await construir();
    ajustes.migrada = false;
    const r = await app.request(url(ctx.organizationId), { headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ disponible: false, ajustes: { fondo: { activo: false, volumen: 0 } } });
  });
});
