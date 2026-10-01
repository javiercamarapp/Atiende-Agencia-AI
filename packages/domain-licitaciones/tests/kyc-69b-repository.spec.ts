// L-08 -- repositorio del KYC 69-B: en memoria (reglas de aislamiento/topes) y Postgres contra
// la base SIN migrar con AbortAwareFakeSession (una sesion plana no reproduce 25P02).
import { describe, expect, it } from "vitest";
import { InMemoryKyc69bRepository, PostgresKyc69bRepository } from "../src/kyc-69b-repository.ts";
import type { KycListaFixture } from "../src/kyc-69b-repository.ts";
import { KycNotAvailableError, KycRateLimitError, KycValidationError } from "../src/kyc-69b.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";

const LISTA: KycListaFixture = {
  periodo: "2024-06",
  filas: [
    { rfc: "PRE850101AB1", nombre: "PRESUNTA SA", situacion: "presunto", fechaPresuncionSat: "2024-05-12", oficioPresuncion: "500-05-2024-3" },
    { rfc: "DEF900202CD2", situacion: "definitivo", fechaDefinitivoSat: "2024-06-03" },
    { rfc: "DES800303EF3", situacion: "desvirtuado", fechaDesvirtuadoSat: "2024-04-20" },
    { rfc: "SEN700404GH4", situacion: "sentencia_favorable", fechaSentenciaFavorableSat: "2024-05-30" },
  ],
};

