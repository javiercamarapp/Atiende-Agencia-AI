// Regresion QA-restaurantes-R1-viaje-08 (capa HTTP): el worker de la llamada informa el turno del cliente en `x-atiende-call-turn`
// (nunca el modelo). Con el mismo turno en cotizar y confirmar, la API rechaza la confirmacion; con un turno posterior la acepta; sin la
// cabecera (worker anterior) se conserva el comportamiento previo.
import { describe, expect, it } from "vitest";
import { crearEjecutorTools, transporteHttp } from "@atiende/domain-restaurantes";
import { CABECERA_TURNO_LLAMADA } from "@atiende/voice-core";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };

async function montar() {
  const base = await buildTestDeps();
  const app = buildApp(base.deps);
  const mint = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: `turno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, caller_phone: "9993334444", branch_slug: "fco-montejo" }, LEGACY));
  const token = ((await mint.json()) as { call_token: string }).call_token;
  const items = [{ product_id: base.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const llamar = async (ruta: string, cuerpo: unknown, turno: string | null) =>
    app.request(`/v1/restaurantes/${ORG}${ruta}`, jsonRequestInit(cuerpo, { "x-atiende-call-token": token, ...(turno !== null ? { [CABECERA_TURNO_LLAMADA]: turno } : {}) }));
  const cotizar = async (turno: string | null) => ((await (await llamar("/orders/quote", { branch_slug: "fco-montejo", items, canal: "recoger" }, turno)).json()) as { quote_hash: string }).quote_hash;
  return { app, token, items, llamar, cotizar };
}

describe("turno del cliente por cabecera (voz)", () => {
  it("la cabecera es la de voice-core", () => {
    expect(CABECERA_TURNO_LLAMADA).toBe("x-atiende-call-turn");
  });

  it("mismo turno en cotizar y confirmar: 400 confirmacion_mismo_turno; un turno posterior: 200", async () => {
    const t = await montar();
    const hash = await t.cotizar("1");
    const mismo = await t.llamar("/orders/confirm", { quote_hash: hash }, "1");
    expect(mismo.status).toBe(400);
    expect(((await mismo.json()) as { message: string }).message).toMatch(/todavía no contestó/);
    const despues = await t.llamar("/orders/confirm", { quote_hash: hash }, "2");
    expect(despues.status).toBe(200);
  });

  it("sin cabecera (worker anterior) o con valor invalido se conserva el comportamiento previo (no se exige turno)", async () => {
    const t = await montar();
    const hash = await t.cotizar(null);
    expect((await t.llamar("/orders/confirm", { quote_hash: hash }, null)).status).toBe(200);
    const t2 = await montar();
    const hash2 = await t2.cotizar("abc");
    expect((await t2.llamar("/orders/confirm", { quote_hash: hash2 }, "abc")).status).toBe(200);
  });

  it("el transporte HTTP del ejecutor manda el turno que le da el controlador", async () => {
    const visto: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      visto.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ejecutor = crearEjecutorTools({ transporte: transporteHttp({ baseUrl: "http://api.local", orgSlug: ORG, callToken: "t", fetchFn }), timeoutMs: 1000 });
    await ejecutor.ejecutar("consultar_sucursal", { branch_slug: "x" }, { turno: 3 });
    await ejecutor.ejecutar("consultar_sucursal", { branch_slug: "x" });
    expect(visto[0]![CABECERA_TURNO_LLAMADA]).toBe("3");
    expect(visto[1]![CABECERA_TURNO_LLAMADA]).toBeUndefined();
  });
});
