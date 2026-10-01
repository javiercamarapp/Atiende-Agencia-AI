// L-08 -- KYC negativo 69-B de licitaciones, HTTP real (Hono + auth + roles) sobre el repositorio en
// memoria (mismas reglas que la base: bitacora por organizacion, topes) y un fixture LOCAL de la lista
// (nada se descarga). El aislamiento real por RLS/definer se prueba contra Postgres real en
// scripts/verify-licitaciones-kyc-69b/. Cubre: consulta de un RFC y de un lote, las 4 situaciones con su
// fecha, RFC invalido, lote excesivo, roles, cross-tenant de la bitacora, alerta de proveedor propio y la
// degradacion a "no disponible aun" (migracion 031 pendiente).
import { InMemoryKyc69bRepository, KycNotAvailableError } from "@atiende/domain-licitaciones";
import type { Kyc69bRepository, KycListaFixture } from "@atiende/domain-licitaciones";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const LISTA: KycListaFixture = {
  periodo: "2024-06",
  filas: [
    { rfc: "PRE850101AB1", nombre: "PRESUNTA SA", situacion: "presunto", fechaPresuncionSat: "2024-05-12" },
    { rfc: "DEF900202CD2", situacion: "definitivo", fechaDefinitivoSat: "2024-06-03" },
    { rfc: "DES800303EF3", situacion: "desvirtuado", fechaDesvirtuadoSat: "2024-04-20" },
    { rfc: "SEN700404GH4", situacion: "sentencia_favorable", fechaSentenciaFavorableSat: "2024-05-30" },
  ],
};

