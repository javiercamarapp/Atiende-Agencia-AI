// CFO «Análisis de clientes» (Fase A): `GET /v1/restaurantes/:propertyId/admin/cfo/analisis-clientes`. Roles por acción (cfo.ver: owner/admin), alcance por
// sucursal, validación del límite de reactivación, afinidad con lift y k-anonimato calculados en TypeScript, secciones que degradan por separado
// (base sin la 095, error no recuperable), 22023 -> 400, tope por persona y ausencia de PII. Repositorio en memoria con datos 100 % sintéticos.
import { describe, expect, it } from "vitest";
import { CfoParametroInvalidoError, CfoSinAccesoError, InMemoryCfoRepository } from "@atiende/domain-restaurantes/cfo";
import type { DatasetCfoMemoria, FilaCanastaPar, FilaCanastaTotales, FilaProducto, OpcionesCfoMemoria, ParamsCfo, RangoCfo } from "@atiende/domain-restaurantes/cfo";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const Q = "desde=2026-07-01&hasta=2026-09-27";
const RUTA = "analisis-clientes";

const producto = (propertyId: string, ref: string, nombre: string): FilaProducto => ({
  propertyId, productoRef: ref, nombreActual: nombre, categoria: "Tacos", diaNegocio: "2026-09-10", dowNegocio: 4, unidades: 10, ingresoCentavos: 50_000, pedidos: 10,
});

function datasetAnalisis(A: string): Partial<DatasetCfoMemoria> {
  const pares: FilaCanastaPar[] = [
    { propertyId: A, productoA: "refresco", productoB: "taco", pedidosJuntos: 30 },
    { propertyId: A, productoA: "flan", productoB: "refresco", pedidosJuntos: 8 },
    { propertyId: A, productoA: "flan", productoB: "taco", pedidosJuntos: 4 },
  ];
  const totales: FilaCanastaTotales[] = [{ propertyId: A, pedidosTotales: 100, pedidosConProducto: { taco: 40, refresco: 50, flan: 10 } }];
  return {
    canastaPares: pares,
    canastaTotales: totales,
    productos: [producto(A, "taco", "Tacos al pastor"), producto(A, "refresco", "Refresco"), producto(A, "flan", "Flan")],
    analisisRfm: {
      segmentos: [
        { segmento: "campeon", orden: 1, clientes: 2, pedidos: 9, ventaCentavos: 140_000, ticketCentavos: 15_556, recenciaMedianaDias: 3.5 },
        { segmento: "leal", orden: 2, clientes: 0, pedidos: 0, ventaCentavos: 0, ticketCentavos: null, recenciaMedianaDias: null },
        { segmento: "en_riesgo_alto_valor", orden: 3, clientes: 2, pedidos: 5, ventaCentavos: 190_000, ticketCentavos: 38_000, recenciaMedianaDias: 64 },
        { segmento: "nuevo_prometedor", orden: 4, clientes: 1, pedidos: 1, ventaCentavos: 15_000, ticketCentavos: 15_000, recenciaMedianaDias: 3 },
        { segmento: "dormido", orden: 5, clientes: 1, pedidos: 2, ventaCentavos: 4_000, ticketCentavos: 2_000, recenciaMedianaDias: 77 },
        { segmento: "ocasional", orden: 6, clientes: 4, pedidos: 7, ventaCentavos: 92_000, ticketCentavos: 13_143, recenciaMedianaDias: 18.5 },
      ],
      resumen: { clientesConVenta: 10, clientesRecompra: 7, activos30: 6, dormidos: 3, ventaTotalCentavos: 441_000, ventaEnRiesgoCentavos: 194_000 },
      pareto: { puntos: [{ clientesPct: 10, clientes: 1, ventaPct: 22.7 }, { clientesPct: 100, clientes: 10, ventaPct: 100 }], clientesPara50Pct: 30, clientesPara80Pct: 50 },
    },
    analisisIntervalo: [
      { segmento: "global", clientes: 10, intervalos: 13, p25: 10, p50: 10, p75: 14, p90: 16.6 },
      { segmento: "dormido", clientes: 1, intervalos: 1, p25: null, p50: null, p75: null, p90: null },
    ],
    analisisReactivacion: {
      totalElegibles: 4, mostrados: 4, ventaEnJuegoCentavos: 214_000, dormidos: 3, consentimiento: { otorgado: 2, revocado: 1, sinRegistro: 1 },
      filas: ["a1b2c3d4", "e5f6a7b8", "c9d0e1f2", "0a1b2c3d"].map((alias, i) => ({
        alias, ventas: 3 - (i % 2), ultimaVenta: "2026-08-01", diasSinPedir: 58 + i, intervaloMedianoDias: 15.5, umbralDias: 23.3, ventaCentavos: 90_000 - i * 1000, ticketCentavos: 30_000,
        canalFrecuente: "recoger", dormido: i !== 2, consentimiento: (["otorgado", "revocado", "sin_registro", "otorgado"] as const)[i]!, prioridadCentavos: 36_000 - i * 5000,
      })),
    },
    analisisTortilla: {
      pedidosConItems: 40,
      tortilla: [{ tipo: "maiz", renglones: 20, unidades: 30, pedidos: 18 }, { tipo: "harina", renglones: 6, unidades: 8, pedidos: 6 }, { tipo: "mixta", renglones: 1, unidades: 1, pedidos: 1 }],
    },
  };
}

