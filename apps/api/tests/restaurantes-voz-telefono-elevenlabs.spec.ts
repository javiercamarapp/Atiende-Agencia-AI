// Stack ElevenLabs en las rutas de voz: voz telefonica por sucursal (migracion 103) en el panel, y lo que el contexto de la llamada le da al worker
// (keyterms del menu, voz telefonica y modelo de los ajustes). Dobles en memoria, sin red.
import { describe, expect, it } from "vitest";
import { AJUSTES_AGENTE_POR_DEFECTO, InMemoryAjustesAgenteRepository, InMemoryVozKpiRepository, InMemoryVozLlamadaRepository, InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
const SECRETO = "test-internal-secret";
const REGINA = "9Godp7dNohUvXk6qp0gS";
const ALEJANDRO = "sDh3eviBhiuHKi0MjTNq";

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  const ajustes = new InMemoryAjustesAgenteRepository();
  const deps: AppDeps = { ...ctx.deps, ajustesAgenteRepo: () => ajustes, vozRepo: () => voz, vozLlamadaRepo: () => new InMemoryVozLlamadaRepository(), vozKpiRepo: () => new InMemoryVozKpiRepository() };
  const real = buildApp(deps);
  const app = { request: (input: string, init?: RequestInit) => Promise.resolve(real.request(input, init)) as Promise<Resp> };
  const contexto = async (): Promise<Resp> => {
    const raw = JSON.stringify({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA });
    return Promise.resolve(real.request("/internal/restaurantes/voz/llamada/contexto", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": SECRETO } })) as Promise<Resp>;
  };
  return { ctx, voz, ajustes, app, contexto, base: `/v1/restaurantes/${ctx.propertyIdA}/admin/voz` };
}

const CONFIG = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "Le atiende el asistente virtual." };

describe("voz telefonica (ElevenLabs) en el panel", () => {
  it("el catalogo trae las voces telefonicas (Regina primero, la de la plataforma)", async () => {
    const { ctx, app, base } = await construir();
    const r = await (await app.request(`${base}/catalogo`, authedGet(ctx.staff.owner.token))).json();
    expect(r.vocesTelefono[0]).toMatchObject({ id: REGINA, nombre: "Regina" });
    expect(r.vocesTelefono.map((v: { id: string }) => v.id)).toContain(ALEJANDRO);
  });

  it("PUT guarda la voz telefonica, GET la devuelve y la bitacora la registra; null vuelve a la de la plataforma", async () => {
    const { ctx, app, base } = await construir();
    const put = await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: ALEJANDRO }, "PUT"));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ vozTelefono: ALEJANDRO, vozTelefonoDisponible: true });
    expect(await (await app.request(`${base}/config`, authedGet(ctx.staff.owner.token))).json()).toMatchObject({ vozTelefono: ALEJANDRO, vozTelefonoDisponible: true });
    const entrada = ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.voz_actualizada").at(-1);
    expect(JSON.parse(entrada!.despues!)).toMatchObject({ vozTelefono: ALEJANDRO });
    await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: null }, "PUT"));
    expect((await (await app.request(`${base}/config`, authedGet(ctx.staff.owner.token))).json()).vozTelefono).toBeNull();
  });

  it("un cliente que no manda vozTelefono NO la borra", async () => {
    const { ctx, app, base } = await construir();
    await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: ALEJANDRO }, "PUT"));
    await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, mensajeInicial: "Hola, le atiende el asistente virtual." }, "PUT"));
    expect((await (await app.request(`${base}/config`, authedGet(ctx.staff.owner.token))).json()).vozTelefono).toBe(ALEJANDRO);
  });

  it("una voz fuera del catalogo (Aura-2, Gemini o texto libre) -> 400", async () => {
    const { ctx, app, base } = await construir();
    for (const malo of ["aura-2-estrella-es", "Kore", "x".repeat(20), 7]) {
      expect((await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: malo }, "PUT"))).status).toBe(400);
    }
  });

  it("staff (rol insuficiente) no la cambia", async () => {
    const { ctx, app, base } = await construir();
    const r = await app.request(`${base}/config`, authedJson(ctx.staff.staffSucursalA.token, { ...CONFIG, vozTelefono: ALEJANDRO }, "PUT"));
    expect(r.status).toBe(403);
  });

  it("base sin la 103: GET avisa vozTelefonoDisponible=false y un PUT que la manda responde 503 (nunca guarda a medias)", async () => {
    const { ctx, app, base, voz } = await construir();
    voz.migradaVozTelefono = false;
    expect(await (await app.request(`${base}/config`, authedGet(ctx.staff.owner.token))).json()).toMatchObject({ vozTelefono: null, vozTelefonoDisponible: false });
    expect((await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: ALEJANDRO }, "PUT"))).status).toBe(503);
    // Sin el campo, el guardado de siempre sigue funcionando.
    expect((await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, CONFIG, "PUT"))).status).toBe(200);
  });
});

