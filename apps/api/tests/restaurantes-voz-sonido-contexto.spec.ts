// Ambiente de restaurante, tecleo y naturalidad (migracion 087) en las rutas: el PUT/GET de ajustes y el contexto que recibe el worker. Doble en memoria, sin red.
import { describe, expect, it } from "vitest";
import { AJUSTES_AGENTE_POR_DEFECTO, InMemoryAjustesAgenteRepository, InMemoryVozLlamadaRepository, InMemoryVozKpiRepository, InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { BLOQUE_NATURALIDAD } from "@atiende/voice-core";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
const SECRETO = "test-internal-secret";

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const ajustes = new InMemoryAjustesAgenteRepository();
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  const deps: AppDeps = { ...ctx.deps, ajustesAgenteRepo: () => ajustes, vozRepo: () => voz, vozLlamadaRepo: () => new InMemoryVozLlamadaRepository(), vozKpiRepo: () => new InMemoryVozKpiRepository() };
  const real = buildApp(deps);
  const app = { request: (input: string, init?: RequestInit) => Promise.resolve(real.request(input, init)) as Promise<Resp> };
  const contexto = async (): Promise<Resp> => {
    const raw = JSON.stringify({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA });
    return Promise.resolve(real.request("/internal/restaurantes/voz/llamada/contexto", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": SECRETO } })) as Promise<Resp>;
  };
  return { ctx, ajustes, app, contexto, base: `/v1/restaurantes/${ctx.propertyIdA}/admin/agente` };
}

const PRESET = { ...AJUSTES_AGENTE_POR_DEFECTO, vozRitmo: "normal", vozEstilo: "calido", vozTemperatura: 0.4, vozFondoActivo: true, vozFondoVolumen: 7, vozFondoPreset: "cocina-taqueria", vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: true };

describe("ajustes: ambiente, tecleo y preset restaurante-humano", () => {
  it("GET expone el preset humano (voz femenina + 2 alternativas), los presets de ambiente y los limites; sin guardar, todo apagado", async () => {
    const { ctx, app, base } = await construir();
    const r = await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token))).json();
    expect(r).toMatchObject({ ambienteDisponible: true, ajustes: { vozTecleoActivo: false, vozHumanizar: false, vozFondoPreset: "cocina-taqueria", vozTecleoVolumen: 12 } });
    expect(r.fondo.presets.map((p: { id: string }) => p.id)).toEqual(["cocina-taqueria", "sala-tranquila", "calle-ocupada"]);
    expect(r.tecleo.volumenMax).toBe(25);
    expect(r.presetHumano).toMatchObject({ id: "restaurante-humano", ritmo: "normal", estilo: "calido", temperatura: 0.4, humanizar: true, fondo: { volumen: 8, preset: "cocina-taqueria" }, tecleo: { volumen: 12 } });
    expect(r.presetHumano.voz).toMatchObject({ principal: "Sulafat", alternativas: ["Callirrhoe", "Aoede"] });
    expect(r.presetHumano.vozPorMotor.cascada).toMatchObject({ proveedor: "deepgram-aura-2", principal: "aura-2-estrella-es" });
    expect(r.presetHumano.vozPorMotor["gemini-live"]).toMatchObject({ proveedor: "gemini", principal: "Sulafat" });
    expect(Object.keys(r.presetHumano.voz.descripciones)).toContain("Sulafat");
    expect(JSON.stringify(r.presetHumano.candidatasTtsCascadaV2)).toContain("aura-2-estrella-es");
    expect(r.aplicaEn.vozTecleo).toMatch(/no disponible aun en la vista previa/);
  });

  it("PUT guarda el preset completo, se lee de vuelta y la bitacora lleva solo ids y numeros", async () => {
    const { ctx, app, base, ajustes } = await construir();
    const put = await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, PRESET, "PUT"));
    expect(put.status).toBe(200);
    expect((await put.json()).ajustes).toMatchObject({ vozTecleoActivo: true, vozTecleoVolumen: 12, vozHumanizar: true, vozFondoPreset: "cocina-taqueria" });
    expect(ajustes.escrituras).toHaveLength(1);
    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.agente_ajustes_actualizados");
    expect(JSON.parse(entrada!.despues!)).toMatchObject({ tecleo: [true, 12], humanizar: true, fondo: [true, 7, "cocina-taqueria"] });
  });

  it("valores invalidos -> 400 y NADA se guarda (preset desconocido, tecleo > 25, tipos incorrectos)", async () => {
    const { ctx, app, base, ajustes } = await construir();
    for (const malo of [{ ...PRESET, vozFondoPreset: "discoteca" }, { ...PRESET, vozTecleoVolumen: 26 }, { ...PRESET, vozTecleoActivo: "si" }, { ...PRESET, vozHumanizar: 1 }, { ...PRESET, vozFondoPreset: null }]) {
      expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, malo, "PUT"))).status).toBe(400);
    }
    expect(ajustes.escrituras).toHaveLength(0);
  });

  it("un cliente que no manda los campos nuevos NO borra los vigentes", async () => {
    const { ctx, app, base } = await construir();
    await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, PRESET, "PUT"));
    const { vozFondoPreset: _a, vozTecleoActivo: _b, vozTecleoVolumen: _c, vozHumanizar: _d, ...viejo } = PRESET;
    const r = await (await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...viejo, vozFondoVolumen: 9 }, "PUT"))).json();
    expect(r.ajustes).toMatchObject({ vozFondoVolumen: 9, vozTecleoActivo: true, vozHumanizar: true });
  });

  it("base con la 055 pero sin la 087: GET avisa ambienteDisponible=false y PUT de lo nuevo responde 503 sin perder nada", async () => {
    const { ctx, app, base, ajustes } = await construir();
    ajustes.ambienteMigrado = false;
    expect((await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token))).json()).ambienteDisponible).toBe(false);
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, PRESET, "PUT"))).status).toBe(503);
    expect(ajustes.escrituras).toHaveLength(0);
  });

  it("staff (no owner/admin) no puede cambiar el preset: 403", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/ajustes`, authedJson(ctx.staff.staffSucursalA.token, PRESET, "PUT"))).status).toBe(403);
  });
});

describe("contexto de la llamada para el worker", () => {
  it("sin ajustes guardados: sonido apagado y la instruccion sin el bloque de naturalidad (como siempre)", async () => {
    const { contexto } = await construir();
    const body = await (await contexto()).json();
    expect(body.sonido).toEqual({ fondo: { activo: false, volumen: 0, preset: "cocina-taqueria" }, tecleo: { activo: false, volumen: 0 } });
    expect(body.instruccion).not.toContain(BLOQUE_NATURALIDAD);
    expect(body.temperatura).toBeNull();
  });

  it("con el preset guardado: sonido activo con preset y volumenes, y la instruccion lleva ritmo/estilo y la naturalidad al FINAL", async () => {
    const { ctx, app, base, contexto } = await construir();
    await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, PRESET, "PUT"));
    const body = await (await contexto()).json();
    expect(body.sonido).toEqual({ fondo: { activo: true, volumen: 7, preset: "cocina-taqueria" }, tecleo: { activo: true, volumen: 12 } });
    expect(body.instruccion).toContain("Tu voz es calida y cercana.");
    expect(body.instruccion.endsWith(BLOQUE_NATURALIDAD)).toBe(true);
    expect(body.temperatura).toBe(0.4);
  });

  it("una temperatura alta guardada antes (0.9) llega a la llamada como 0.4 y el panel conoce el tope", async () => {
    const { ctx, app, base, contexto } = await construir();
    await app.request(`${base}/ajustes`, authedJson(ctx.staff.owner.token, { ...PRESET, vozTemperatura: 0.9 }, "PUT"));
    expect((await (await contexto()).json()).temperatura).toBe(0.4);
    const r = await (await app.request(`${base}/ajustes`, authedGet(ctx.staff.owner.token))).json();
    expect(r.ajustes.vozTemperatura).toBe(0.9); // lo guardado no se toca
    expect(r.temperatura.maxLlamada).toBe(0.4);
  });

  it("si la lectura de ajustes lanza un error cualquiera, la llamada NO se cae: 200 con los valores de siempre", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const voz = new InMemoryVozRepository();
    voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
    const roto = { leer: async () => { throw Object.assign(new Error("connection reset"), { code: "08006" }); }, guardar: async () => { throw new Error("no"); } };
    const app = buildApp({ ...ctx.deps, ajustesAgenteRepo: () => roto, vozRepo: () => voz, vozLlamadaRepo: () => new InMemoryVozLlamadaRepository(), vozKpiRepo: () => new InMemoryVozKpiRepository() });
    const raw = JSON.stringify({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA });
    const res = await app.request("/internal/restaurantes/voz/llamada/contexto", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": SECRETO } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sonido: { tecleo: { activo: boolean } }; temperatura: number | null; instruccion: string };
    expect(body.sonido.tecleo.activo).toBe(false);
    expect(body.temperatura).toBeNull();
    expect(body.instruccion).not.toContain(BLOQUE_NATURALIDAD);
  });

  it("base sin migrar (ajustes no disponibles): el contexto sigue funcionando con los valores de siempre", async () => {
    const { ajustes, contexto } = await construir();
    ajustes.migrada = false;
    const res = await contexto();
    expect(res.status).toBe(200);
    expect((await res.json()).sonido.tecleo.activo).toBe(false);
  });
});