async function construir(op: { repo?: Partial<OpcionesCfoMemoria>; clase?: new (o: OpcionesCfoMemoria) => InMemoryCfoRepository; vacio?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const A = ctx.propertyIdA;
  const B = ctx.propertyIdB;
  const Repo = op.clase ?? InMemoryCfoRepository;
  const repo = new Repo({ sucursales: [A, B], dataset: op.vacio ? {} : datasetAnalisis(A), ...op.repo });
  const deps: AppDeps = { ...ctx.deps, cfoRestaurantesRepo: () => repo };
  const app = envolver(buildApp(deps));
  const url = (qs: string, propertyId = A) => `/v1/restaurantes/${propertyId}/admin/cfo/${RUTA}?${qs}`;
  return { ctx, repo, app, url, A, B };
}

describe("roles por acción y alcance", () => {
  it("owner y admin (también el acotado) ven 200; staff, repartidor y otra organización 403; sin sesión 401", async () => {
    const { ctx, app, url } = await construir();
    for (const [rol, token] of [["owner", ctx.staff.owner.token], ["admin", ctx.staff.admin.token], ["admin acotado", ctx.staff.adminSucursalA.token]] as const) {
      expect((await app.request(url(Q), authedGet(token))).status, rol).toBe(200);
    }
    for (const [rol, token] of [["staff", ctx.staff.staffSucursalA.token], ["repartidor", ctx.staff.repartidor.token], ["otra org", ctx.staff.otroOrgOwner.token]] as const) {
      const r = await app.request(url(Q), authedGet(token));
      expect(r.status, rol).toBe(403);
      // staff y repartidor: el rol lo corta la matriz por acción; otra organización la corta antes la membresía de la propiedad.
      if (rol !== "otra org") expect((await r.json()).message, rol).toBe("Tu rol no tiene acceso al CFO.");
    }
    expect((await app.request(url(Q))).status).toBe(401);
  });

  it("un 403 de rol no consulta la base", async () => {
    const { ctx, app, url, repo } = await construir();
    await app.request(url(Q), authedGet(ctx.staff.repartidor.token));
    expect([...repo.llamadas.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("sucursal ajena, inexistente o de otra organización: el MISMO 403; el admin acotado solo ve la suya", async () => {
    const { ctx, app, url, A, B } = await construir();
    const tok = ctx.staff.adminSucursalA.token;
    const mia = await (await app.request(url(Q), authedGet(tok))).json();
    expect(mia.alcance).toMatchObject({ todas: true, organizacionCompleta: false, propertyIds: [A] });
    const mensajes = new Set<string>();
    for (const id of [B, "00000000-0000-4000-8000-00000000ffff", ctx.otherPropertyId]) {
      const r = await app.request(url(`${Q}&sucursales=${id}`), authedGet(tok));
      expect(r.status, id).toBe(403);
      mensajes.add((await r.json()).message);
    }
    expect([...mensajes]).toEqual(["No tienes acceso a esta sucursal."]);
  });

  it("el middleware de membresía manda: un admin acotado a A no consulta la ruta de la sucursal B", async () => {
    const { ctx, app, url, B } = await construir();
    expect([403, 404]).toContain((await app.request(url(Q, B), authedGet(ctx.staff.adminSucursalA.token))).status);
  });
});

describe("validación de query (422)", () => {
  it.each([
    ["sin fechas", ""],
    ["fecha inválida", "desde=2026-02-30&hasta=2026-03-05"],
    ["invertido", "desde=2026-09-27&hasta=2026-08-31"],
    ["401 días", "desde=2026-01-01&hasta=2027-02-05"],
    ["límite 0", `${Q}&limite=0`],
    ["límite 201", `${Q}&limite=201`],
    ["límite no numérico", `${Q}&limite=abc`],
    ["límite negativo", `${Q}&limite=-1`],
    ["id de sucursal", `${Q}&sucursales=hola`],
  ])("%s -> 422 sin consultar la base", async (_n, qs) => {
    const { ctx, app, url, repo } = await construir();
    const r = await app.request(url(qs), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("validation_error");
    expect([...repo.llamadas.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("el límite 1 y el 200 pasan; por omisión son 50", async () => {
    const { ctx, app, url } = await construir();
    for (const l of ["1", "200"]) expect((await app.request(url(`${Q}&limite=${l}`), authedGet(ctx.staff.owner.token))).status).toBe(200);
    const j = await (await app.request(url(Q), authedGet(ctx.staff.owner.token))).json();
    expect(j.secciones.reactivacion.datos.limite).toBe(50);
  });
});

describe("contenido", () => {
  it("todas las secciones con dato; el límite recorta la lista de reactivación", async () => {
    const { ctx, app, url } = await construir();
    const j = await (await app.request(url(`${Q}&limite=2`), authedGet(ctx.staff.owner.token))).json();
    expect(j.disponible).toBe(true);
    expect(j.periodo).toMatchObject({ desde: "2026-07-01", hasta: "2026-09-27" });
    const s = j.secciones;
    for (const k of ["resumen", "segmentos", "concentracion", "intervalo", "reactivacion", "afinidad", "tortilla"]) expect(s[k].disponible, k).toBe(true);
    expect(s.resumen.datos).toMatchObject({ clientesConVenta: 10, clientesRecompra: 7, recompraPct: 70, activos30: 6, dormidos: 3, intervaloMedianoDias: 10, ventaEnRiesgoCentavos: 194_000 });
    expect(s.segmentos.datos.segmentos.map((x: { segmento: string }) => x.segmento)).toEqual(["campeon", "leal", "en_riesgo_alto_valor", "nuevo_prometedor", "dormido", "ocasional"]);
    expect(s.segmentos.datos.segmentos[0]).toMatchObject({ etiqueta: "Campeones" });
    expect(s.segmentos.datos.pocosClientes).toBe(false);
    expect(s.concentracion.datos.clientesPara50Pct).toBe(30);
    expect(s.reactivacion.datos).toMatchObject({ limite: 2, mostrados: 2, totalElegibles: 4, consentimiento: { otorgado: 2, revocado: 1, sinRegistro: 1 } });
    expect(s.reactivacion.datos.filas).toHaveLength(2);
    expect(s.tortilla.datos.tortilla.map((t: { tipo: string }) => t.tipo)).toEqual(["maiz", "harina", "mixta"]);
    expect(s.tortilla.datos.salsas.disponible).toBe(false);
    expect(j.pendientes.map((p: { clave: string }) => p.clave)).toEqual(expect.arrayContaining(["quejas_por_tipo", "respuesta_humana", "salsas_omisiones"]));
    expect(Object.keys(j.definiciones)).toEqual(expect.arrayContaining(["dormido", "lift", "recencia", "reactivacion"]));
  });

  it("afinidad: lift, confianza y soporte desde cfo_canasta_pares; el par con menos de 5 pedidos se oculta y se cuenta", async () => {
    const { ctx, app, url } = await construir();
    const af = (await (await app.request(url(Q), authedGet(ctx.staff.owner.token))).json()).secciones.afinidad.datos;
    expect(af).toMatchObject({ ocultosPorPrivacidad: 1, minimoPedidos: 5, pedidosTotales: 100, multiSucursal: true });
    expect(af.pares).toHaveLength(2);
    // flan + refresco: 8 juntos de 100; 10 con flan, 50 con refresco => lift 8·100/(10·50) = 1.6; confianza flan→refresco 80 %, refresco→flan 16 %.
    expect(af.pares[0]).toMatchObject({ productoA: "flan", nombreA: "Flan", productoB: "refresco", nombreB: "Refresco", pedidosJuntos: 8, soportePct: 8, lift: 1.6, confianzaAB: 80, confianzaBA: 16 });
    // refresco + taco: 30 juntos; 50 y 40 => lift 1.5; soporte 30 %.
    expect(af.pares[1]).toMatchObject({ productoA: "refresco", productoB: "taco", nombreB: "Tacos al pastor", pedidosJuntos: 30, soportePct: 30, lift: 1.5, confianzaAB: 60, confianzaBA: 75 });
    expect(JSON.stringify(af)).not.toMatch(/"pedidosJuntos":4\b/);
  });

  it("sin ventas: 200 con secciones vacías y un aviso, nunca 500", async () => {
    const { ctx, app, url } = await construir({ vacio: true });
    const r = await app.request(url(Q), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    const j = await r.json();
    // Como la SQL: los 6 segmentos en cero y el resumen en cero (disponible, vacío), no «sin migrar».
    expect(j.secciones.segmentos.datos.segmentos).toHaveLength(6);
    expect(j.secciones.segmentos.datos.segmentos.every((x: { clientes: number }) => x.clientes === 0)).toBe(true);
    expect(j.secciones.resumen).toMatchObject({ disponible: true, datos: { clientesConVenta: 0, recompraPct: null, intervaloMedianoDias: null } });
    expect(j.secciones.concentracion.datos.puntos).toEqual([]);
    expect(j.secciones.afinidad.datos.pares).toEqual([]);
    expect(j.secciones.reactivacion.datos.filas).toEqual([]);
    expect(j.avisos.join(" ")).toContain("No hay ventas con cliente identificado");
  });

  it("sin PII: ni nombre, teléfono, dirección ni customer_id en la respuesta", async () => {
    const { ctx, app, url } = await construir();
    const j = await (await app.request(url(Q), authedGet(ctx.staff.owner.token))).json();
    expect(JSON.stringify(j)).not.toMatch(/telefono|phone|customer_?id|direccion|address|\+52/i);
    // Los únicos identificadores de la lista de clientes son alias de 8 caracteres hexadecimales (los uuid de la respuesta son de sucursales).
    const filas = j.secciones.reactivacion.datos.filas as Array<Record<string, unknown>>;
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) expect(f.alias).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(filas)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("ETag débil y Cache-Control privado, como el resto de las lecturas", async () => {
    const { ctx, app, url } = await construir();
    const r = await app.request(url(Q), authedGet(ctx.staff.owner.token));
    expect(r.headers.get("etag")).toMatch(/^W\//);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });
});

describe("base sin migrar y errores", () => {
  it("sin la 095: 200, las secciones de la 095 dicen «no disponible aún: requiere … 095» y la afinidad (081) sigue", async () => {
    const { ctx, app, url } = await construir({ repo: { migraciones: { m095: false } } });
    const r = await app.request(url(Q), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.disponible).toBe(false);
    for (const k of ["resumen", "segmentos", "concentracion", "intervalo", "reactivacion", "tortilla"]) {
      expect(j.secciones[k].disponible, k).toBe(false);
      expect(j.secciones[k].datos, k).toBeNull();
      expect(j.secciones[k].motivo, k).toMatch(/No disponible aún: requiere .*095/);
    }
    expect(j.secciones.afinidad.disponible).toBe(true);
  });

  it("sin 081, 082, 083 y 095: 200 con todo «no disponible», nunca 500", async () => {
    const { ctx, app, url } = await construir({ repo: { migraciones: { m081: false, m082: false, m083: false, m084: false, m095: false } } });
    const r = await app.request(url(Q), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.disponible).toBe(false);
    expect(Object.values(j.secciones as Record<string, { disponible: boolean }>).every((s) => s.disponible === false)).toBe(true);
    expect(j.secciones.afinidad.motivo).toMatch(/081/);
  });

  it("un error no recuperable en una lectura degrada SOLO esa sección", async () => {
    class FallaRfm extends InMemoryCfoRepository {
      override async clientesRfm(_p: ParamsCfo, _r: RangoCfo): Promise<never> {
        throw new Error("boom: timeout interno");
      }
    }
    const { ctx, app, url } = await construir({ clase: FallaRfm });
    const r = await app.request(url(Q), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.secciones.segmentos).toMatchObject({ disponible: false, datos: null });
    expect(j.secciones.segmentos.motivo).toMatch(/No se pudo leer/);
    expect(JSON.stringify(j)).not.toMatch(/boom|timeout interno/);
    expect(j.secciones.reactivacion.disponible).toBe(true);
    expect(j.secciones.afinidad.disponible).toBe(true);
    expect(j.disponible).toBe(false);
  });

  it("un parámetro que la base rechaza (22023) responde 400 y sin acceso (42501) responde 403", async () => {
    class Param extends InMemoryCfoRepository {
      override async clientesReactivacion(): Promise<never> {
        throw new CfoParametroInvalidoError("cfo_clientes_reactivacion: limite invalido");
      }
    }
    class SinAcceso extends InMemoryCfoRepository {
      override async clientesRfm(): Promise<never> {
        throw new CfoSinAccesoError();
      }
    }
    const a = await construir({ clase: Param });
    const r1 = await a.app.request(a.url(Q), authedGet(a.ctx.staff.owner.token));
    expect(r1.status).toBe(400);
    expect((await r1.json()).message).toBe("cfo_clientes_reactivacion: limite invalido");
    const b = await construir({ clase: SinAcceso });
    expect((await b.app.request(b.url(Q), authedGet(b.ctx.staff.owner.token))).status).toBe(403);
  });
});

describe("tope por persona", () => {
  it("la lectura 121 en un minuto devuelve 429", async () => {
    const { ctx, app, url } = await construir({ vacio: true });
    let ultimo = 200;
    for (let i = 0; i < 121; i++) ultimo = (await app.request(url(Q), authedGet(ctx.staff.owner.token))).status;
    expect(ultimo).toBe(429);
  });
});