describe("contexto de la llamada para la cascada v2", () => {
  it("trae los nombres del menu disponible (sin repetir, solo disponibles) como vocabulario, la voz telefonica y el modelo de los ajustes", async () => {
    const { ctx, app, base, contexto, ajustes } = await construir();
    const repo = ctx.restaurantesRepo;
    repo.seedProduct({ id: "p1", organizationId: ctx.organizationId, categoryId: null, name: "Cochinita pibil", description: null, searchKeywords: [] });
    repo.seedProduct({ id: "p2", organizationId: ctx.organizationId, categoryId: null, name: "Panuchos", description: null, searchKeywords: [] });
    repo.seedProduct({ id: "p3", organizationId: ctx.organizationId, categoryId: null, name: "Relleno negro", description: null, searchKeywords: [] });
    repo.seedBranchProduct({ propertyId: ctx.propertyIdA, productId: "p1", price: 80, isAvailable: true });
    repo.seedBranchProduct({ propertyId: ctx.propertyIdA, productId: "p2", price: 30, isAvailable: true });
    repo.seedBranchProduct({ propertyId: ctx.propertyIdA, productId: "p3", price: 90, isAvailable: false });
    await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG, vozTelefono: ALEJANDRO }, "PUT"));
    await ajustes.guardar(ctx.organizationId, ctx.staff.owner.id, { ...(await ajustes.leer(ctx.organizationId)).valor, vozModeloCascada: "openai/gpt-6-luna" });
    const r = await contexto();
    expect(r.status).toBe(200);
    const c = await r.json();
    expect(c.vocabulario).toEqual(["Cochinita pibil", "Panuchos"]);
    expect(c.vozTelefono).toBe(ALEJANDRO);
    expect(c.modeloVoz).toBe("openai/gpt-6-luna");
  });

  it("un modelo guardado SIN endpoint de retencion cero (p. ej. un valor viejo) NO llega a la llamada: modeloVoz null (el worker usa el de la plataforma)", async () => {
    const { ctx, contexto, ajustes } = await construir();
    for (const sinZdr of ["meta/muse-spark-1.3", "google/gemini-2.5-flash-lite", "deepseek/deepseek-v4.1-flash"]) {
      await ajustes.guardar(ctx.organizationId, ctx.staff.owner.id, { ...(await ajustes.leer(ctx.organizationId)).valor, vozModeloCascada: sinZdr });
      expect((await (await contexto()).json()).modeloVoz).toBeNull();
    }
  });

  it("el panel ya no deja guardar para la voz un modelo sin retencion cero (400) y marca cada modelo con vozZdr", async () => {
    const { ctx, app } = await construir();
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/agente`;
    const vista = await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token))).json();
    const porId = Object.fromEntries(vista.modelos.map((m: { id: string; vozZdr: boolean }) => [m.id, m.vozZdr]));
    // DeepSeek V4.1 Flash tiene ZDR solo en DeepInfra/Together/Fireworks/Baseten/Parasail/CoreWeave, fuera de los proveedores de voz (Vertex/Bedrock/Azure).
    expect(porId).toEqual({ "openai/gpt-6-luna": true, "anthropic/claude-haiku-5.5": true, "deepseek/deepseek-v4.1-flash": false, "google/gemini-3.5-flash-lite": true });
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...AJUSTES_AGENTE_POR_DEFECTO, vozModeloCascada: "deepseek/deepseek-v4.1-flash" }, "PUT"))).status).toBe(400);
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...AJUSTES_AGENTE_POR_DEFECTO, vozModeloCascada: "meta/muse-spark-1.3" }, "PUT"))).status).toBe(400);
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...AJUSTES_AGENTE_POR_DEFECTO, vozModeloCascada: "openai/gpt-6-luna" }, "PUT"))).status).toBe(200);
  });

  it("si leer el menu falla, la llamada NO se cae: vocabulario vacio; sin voz ni modelo guardados, null", async () => {
    const { ctx, contexto } = await construir();
    ctx.restaurantesRepo.listAvailableProductsForBranch = () => Promise.reject(new Error("caida"));
    const c = await (await contexto()).json();
    expect(c).toMatchObject({ vocabulario: [], vozTelefono: null, modeloVoz: null });
  });
});