describe("InMemoryKyc69bRepository", () => {
  it("consulta un lote: situacion, fecha de publicacion por situacion y semaforo", async () => {
    const repo = new InMemoryKyc69bRepository(LISTA);
    const r = await repo.consultar(ORG_A, ["pre850101ab1", "DEF900202CD2", "DES800303EF3", "SEN700404GH4", "LIM750505IJ5"]);
    expect(r.listaDisponible).toBe(true);
    expect(r.periodo).toBe("2024-06");
    const por = Object.fromEntries(r.filas.map((f) => [f.rfc, f]));
    expect(por.PRE850101AB1).toMatchObject({ situacion: "presunto", fechaPublicacion: "2024-05-12", semaforo: "ambar", encontrado: true });
    expect(por.DEF900202CD2).toMatchObject({ semaforo: "rojo", fechaPublicacion: "2024-06-03" });
    expect(por.DES800303EF3).toMatchObject({ semaforo: "verde", fechaPublicacion: "2024-04-20" });
    expect(por.SEN700404GH4).toMatchObject({ semaforo: "verde", fechaPublicacion: "2024-05-30" });
    expect(por.LIM750505IJ5).toMatchObject({ encontrado: false, semaforo: "verde", situacion: null });
  });

  it("sin lista cargada: sin_datos para todos", async () => {
    const r = await new InMemoryKyc69bRepository(null).consultar(ORG_A, ["PRE850101AB1"]);
    expect(r.listaDisponible).toBe(false);
    expect(r.filas[0]!.semaforo).toBe("sin_datos");
  });

  it("rechaza RFC invalido y lote excesivo ANTES de consultar (nada queda en la bitacora)", async () => {
    const repo = new InMemoryKyc69bRepository(LISTA);
    await expect(repo.consultar(ORG_A, ["xx"])).rejects.toBeInstanceOf(KycValidationError);
    await expect(repo.consultar(ORG_A, Array.from({ length: 51 }, (_, i) => `ZZZ0101${String(i).padStart(2, "0")}AA1`))).rejects.toBeInstanceOf(KycValidationError);
    expect(await repo.listConsultas(ORG_A)).toEqual([]);
  });

  it("la bitacora es PRIVADA por organizacion (cross-tenant)", async () => {
    const repo = new InMemoryKyc69bRepository(LISTA, "user-a");
    await repo.consultar(ORG_A, ["PRE850101AB1", "LIM750505IJ5"]);
    await repo.consultar(ORG_B, ["DEF900202CD2"]);
    const a = await repo.listConsultas(ORG_A);
    const b = await repo.listConsultas(ORG_B);
    expect(a.map((x) => x.rfc).sort()).toEqual(["LIM750505IJ5", "PRE850101AB1"]);
    expect(b.map((x) => x.rfc)).toEqual(["DEF900202CD2"]);
    expect(a.every((x) => x.userId === "user-a")).toBe(true);
    expect(new Set(a.map((x) => x.loteId)).size).toBe(1);
  });

  it("tope diario de 1000 RFC por organizacion en ventana de 24 h; otra org no se afecta; la ventana expira", async () => {
    let ahora = Date.parse("2026-10-01T00:00:00Z");
    const repo = new InMemoryKyc69bRepository(LISTA, null, () => ahora);
    const lote = (n: number, pre: string) => Array.from({ length: n }, (_, i) => `${pre}010101${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}1`);
    for (let k = 0; k < 20; k++) await repo.consultar(ORG_A, lote(50, `Z${String.fromCharCode(65 + k)}Z`));
    await expect(repo.consultar(ORG_A, ["PRE850101AB1"])).rejects.toBeInstanceOf(KycRateLimitError);
    await expect(repo.consultar(ORG_B, ["PRE850101AB1"])).resolves.toBeDefined();
    ahora += 25 * 3600 * 1000;
    await expect(repo.consultar(ORG_A, ["PRE850101AB1"])).resolves.toBeDefined();
  });

  it("fichas: alta, duplicado, borrado y aislamiento entre organizaciones", async () => {
    const repo = new InMemoryKyc69bRepository(LISTA);
    const { id } = await repo.addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "Mi proveedor" });
    await expect(repo.addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "" })).rejects.toBeInstanceOf(KycValidationError);
    await repo.addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "competidor", nombre: "" }); // mismo RFC con otro rol: permitido
    expect((await repo.listFichas(ORG_A)).fichas).toHaveLength(2);
    expect((await repo.listFichas(ORG_B)).fichas).toHaveLength(0);
    expect(await repo.removeFicha(ORG_B, id)).toBe(false);
    expect(await repo.removeFicha(ORG_A, id)).toBe(true);
    expect(await repo.removeFicha(ORG_A, id)).toBe(false);
  });

  it("alerta de proveedor propio: aparece solo si el proveedor figura presunto/definitivo", async () => {
    const repo = new InMemoryKyc69bRepository(LISTA);
    await repo.addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "P1" });
    await repo.addFicha(ORG_A, { rfc: "DEF900202CD2", rol: "competidor", nombre: "C1" });
    await repo.addFicha(ORG_A, { rfc: "DES800303EF3", rol: "proveedor", nombre: "P2" });
    const r = await repo.listFichas(ORG_A);
    expect(r.alertas.map((a) => a.rfc)).toEqual(["PRE850101AB1"]);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresKyc69bRepository -- base SIN migrar (SAVEPOINT)", () => {
  it("consultar: 42883 (funcion inexistente) -> KycNotAvailableError con la sesion RECUPERADA, no 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /kyc_consultar_69b/, respond: () => pgError("42883", "function licitaciones.kyc_consultar_69b(uuid, text[]) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresKyc69bRepository(session);
    await expect(repo.consultar(ORG_A, ["PRE850101AB1"])).rejects.toBeInstanceOf(KycNotAvailableError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // la transaccion compartida NO quedo abortada: la siguiente consulta del request funciona
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("listFichas / estadoLista / listConsultas: 42P01 (tabla o lista de despachos inexistente) -> no disponible, sesion usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /kyc_fichas_con_situacion/, respond: () => pgError("42P01", 'relation "despachos.efos_ingesta" does not exist') },
      { match: /kyc_estado_lista/, respond: () => pgError("42P01", 'relation "despachos.efos_ingesta" does not exist') },
      { match: /kyc_consulta/, respond: () => pgError("42P01", 'relation "licitaciones.kyc_consulta" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresKyc69bRepository(session);
    await expect(repo.listFichas(ORG_A)).rejects.toBeInstanceOf(KycNotAvailableError);
    await expect(repo.estadoLista()).rejects.toBeInstanceOf(KycNotAvailableError);
    await expect(repo.listConsultas(ORG_A)).rejects.toBeInstanceOf(KycNotAvailableError);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("addFicha: 42P01 (tabla kyc_party inexistente) -> no disponible", async () => {
    const session = new AbortAwareFakeSession([{ match: /kyc_party/, respond: () => pgError("42P01", 'relation "licitaciones.kyc_party" does not exist') }]);
    await expect(new PostgresKyc69bRepository(session).addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "" })).rejects.toBeInstanceOf(KycNotAvailableError);
  });

  it("un error de operador (42883 'operator does not exist') NO se disfraza de migracion pendiente", async () => {
    const session = new AbortAwareFakeSession([{ match: /kyc_fichas_con_situacion/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresKyc69bRepository(session).listFichas(ORG_A)).rejects.toThrow(/operator does not exist/);
  });

  it("errores de negocio de la base se traducen: 22023 -> validacion, 54000 -> tope diario / de fichas, 23505 -> duplicado", async () => {
    const mk = (code: string, msg: string) => new PostgresKyc69bRepository(new AbortAwareFakeSession([{ match: /kyc_/, respond: () => pgError(code, msg) }]));
    await expect(mk("22023", "kyc_consultar_69b: RFC con formato invalido").consultar(ORG_A, ["PRE850101AB1"])).rejects.toThrow(KycValidationError);
    await expect(mk("54000", "kyc_consultar_69b: tope de 1000 RFC consultados por organizacion cada 24 horas").consultar(ORG_A, ["PRE850101AB1"])).rejects.toBeInstanceOf(KycRateLimitError);
    await expect(mk("54000", "kyc_party: maximo 500 fichas por organizacion").addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "" })).rejects.toThrow(/fichas/);
    await expect(mk("23505", "duplicate key").addFicha(ORG_A, { rfc: "PRE850101AB1", rol: "proveedor", nombre: "" })).rejects.toThrow(/ya esta registrado/);
  });

  it("base migrada: mapea filas, manda el lote normalizado y sin duplicados", async () => {
    let params: unknown[] | undefined;
    const session = {
      calls: [] as string[],
      async exec() {},
      async query(sql: string, p?: unknown[]) {
        if (/kyc_consultar_69b/.test(sql)) {
          params = p;
          return {
            rows: [
              { out_rfc: "PRE850101AB1", out_encontrado: true, out_periodo: "2024-06", out_nombre: "PRESUNTA SA", out_situacion: "presunto", out_oficio_presuncion: "500", out_fecha_publicacion: "2024-05-12", out_fecha_presuncion_sat: "2024-05-12", out_fecha_desvirtuado_sat: null, out_fecha_definitivo_sat: null, out_fecha_sentencia_favorable_sat: null },
              { out_rfc: "LIM750505IJ5", out_encontrado: false, out_periodo: "2024-06", out_nombre: null, out_situacion: null, out_oficio_presuncion: null, out_fecha_publicacion: null, out_fecha_presuncion_sat: null, out_fecha_desvirtuado_sat: null, out_fecha_definitivo_sat: null, out_fecha_sentencia_favorable_sat: null },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const r = await new PostgresKyc69bRepository(session as never).consultar(ORG_A, [" pre850101ab1", "PRE850101AB1", "lim750505ij5"]);
    expect(params).toEqual([ORG_A, ["PRE850101AB1", "LIM750505IJ5"]]);
    expect(r.filas[0]).toMatchObject({ rfc: "PRE850101AB1", situacion: "presunto", semaforo: "ambar" });
    expect(r.filas[1]).toMatchObject({ rfc: "LIM750505IJ5", encontrado: false, semaforo: "verde" });
  });
});