async function setup(opts: { repo?: Kyc69bRepository | null } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const kyc = opts.repo === undefined ? new InMemoryKyc69bRepository(LISTA) : opts.repo;
  const deps: AppDeps = { ...ctx.deps, ...(kyc ? { licitacionesKycRepo: () => kyc } : {}) };
  const app = buildApp(deps);
  const base = `/licitaciones/${ctx.propertyId}/kyc-69b`;

  async function call(method: string, path: string, who: keyof typeof ctx.staff, body?: unknown): Promise<{ status: number; json: Json }> {
    const init: RequestInit = body === undefined ? { method, headers: { authorization: `Bearer ${ctx.staff[who].token}` } } : { ...authedJson(ctx.staff[who].token, body), method };
    const res = await app.request(`${base}${path}`, init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  return { ctx, kyc, call, app };
}

describe("KYC 69-B de licitaciones (HTTP)", () => {
  it("consulta un RFC: situacion, fecha de publicacion y semaforo", async () => {
    const { call } = await setup();
    const r = await call("POST", "/consultar", "writer", { rfcs: ["pre850101ab1"] });
    expect(r.status).toBe(200);
    expect(r.json.listaDisponible).toBe(true);
    expect(r.json.periodo).toBe("2024-06");
    expect(r.json.filas[0]).toMatchObject({ rfc: "PRE850101AB1", situacion: "presunto", fechaPublicacion: "2024-05-12", semaforo: "ambar" });
  });

  it("consulta un lote con las 4 situaciones y un RFC que no aparece", async () => {
    const { call } = await setup();
    const r = await call("POST", "/consultar", "analyst", { rfcs: ["PRE850101AB1", "DEF900202CD2", "DES800303EF3", "SEN700404GH4", "LIM750505IJ5"] });
    expect(r.status).toBe(200);
    expect(r.json.filas.map((f: Json) => [f.rfc, f.semaforo])).toEqual([
      ["PRE850101AB1", "ambar"],
      ["DEF900202CD2", "rojo"],
      ["DES800303EF3", "verde"],
      ["SEN700404GH4", "verde"],
      ["LIM750505IJ5", "verde"],
    ]);
    expect(r.json.filas[4].encontrado).toBe(false);
  });

  it("RFC invalido -> 400 con el RFC senalado; el lote entero se rechaza", async () => {
    const { call } = await setup();
    for (const rfcs of [["xx"], ["PRE850101AB1", "PRE851301AB1"], ["XAXX010101000"], [""], [123], "PRE850101AB1", [], undefined]) {
      const r = await call("POST", "/consultar", "writer", { rfcs });
      expect(r.status, JSON.stringify(rfcs)).toBe(400);
    }
  });

  it("lote excesivo (51) -> 400; 50 pasan", async () => {
    const { call } = await setup();
    const lote = (n: number) => Array.from({ length: n }, (_, i) => `ZZZ010101${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}1`);
    expect((await call("POST", "/consultar", "writer", { rfcs: lote(51) })).status).toBe(400);
    expect((await call("POST", "/consultar", "writer", { rfcs: lote(50) })).status).toBe(200);
  });

  it("cuerpo demasiado grande -> 413 (no se parsea)", async () => {
    const { call } = await setup();
    const r = await call("POST", "/consultar", "writer", { rfcs: ["PRE850101AB1"], relleno: "x".repeat(20_000) });
    expect(r.status).toBe(413);
  });

  it("viewer NO puede consultar ni crear fichas (403); si puede leer fichas", async () => {
    const { call } = await setup();
    expect((await call("POST", "/consultar", "viewer", { rfcs: ["PRE850101AB1"] })).status).toBe(403);
    expect((await call("POST", "/fichas", "viewer", { rfc: "PRE850101AB1", rol: "proveedor" })).status).toBe(403);
    expect((await call("GET", "", "viewer")).status).toBe(200);
  });

  it("sin token -> 401", async () => {
    const { app, ctx } = await setup();
    const res = await app.request(`/licitaciones/${ctx.propertyId}/kyc-69b`);
    expect(res.status).toBe(401);
  });

  it("fichas: alta, duplicado (400), alerta de proveedor propio, competidor sin alerta y borrado", async () => {
    const { call } = await setup();
    const alta = await call("POST", "/fichas", "writer", { rfc: "pre850101ab1", rol: "proveedor", nombre: "  Mi   proveedor " });
    expect(alta.status).toBe(201);
    expect((await call("POST", "/fichas", "writer", { rfc: "PRE850101AB1", rol: "proveedor" })).status).toBe(400);
    expect((await call("POST", "/fichas", "writer", { rfc: "DEF900202CD2", rol: "competidor", nombre: "Rival" })).status).toBe(201);
    expect((await call("POST", "/fichas", "writer", { rfc: "DES800303EF3", rol: "proveedor" })).status).toBe(201);
    expect((await call("POST", "/fichas", "writer", { rfc: "PRE850101AB1", rol: "cliente" })).status).toBe(400);
    expect((await call("POST", "/fichas", "writer", { rfc: "malo", rol: "proveedor" })).status).toBe(400);

    const lista = await call("GET", "", "viewer");
    expect(lista.json.available).toBe(true);
    expect(lista.json.lista).toMatchObject({ periodo: "2024-06" });
    expect(lista.json.fichas).toHaveLength(3);
    expect(lista.json.fichas.find((f: Json) => f.rfc === "PRE850101AB1").nombre).toBe("Mi proveedor");
    expect(lista.json.alertas.map((a: Json) => a.rfc)).toEqual(["PRE850101AB1"]); // el competidor definitivo y el desvirtuado NO alertan

    expect((await call("DELETE", `/fichas/${alta.json.id}`, "writer")).status).toBe(200);
    expect((await call("DELETE", `/fichas/${alta.json.id}`, "writer")).status).toBe(404);
    expect((await call("DELETE", "/fichas/no-es-uuid", "writer")).status).toBe(400);
    expect((await call("DELETE", `/fichas/${alta.json.id}`, "viewer")).status).toBe(403);
    expect((await call("GET", "", "viewer")).json.alertas).toEqual([]);
  });

  it("bitacora: la ven los roles de decision (no writer/viewer) y solo contiene consultas de SU organizacion", async () => {
    const kyc = new InMemoryKyc69bRepository(LISTA);
    const a = await setup({ repo: kyc });
    const b = await setup({ repo: kyc }); // otro tenant, mismo repositorio en memoria
    expect(a.ctx.organizationId).not.toBe(b.ctx.organizationId);
    await a.call("POST", "/consultar", "writer", { rfcs: ["PRE850101AB1", "LIM750505IJ5"] });
    await b.call("POST", "/consultar", "owner", { rfcs: ["DEF900202CD2"] });

    expect((await a.call("GET", "/consultas", "writer")).status).toBe(403);
    expect((await a.call("GET", "/consultas", "viewer")).status).toBe(403);
    const ba = await a.call("GET", "/consultas", "owner");
    const bb = await b.call("GET", "/consultas", "owner");
    expect(ba.status).toBe(200);
    expect(ba.json.consultas.map((x: Json) => x.rfc).sort()).toEqual(["LIM750505IJ5", "PRE850101AB1"]);
    expect(bb.json.consultas.map((x: Json) => x.rfc)).toEqual(["DEF900202CD2"]);
  });

  it("tope diario por organizacion -> 429 con mensaje claro", async () => {
    const kyc = new InMemoryKyc69bRepository(LISTA);
    const { call } = await setup({ repo: kyc });
    // 20 lotes de 50 = 1000 RFC (la API limita a 20 consultas/min por usuario): el siguiente rebasa el tope diario.
    const lote = (pre: string) => Array.from({ length: 50 }, (_, i) => `${pre}010101${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}1`);
    for (let k = 0; k < 20; k++) {
      const r = await call("POST", "/consultar", "writer", { rfcs: lote(`Z${String.fromCharCode(65 + k)}Z`) });
      expect(r.status).toBe(200);
    }
    const over = await call("POST", "/consultar", "owner", { rfcs: ["PRE850101AB1"] });
    expect(over.status).toBe(429);
    expect(over.json.error?.message ?? over.json.message ?? JSON.stringify(over.json)).toMatch(/tope diario/i);
  });

  it("migracion 031 pendiente: lecturas 'available: false', escrituras 503, nunca 500", async () => {
    const pendiente: Kyc69bRepository = {
      consultar: async () => { throw new KycNotAvailableError(); },
      estadoLista: async () => { throw new KycNotAvailableError(); },
      listFichas: async () => { throw new KycNotAvailableError(); },
      addFicha: async () => { throw new KycNotAvailableError(); },
      removeFicha: async () => { throw new KycNotAvailableError(); },
      listConsultas: async () => { throw new KycNotAvailableError(); },
    };
    const { call } = await setup({ repo: pendiente });
    const lectura = await call("GET", "", "owner");
    expect(lectura.status).toBe(200);
    expect(lectura.json).toMatchObject({ available: false, fichas: [], alertas: [] });
    expect((await call("GET", "/consultas", "owner")).json).toMatchObject({ available: false, consultas: [] });
    expect((await call("POST", "/consultar", "writer", { rfcs: ["PRE850101AB1"] })).status).toBe(503);
    expect((await call("POST", "/fichas", "writer", { rfc: "PRE850101AB1", rol: "proveedor" })).status).toBe(503);
    expect((await call("DELETE", "/fichas/00000000-0000-0000-0000-000000000001", "writer")).status).toBe(503);
  });

  it("sin repositorio configurado: lectura 'available: false' y escritura 503", async () => {
    const { call } = await setup({ repo: null });
    expect((await call("GET", "", "owner")).json.available).toBe(false);
    expect((await call("POST", "/consultar", "writer", { rfcs: ["PRE850101AB1"] })).status).toBe(503);
  });

  it("lista 69-B sin cargar: todo 'sin_datos', nunca verde", async () => {
    const { call } = await setup({ repo: new InMemoryKyc69bRepository(null) });
    const r = await call("POST", "/consultar", "writer", { rfcs: ["PRE850101AB1"] });
    expect(r.json.listaDisponible).toBe(false);
    expect(r.json.filas[0].semaforo).toBe("sin_datos");
  });
});
