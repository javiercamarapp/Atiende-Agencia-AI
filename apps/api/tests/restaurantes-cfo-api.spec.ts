// CFO-05 · API `/v1/restaurantes/:propertyId/admin/cfo/*`: roles por acción, alcance por sucursal, validación de query, base sin migrar, errores SQL
// (22023 -> 400, 42501 -> 403, escritura sin migrar -> 503), consolidado = Σ, sin PII, ETag, tope por persona, captura de costos, configuración e
// importación de SoftRestaurant. Usa el repositorio en memoria con el dataset SINTÉTICO de CFO-04 (nunca datos reales).
import { describe, expect, it } from "vitest";
import { InMemoryCfoRepository } from "@atiende/domain-restaurantes/cfo";
import type { DatasetCfoMemoria, OpcionesCfoMemoria } from "@atiende/domain-restaurantes/cfo";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico, resumirClientes } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const D = generarDatasetSintetico({ diasRango: 120 });
const [T1, T2, T3] = SUCURSALES_PM_SINTETICAS.map((s) => s.propertyId) as [string, string, string];
// Clientes recalculados SOLO con las dos sucursales de la prueba: el renglón del conjunto de las 7 sería mayor que la suma de dos (imposible, y la API lo rechaza).
const CLIENTES_ABC = resumirClientes(D.pedidos.filter((p) => p.propertyId === T1 || p.propertyId === T2 || p.propertyId === T3), D.desde, D.hasta);
const CLIENTES_AB = resumirClientes(D.pedidos.filter((p) => p.propertyId === T1 || p.propertyId === T2), D.desde, D.hasta);
const Q = "desde=2026-08-31&hasta=2026-09-27";
const ENDPOINTS_LECTURA = ["alcance", "resumen", "ventas", "sucursales", "estado-resultados", "clientes", "productos", "patrones", "operacion", "pedidos", "config", "costos", "softrestaurant/lotes", "softrestaurant/cuadre"] as const;

type Fila = { propertyId: string | null };
function remap<T extends Fila>(filas: readonly T[], mapa: ReadonlyMap<string, string>): T[] {
  return filas.filter((f) => f.propertyId === null || mapa.has(f.propertyId)).map((f) => (f.propertyId === null ? f : { ...f, propertyId: mapa.get(f.propertyId)! }));
}

async function construir(op: { repo?: Partial<OpcionesCfoMemoria>; dataset?: Partial<DatasetCfoMemoria> | ((ids: { A: string; B: string }) => Partial<DatasetCfoMemoria>); sinRepo?: boolean; inactiva?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const A = ctx.propertyIdA;
  const B = ctx.propertyIdB;
  const mapa = new Map([[T1, A], [T2, B]]);
  // Sucursal INACTIVA con historia (T3): la SQL la incluye cuando recibe p_props = null, así que la API debe contarla también.
  const C = "cccccccc-0000-4000-8000-0000000000c3";
  if (op.inactiva) {
    mapa.set(T3, C);
    ctx.restaurantesRepo.seedBranch({ propertyId: C, organizationId: ctx.organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });
  }
  const percentiles = [
    { propertyId: A, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 52 },
    { propertyId: B, alcance: "sucursal" as const, entregados: 80, p50Min: 38, p90Min: 57 },
    { propertyId: null, alcance: "conjunto" as const, entregados: 180, p50Min: 36, p90Min: 55 },
  ];
  const repo = new InMemoryCfoRepository({
    sucursales: op.inactiva ? [A, B, C] : [A, B],
    dataset: {
      ventasDiarias: remap(D.ventasDiarias, mapa), cortesias: remap(D.cortesias, mapa), ventasHora: remap(D.ventasHora, mapa), productos: remap(D.productos, mapa), agenteDiario: remap(D.agenteDiario, mapa),
      comandasPos: remap(D.comandasPos, mapa), clientesResumen: remap(op.inactiva ? CLIENTES_ABC : CLIENTES_AB, mapa), agotados: remap(D.agotados, mapa), entregasPercentiles: percentiles,
      cobertura: [A, B].map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" })),
      ...(typeof op.dataset === "function" ? op.dataset({ A, B }) : op.dataset),
    },
    ...op.repo,
  });
  const deps: AppDeps = { ...ctx.deps, ...(op.sinRepo ? {} : { cfoRestaurantesRepo: () => repo }) };
  const app = envolver(buildApp(deps));
  const url = (ruta: string, propertyId = A) => `/v1/restaurantes/${propertyId}/admin/cfo/${ruta}`;
  return { ctx, repo, app, url, A, B, C };
}

describe("roles por acción y alcance", () => {
  it("owner y admin ven todo; staff, repartidor y otra organización reciben 403; sin sesión 401 (en TODAS las lecturas)", async () => {
    const { ctx, app, url } = await construir();
    for (const ep of ENDPOINTS_LECTURA) {
      const ruta = `${ep}${ep === "alcance" || ep === "config" || ep === "softrestaurant/lotes" ? "" : ep === "costos" ? "" : `?${Q}`}`;
      for (const [rol, token] of [["owner", ctx.staff.owner.token], ["admin", ctx.staff.admin.token], ["admin acotado", ctx.staff.adminSucursalA.token]] as const) {
        expect((await app.request(url(ruta), authedGet(token))).status, `${ep} ${rol}`).toBe(200);
      }
      for (const [rol, token] of [["staff", ctx.staff.staffSucursalA.token], ["repartidor", ctx.staff.repartidor.token], ["otra org", ctx.staff.otroOrgOwner.token]] as const) {
        expect((await app.request(url(ruta), authedGet(token))).status, `${ep} ${rol}`).toBe(403);
      }
      expect((await app.request(url(ruta))).status, `${ep} sin sesión`).toBe(401);
    }
  });

  it("el 403 de rol dice «Tu rol no tiene acceso al CFO.» y no filtra datos", async () => {
    const { ctx, app, url } = await construir();
    const r = await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.staffSucursalA.token));
    expect((await r.json()).message).toBe("Tu rol no tiene acceso al CFO.");
  });

  it("las escrituras piden su propia acción: staff y repartidor no capturan, importan ni exportan", async () => {
    const { ctx, app, url } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token]) {
      expect((await app.request(url("config"), authedJson(token, { ivaPct: 8 }, "PUT"))).status).toBe(403);
      expect((await app.request(url("costos"), authedJson(token, { costos: [] }, "PUT"))).status).toBe(403);
      expect((await app.request(url("softrestaurant/importar"), authedJson(token, {}, "POST"))).status).toBe(403);
      expect((await app.request(url("softrestaurant/importar/vista-previa"), authedJson(token, {}, "POST"))).status).toBe(403);
      expect((await app.request(url("exportaciones"), authedJson(token, {}, "POST"))).status).toBe(403);
    }
  });

  it("admin acotado: «todas» = la suya y sin «No asignado»; sucursal ajena, inexistente o de otra organización -> el MISMO 403", async () => {
    const { ctx, app, url, A, B } = await construir();
    const tok = ctx.staff.adminSucursalA.token;
    const todas = await (await app.request(url(`resumen?${Q}`), authedGet(tok))).json();
    expect(todas.alcance).toMatchObject({ todas: true, organizacionCompleta: false, propertyIds: [A], etiqueta: "Su sucursal" });
    expect(todas.kpis.noAsignado).toBeNull();
    expect(todas.kpis.porSucursal.map((c: { propertyId: string }) => c.propertyId)).toEqual([A]);
    const propia = await app.request(url(`resumen?${Q}&sucursales=${A}`), authedGet(tok));
    expect(propia.status).toBe(200);
    const mensajes = new Set<string>();
    for (const id of [B, "00000000-0000-4000-8000-00000000ffff", ctx.otherPropertyId]) {
      const r = await app.request(url(`resumen?${Q}&sucursales=${id}`), authedGet(tok));
      expect(r.status, id).toBe(403);
      mensajes.add((await r.json()).message);
    }
    expect([...mensajes]).toEqual(["No tienes acceso a esta sucursal."]);
    // La mezcla de una propia y una ajena también se rechaza completa.
    expect((await app.request(url(`ventas?${Q}&sucursales=${A},${B}`), authedGet(tok))).status).toBe(403);
    // El owner sí ve la fila «No asignado».
    const dueno = await (await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.owner.token))).json();
    expect(dueno.kpis.noAsignado).not.toBeNull();
    expect(dueno.alcance).toMatchObject({ organizacionCompleta: true, etiqueta: "Todas sus sucursales" });
    const elegida = await (await app.request(url(`resumen?${Q}&sucursales=${B}`), authedGet(ctx.staff.owner.token))).json();
    expect(elegida.kpis.noAsignado).toBeNull();
    expect(elegida.alcance.todas).toBe(false);
  });

  it("el middleware de membresía sigue mandando: un admin acotado a A no consulta la ruta de la sucursal B", async () => {
    const { ctx, app, url, B } = await construir();
    const r = await app.request(url(`resumen?${Q}`, B), authedGet(ctx.staff.adminSucursalA.token));
    expect([403, 404]).toContain(r.status);
  });
});

describe("validación de query (422)", () => {
  it.each([
    ["sin fechas", ""],
    ["fecha inválida", "desde=2026-02-30&hasta=2026-03-05"],
    ["formato", "desde=01-09-2026&hasta=2026-09-27"],
    ["invertido", "desde=2026-09-27&hasta=2026-08-31"],
    ["401 días", "desde=2026-01-01&hasta=2027-02-05"],
    ["comparar", `${Q}&comparar=ayer`],
    ["granularidad", `${Q}&granularidad=hora`],
    ["orden", `${Q}&orden=azar`],
    ["id de sucursal", `${Q}&sucursales=hola`],
    ["lista vacía", `${Q}&sucursales=,`],
  ])("%s -> 422", async (_n, qs) => {
    const { ctx, app, url } = await construir();
    const r = await app.request(url(`resumen?${qs}`), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("validation_error");
  });

  it("400 días exactos sí pasa; 21 sucursales -> 422", async () => {
    const { ctx, app, url } = await construir();
    const ok = await app.request(url("ventas?desde=2026-01-01&hasta=2027-02-04"), authedGet(ctx.staff.owner.token));
    expect(ok.status).toBe(200);
    const ids = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`).join(",");
    expect((await app.request(url(`ventas?${Q}&sucursales=${ids}`), authedGet(ctx.staff.owner.token))).status).toBe(422);
  });

  it("la query inválida no consulta la base (se valida antes de armar el servicio)", async () => {
    const { ctx, app, url, repo } = await construir();
    await app.request(url("resumen?desde=mal&hasta=mal"), authedGet(ctx.staff.owner.token));
    expect([...repo.llamadas.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("base sin migrar y errores de la base", () => {
  it("lecturas con la base vieja: 200 con disponible=false y bloques, nunca 500", async () => {
    const { ctx, app, url } = await construir({ repo: { migraciones: { m081: false, m082: false, m083: false } } });
    for (const ep of ENDPOINTS_LECTURA) {
      const ruta = `${ep}${["alcance", "config", "softrestaurant/lotes", "costos"].includes(ep) ? "" : `?${Q}`}`;
      const r = await app.request(url(ruta), authedGet(ctx.staff.owner.token));
      expect(r.status, ep).toBe(200);
      const j = await r.json();
      // `bloques` informa lo que la vista usó y no encontró; ninguna vista que lee datos de 081/082/083 queda «disponible».
      if (!["config", "costos", "softrestaurant/lotes"].includes(ep)) {
        expect(j.disponible, ep).toBe(false);
        expect(Object.values(j.bloques as Record<string, boolean>).some((b) => b === false), ep).toBe(true);
      } else expect(j.disponible, ep).toBe(false);
    }
    const resumen = await (await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.owner.token))).json();
    expect(resumen.avisos.length).toBeGreaterThanOrEqual(3);
    expect(resumen.kpis.total.kpis.every((k: { valor: { valor: number | null } }) => k.valor.valor === null)).toBe(true);
  });

  it("escrituras con la base vieja: 503 honesto (config, costos, importación, exportación)", async () => {
    const { ctx, app, url } = await construir({ repo: { migraciones: { m083: false } } });
    const tok = ctx.staff.owner.token;
    expect((await app.request(url("config"), authedJson(tok, { ivaPct: 8 }, "PUT"))).status).toBe(503);
    expect((await app.request(url("costos"), authedJson(tok, { costos: [{ propertyId: ctx.propertyIdA, mes: "2026-09", concepto: "renta", montoCentavos: 1000 }] }, "PUT"))).status).toBe(503);
    expect((await app.request(url("exportaciones"), authedJson(tok, { vista: "resumen", formato: "pdf", desde: "2026-09-01", hasta: "2026-09-27" }, "POST"))).status).toBe(503);
    const tabla = [["Fecha", "Tipo de servicio", "Cuentas", "Subtotal", "Total"], ["2026-09-10", "Domicilio", 5, "1000.00", "900.00"]];
    expect((await app.request(url("softrestaurant/importar"), authedJson(tok, { propertyId: ctx.propertyIdA, nombreArchivo: "x.csv", tabla }, "POST"))).status).toBe(503);
  });

  it("despliegue sin repositorio del CFO: 503 honesto", async () => {
    const { ctx, app, url } = await construir({ sinRepo: true });
    expect((await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.owner.token))).status).toBe(503);
  });

  it("un parámetro que la base rechaza (22023) responde 400 con el mensaje de la base; sin acceso (42501) responde 403", async () => {
    const { ctx, app, url } = await construir();
    const tok = ctx.staff.owner.token;
    // activoDias = 300 es válido solo (7..365) pero rompe activo < perdido (120): lo rechaza la base, no el esquema del borde.
    const r = await app.request(url("config"), authedJson(tok, { activoDias: 300 }, "PUT"));
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain("activo_dias debe ser menor que perdido_dias");
    // Repositorio cuyo actor no tiene alcance a la sucursal (defensa en profundidad de la base): 42501 -> 403 con el mensaje único.
    const acotadoEnBase = await construir({ repo: { permitidas: [] , organizacionCompleta: false } });
    const r2 = await acotadoEnBase.app.request(acotadoEnBase.url(`resumen?${Q}&sucursales=${acotadoEnBase.A}`), authedGet(acotadoEnBase.ctx.staff.owner.token));
    expect(r2.status).toBe(403);
    expect((await r2.json()).message).toBe("No tienes acceso a esta sucursal.");
  });
});

describe("contenido de las vistas", () => {
  it("/resumen: consolidado = Σ sucursales con el dataset sintético; narrativa sin números inventados; sin PII", async () => {
    const { ctx, app, url } = await construir();
    const texto = await (await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.owner.token))).text();
    const r = JSON.parse(texto);
    expect(r.kpis.porSucursal).toHaveLength(2);
    for (const k of ["netaCentavos", "pedidos", "brutaCentavos", "descPromoCentavos", "cancelados"]) {
      expect(r.kpis.total.sumas[k], k).toBe(r.kpis.porSucursal.reduce((s: number, c: { sumas: Record<string, number> }) => s + c.sumas[k]!, 0));
    }
    expect(r.narrativa.numerosNoRespaldados).toEqual([]);
    expect(r.titular.etiqueta).toBe("Ventas por el agente");
    expect(r.avisoLegal).toContain("No sustituye a tu contabilidad");
    expect(texto).not.toMatch(/telefono|phone|customer_phone|"nombre_cliente"|direccion/i);
    expect(r.kpis.total.kpis.map((k: { id: string }) => k.id)).toContain("entrega_p90");
    expect(r.fuentes.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(["pedidos", "agente"]));
  });

  it("/clientes: el total es el conjunto (no la suma) y dice cuántos compraron en 2+ sucursales", async () => {
    const { ctx, app, url } = await construir();
    const r = await (await app.request(url(`clientes?${Q}`), authedGet(ctx.staff.owner.token))).json();
    const suma = r.porSucursal.reduce((s: number, c: { resumen: { clientesConPedido: number } }) => s + c.resumen.clientesConPedido, 0);
    expect(r.total.resumen.clientesConPedido).toBeLessThanOrEqual(suma);
    expect(r.multiSucursal.sumaPorSucursal).toBe(suma);
  });

  it("/operacion: Meta «no medido» llega como null con su fuente (nunca $0) y el LLM de la organización solo al owner", async () => {
    const { ctx, app, url } = await construir();
    const dueno = await (await app.request(url(`operacion?${Q}`), authedGet(ctx.staff.owner.token))).json();
    expect(dueno.costoAgente.total.meta).toEqual({ valor: null, confianza: "sin_dato", fuente: "Meta: no medido" });
    expect(dueno.costoAgente.noAsignado).not.toBeNull();
    const acotado = await (await app.request(url(`operacion?${Q}`), authedGet(ctx.staff.adminSucursalA.token))).json();
    expect(acotado.costoAgente.noAsignado).toBeNull();
    expect(acotado.costoAgente.total.llmTexto.valor).toBeNull();
    expect(acotado.avisos).toContain("Costo de Meta no medido: el costo del agente no lo incluye (no se muestra como $0).");
  });

  it("/pedidos: pagina con cursor, valida filtro y límite, y no trae PII", async () => {
    const detalle = (A: string) =>
      Array.from({ length: 5 }, (_, i) => ({
        orderId: `o${i}`, orderNumber: String(200 + i), propertyId: A, diaNegocio: "2026-09-20", horaLocal: 13, canal: "domicilio" as const, source: "whatsapp" as const, status: "entregado", paymentMethod: "tarjeta" as const,
        brutaCentavos: 10_000, descCentavos: 0, netaCentavos: 10_000, propinaCentavos: 500, entregadoMin: 41.5, esCompensacion: false, esReposicion: false, clienteAlias: "a1b2c3d4", comandaEstado: null,
      }));
    const b = await construir({ dataset: ({ A }) => ({ pedidosDetalle: detalle(A) }) });
    const t = b.ctx.staff.owner.token;
    const p1 = await (await b.app.request(b.url(`pedidos?${Q}&limite=2`), authedGet(t))).json();
    expect(p1.pedidos.map((x: { orderNumber: string }) => x.orderNumber)).toEqual(["204", "203"]);
    expect(p1.cursor).toBe("2026-09-20|203");
    const p2 = await (await b.app.request(b.url(`pedidos?${Q}&limite=2&cursor=${encodeURIComponent(p1.cursor)}`), authedGet(t))).json();
    expect(p2.pedidos.map((x: { orderNumber: string }) => x.orderNumber)).toEqual(["202", "201"]);
    const llaves = Object.keys(p1.pedidos[0]).join(",");
    expect(llaves).not.toMatch(/phone|telefono|nombre|direccion|address|email/i);
    expect(p1.pedidos[0].clienteAlias).toBe("a1b2c3d4");
    const filtro = encodeURIComponent(JSON.stringify({ canal: "domicilio", es_venta: true, hora_local: 13 }));
    expect((await b.app.request(b.url(`pedidos?${Q}&filtro=${filtro}`), authedGet(t))).status).toBe(200);
    for (const mal of [encodeURIComponent(JSON.stringify({ telefono: "999" })), encodeURIComponent("{no json"), encodeURIComponent(JSON.stringify({ hora_local: 99 })), encodeURIComponent(JSON.stringify([1]))])
      expect((await b.app.request(b.url(`pedidos?${Q}&filtro=${mal}`), authedGet(t))).status).toBe(422);
    expect((await b.app.request(b.url(`pedidos?${Q}&limite=101`), authedGet(t))).status).toBe(422);
    expect((await b.app.request(b.url(`pedidos?${Q}&cursor=mal`), authedGet(t))).status).toBe(422);
    // Revisión: el formato bien pero la fecha imposible o fuera de 2000..2100 era un 400 desde la SQL; ahora es 422 (y la API no llega al repositorio).
    for (const c of ["0000-00-00|1", "2026-02-30|1", "2026-13-01|5", "1999-12-31|1", "2101-01-01|1", "9999-99-99|1"])
      expect((await b.app.request(b.url(`pedidos?${Q}&cursor=${encodeURIComponent(c)}`), authedGet(t))).status, c).toBe(422);
    expect((await b.app.request(b.url(`pedidos?${Q}&cursor=${encodeURIComponent("2026-09-20|203")}`), authedGet(t))).status).toBe(200);
  });

  it("ETag: la segunda lectura con If-None-Match devuelve 304 sin cuerpo; si cambia el rango, cambia el ETag", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    const a = await app.request(url(`ventas?${Q}`), authedGet(t));
    const etag = a.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    expect(a.headers.get("cache-control")).toBe("private, no-cache");
    const b = await app.request(url(`ventas?${Q}`), { method: "GET", headers: { authorization: `Bearer ${t}`, "if-none-match": etag! } });
    expect(b.status).toBe(304);
    expect(await b.text()).toBe("");
    const c2 = await app.request(url("ventas?desde=2026-09-01&hasta=2026-09-10"), { method: "GET", headers: { authorization: `Bearer ${t}`, "if-none-match": etag! } });
    expect(c2.status).toBe(200);
    expect(c2.headers.get("etag")).not.toBe(etag);
  });

  it("tope por persona: la lectura 121 en un minuto devuelve 429", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    let ultimo = 200;
    for (let i = 0; i < 121; i++) ultimo = (await app.request(url("config"), authedGet(t))).status;
    expect(ultimo).toBe(429);
  });
});

describe("configuración y costos", () => {
  it("GET/PUT /config: defaults, guardado, rangos (422), llaves desconocidas y admin acotado de solo lectura", async () => {
    const { ctx, app, url, repo } = await construir();
    const t = ctx.staff.owner.token;
    const g = await (await app.request(url("config"), authedGet(t))).json();
    expect(g).toMatchObject({ disponible: true, configurada: false, puedeGuardar: true });
    expect(g.rangos.activoDias).toEqual([7, 365]);
    const put = await app.request(url("config"), authedJson(t, { ivaPct: 8, comisionTerminalPct: 2.5, descuentoMaxPct: 10 }, "PUT"));
    expect(put.status).toBe(200);
    const nuevo = await put.json();
    expect(nuevo.config).toMatchObject({ ivaPct: 8, comisionTerminalPct: 2.5, descuentoMaxPct: 10 });
    expect(nuevo.configurada).toBe(true);
    expect(repo.auditoria.map((a) => a.action)).toEqual(["cfo.config_actualizada"]);
    expect((await app.request(url("config"), authedJson(t, { comisionTerminalPct: null }, "PUT"))).status).toBe(200);
    for (const mal of [{ ivaPct: 31 }, { perdidoDias: 731 }, { activoDias: 6 }, { frecuenteDias: 29 }, { frecuenteN: 2.5 }, { activoDias: 100, perdidoDias: 50 }, { x: 1 }, {}, { ivaPct: "16" }, [1]])
      expect((await app.request(url("config"), authedJson(t, mal, "PUT"))).status, JSON.stringify(mal)).toBe(422);
    const acotado = ctx.staff.adminSucursalA.token;
    expect((await (await app.request(url("config"), authedGet(acotado))).json()).puedeGuardar).toBe(false);
    const rechazo = await app.request(url("config"), authedJson(acotado, { ivaPct: 10 }, "PUT"));
    expect(rechazo.status).toBe(403);
    expect((await app.request(url("config"), authedJson(t, { ivaPct: 8, relleno: "x".repeat(5000) }, "PUT"))).status).toBe(413);
  });

  it("PUT /costos: versiona, historial, admin acotado no captura costos de la organización ni de sucursal ajena, lote inválido se rechaza completo", async () => {
    const { ctx, app, url, A, B, repo } = await construir();
    const t = ctx.staff.owner.token;
    const costo = (extra: Record<string, unknown> = {}) => ({ propertyId: A, mes: "2026-09", concepto: "nomina", montoCentavos: 5_000_000, ...extra });
    const r1 = await app.request(url("costos"), authedJson(t, { costos: [costo(), costo({ concepto: "food_cost_objetivo_pct", montoCentavos: undefined, pct: 32 })] }, "PUT"));
    expect(r1.status).toBe(200);
    expect((await r1.json()).guardados).toBe(2);
    await app.request(url("costos"), authedJson(t, { costos: [costo({ montoCentavos: 5_200_000, nota: "ajuste" })] }, "PUT"));
    const lista = await (await app.request(url("costos?mesDesde=2026-09&mesHasta=2026-09"), authedGet(t))).json();
    const nomina = lista.costos.filter((c: { concepto: string }) => c.concepto === "nomina");
    expect(nomina).toHaveLength(1);
    expect(nomina[0]).toMatchObject({ montoCentavos: 5_200_000, mes: "2026-09-01", nota: "ajuste" });
    const h = await (await app.request(url(`costos/historial?propertyId=${A}&mes=2026-09&concepto=nomina`), authedGet(t))).json();
    expect(h.historial.map((x: { version: number; montoCentavos: number; vigente: boolean }) => [x.version, x.montoCentavos, x.vigente])).toEqual([[1, 5_000_000, false], [2, 5_200_000, true]]);
    expect(repo.auditoria.filter((a) => a.action === "cfo.costo_capturado")).toHaveLength(3);

    const ac = ctx.staff.adminSucursalA.token;
    expect((await app.request(url("costos"), authedJson(ac, { costos: [costo({ montoCentavos: 1 })] }, "PUT"))).status).toBe(200);
    expect((await app.request(url("costos"), authedJson(ac, { costos: [costo({ propertyId: null, concepto: "renta" })] }, "PUT"))).status).toBe(403);
    expect((await app.request(url("costos"), authedJson(ac, { costos: [costo({ propertyId: B })] }, "PUT"))).status).toBe(403);
    expect((await app.request(url(`costos/historial?mes=2026-09&concepto=renta`), authedGet(ac))).status).toBe(403); // costos de la organización
    const antes = repo.auditoria.length;
    const lote = await app.request(url("costos"), authedJson(t, { costos: [costo({ concepto: "renta" }), costo({ concepto: "servicios", montoCentavos: -5 })] }, "PUT"));
    expect(lote.status).toBe(422);
    expect(repo.auditoria.length).toBe(antes); // nada se escribió
    for (const mal of [
      { costos: [] }, { costos: [costo({ pct: 10 })] }, { costos: [costo({ concepto: "x" })] }, { costos: [costo({ mes: "2026-13" })] }, { costos: [costo({ montoCentavos: 1.5 })] },
      { costos: [costo({ nota: "n".repeat(301) })] }, { costos: [costo({ propertyId: "no-uuid" })] }, { costos: [costo({ extra: 1 })] }, { costos: Array.from({ length: 51 }, () => costo()) }, { otra: 1 },
    ])
      expect((await app.request(url("costos"), authedJson(t, mal, "PUT"))).status, JSON.stringify(mal).slice(0, 60)).toBe(422);
  });

  it("el costo de la organización lo ve y lo captura solo el owner/admin de organización completa (GET /costos oculta «No asignado» al acotado)", async () => {
    const { ctx, app, url, A } = await construir();
    const t = ctx.staff.owner.token;
    await app.request(url("costos"), authedJson(t, { costos: [{ propertyId: null, mes: "2026-09", concepto: "renta", montoCentavos: 9_000_000 }, { propertyId: A, mes: "2026-09", concepto: "renta", montoCentavos: 1_000_000 }] }, "PUT"));
    const dueno = await (await app.request(url("costos?mesDesde=2026-09&mesHasta=2026-09"), authedGet(t))).json();
    expect(dueno.costos.some((c: { propertyId: string | null }) => c.propertyId === null)).toBe(true);
    expect(dueno.puedeCapturarOrganizacion).toBe(true);
    const acotado = await (await app.request(url("costos?mesDesde=2026-09&mesHasta=2026-09"), authedGet(ctx.staff.adminSucursalA.token))).json();
    expect(acotado.costos.every((c: { propertyId: string | null }) => c.propertyId === A)).toBe(true);
    expect(acotado.puedeCapturarOrganizacion).toBe(false);
  });
});

describe("SoftRestaurant: importación, lotes y cuadre", () => {
  const TABLA = [
    ["Reporte de ventas por tipo de servicio"],
    ["Fecha", "Tipo de servicio", "Cuentas", "Subtotal", "Descuento", "Total"],
    ["2026-09-10", "Domicilio", 20, "3000.00", "200.00", "2800.00"],
    ["2026-09-10", "Comedor", 30, "6000.00", "0", "6000.00"],
  ];
  const cuerpo = (propertyId: string, extra: Record<string, unknown> = {}) => ({ propertyId, nombreArchivo: "ventas-sept.csv", tabla: TABLA, ...extra });

  it("vista previa: normaliza y NO escribe (ni lote ni bitácora); devuelve el mapeo INFERIDO, la huella y una muestra sin PII", async () => {
    const { ctx, app, url, A, repo } = await construir();
    const r = await app.request(url("softrestaurant/importar/vista-previa"), authedJson(ctx.staff.owner.token, cuerpo(A), "POST"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, tipo: "resumen_servicio", inferido: true, aceptados: 2, rechazados: 0, escribio: false });
    expect(j.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(j.mapeo).toBeTruthy();
    expect(j.muestra.find((m: { tipo_servicio: string }) => m.tipo_servicio === "domicilio")).toMatchObject({ dia_negocio: "2026-09-10", neta_centavos: 280_000, tickets: 20 });
    expect(repo.llamadas.get("srImportar") ?? 0).toBe(0);
    expect(repo.auditoria).toHaveLength(0);
    expect((await (await app.request(url("softrestaurant/lotes"), authedGet(ctx.staff.owner.token))).json()).lotes).toEqual([]);
  });

  it("importar: crea el lote (201), es idempotente (200, creado=false, sin segunda bitácora) y alimenta lotes y cuadre", async () => {
    const { ctx, app, url, A, repo } = await construir();
    const t = ctx.staff.owner.token;
    const a = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A), "POST"));
    expect(a.status).toBe(201);
    const ja = await a.json();
    expect(ja).toMatchObject({ creado: true, aceptados: 2, rechazados: 0, tipo: "resumen_servicio", inferido: true });
    const b = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A), "POST"));
    expect(b.status).toBe(200);
    const jb = await b.json();
    expect(jb).toMatchObject({ creado: false, loteId: ja.loteId, huella: ja.huella });
    expect(repo.auditoria.filter((x) => x.action === "cfo.sr_importado")).toHaveLength(1);
    const lotes = await (await app.request(url("softrestaurant/lotes"), authedGet(t))).json();
    expect(lotes.lotes).toHaveLength(1);
    expect(lotes.lotes[0]).toMatchObject({ propertyId: A, tipo: "resumen_servicio", aceptados: 2 });
    expect(lotes.cobertura.find((c: { propertyId: string }) => c.propertyId === A)).toMatchObject({ diasConDato: 1, diaMin: "2026-09-10" });
    const cuadre = await (await app.request(url(`softrestaurant/cuadre?desde=2026-09-01&hasta=2026-09-27`), authedGet(t))).json();
    expect(cuadre.filas).toHaveLength(1);
    expect(cuadre.filas[0]).toMatchObject({ propertyId: A, diaNegocio: "2026-09-10", srDomicilioCentavos: 280_000 });
    expect(["verde", "ambar", "rojo"]).toContain(cuadre.filas[0].semaforo);
    expect(cuadre.umbrales).toEqual({ verdePct: 1, ambarPct: 3, verdeCentavos: 5000 });
  });

  it("archivo con columna de teléfono/cliente: 422 «columnas_personales», NO se importa nada y no hay bitácora", async () => {
    const { ctx, app, url, A, repo } = await construir();
    const t = ctx.staff.owner.token;
    const tabla = TABLA.map((fila, i) => (i === 1 ? [...fila, "Teléfono"] : i >= 2 ? [...fila, "9990000000"] : fila));
    for (const ruta of ["softrestaurant/importar/vista-previa", "softrestaurant/importar"]) {
      const r = await app.request(url(ruta), authedJson(t, cuerpo(A, { tabla }), "POST"));
      expect(r.status, ruta).toBe(422);
      const j = await r.json();
      expect(j).toMatchObject({ code: "columnas_personales", escribio: false });
      expect(JSON.stringify(j)).not.toContain("9990000000");
    }
    expect(repo.llamadas.get("srImportar") ?? 0).toBe(0);
    expect(repo.auditoria).toHaveLength(0);
  });

  it("sin encabezados reconocibles -> 422; renglones inválidos se rechazan por renglón; ninguno válido -> 422 sin lote", async () => {
    const { ctx, app, url, A, repo } = await construir();
    const t = ctx.staff.owner.token;
    const sinEnc = await app.request(url("softrestaurant/importar/vista-previa"), authedJson(t, cuerpo(A, { tabla: [["a", "b"], [1, 2]] }), "POST"));
    expect(sinEnc.status).toBe(422);
    const tablaMala = [TABLA[1]!, ["no-es-fecha", "Domicilio", 5, "100.00", "0", "100.00"], ["2026-09-11", "Domicilio", 5, "100.00", "0", "100.00"]];
    const parcial = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A, { tabla: tablaMala }), "POST"));
    expect(parcial.status).toBe(201);
    expect(await parcial.json()).toMatchObject({ aceptados: 1, rechazados: 1 });
    const ninguno = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A, { tabla: [TABLA[1]!, ["no-es-fecha", "Domicilio", 5, "100.00", "0", "100.00"]] }), "POST"));
    expect(ninguno.status).toBe(422);
    expect((await ninguno.json()).code).toBe("sin_renglones_validos");
    expect(repo.auditoria.filter((x) => x.action === "cfo.sr_importado")).toHaveLength(1);
  });

  it("topes: cuerpo > 4 MB -> 413; más de 2 000 renglones de resumen -> 413 claro; una tabla de más de 20 030 filas -> 413", async () => {
    const { ctx, app, url, A } = await construir();
    const t = ctx.staff.owner.token;
    const relleno = Array.from({ length: 60 }, () => "x".repeat(100_000));
    const grande = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A, { tabla: [...TABLA, relleno] }), "POST"));
    expect(grande.status).toBe(413);
    const muchos = [TABLA[1]!, ...Array.from({ length: 2001 }, (_, i) => [`2026-09-${String((i % 27) + 1).padStart(2, "0")}`, "Domicilio", 1, "10.00", "0", "10.00"])];
    const r = await app.request(url("softrestaurant/importar"), authedJson(t, cuerpo(A, { tabla: muchos, tipo: "resumen_servicio" }), "POST"));
    expect(r.status).toBe(413);
    expect((await r.json()).message).toMatch(/2[\s,.]?000/);
    const enorme = Array.from({ length: 20_031 }, () => ["x"]);
    expect((await app.request(url("softrestaurant/importar/vista-previa"), authedJson(t, cuerpo(A, { tabla: enorme }), "POST"))).status).toBe(413);
  });

  it("alcance de la importación: un archivo es de UNA sucursal; el admin acotado no importa para otra; cuerpo inválido -> 422", async () => {
    const { ctx, app, url, A, B } = await construir();
    const ac = ctx.staff.adminSucursalA.token;
    expect((await app.request(url("softrestaurant/importar"), authedJson(ac, cuerpo(B), "POST"))).status).toBe(403);
    expect((await app.request(url("softrestaurant/importar"), authedJson(ac, cuerpo(A), "POST"))).status).toBe(201);
    for (const mal of [{}, cuerpo("no-uuid"), cuerpo(A, { nombreArchivo: "../x.csv" }), cuerpo(A, { tabla: [] }), cuerpo(A, { tipo: "otro" }), cuerpo(A, { extra: 1 }), cuerpo(A, { tabla: [[{}]] })])
      expect((await app.request(url("softrestaurant/importar/vista-previa"), authedJson(ctx.staff.owner.token, mal, "POST"))).status, JSON.stringify(mal).slice(0, 50)).toBe(422);
  });

  it("el tope de importaciones por persona (10 cada 10 minutos) devuelve 429", async () => {
    const { ctx, app, url, A } = await construir();
    let ultimo = 0;
    for (let i = 0; i < 11; i++) {
      const tabla = [TABLA[1]!, [`2026-09-${String(i + 1).padStart(2, "0")}`, "Domicilio", 5, "100.00", "0", "100.00"]];
      ultimo = (await app.request(url("softrestaurant/importar"), authedJson(ctx.staff.owner.token, cuerpo(A, { tabla }), "POST"))).status;
    }
    expect(ultimo).toBe(429);
  });
});

describe("exportaciones (solo bitácora; el archivo es CFO-06)", () => {
  it("registra la exportación con vista, formato y rango; valida; admin acotado exporta solo lo suyo", async () => {
    const { ctx, app, url, A, B, repo } = await construir();
    const body = { vista: "resumen", formato: "pdf", desde: "2026-09-01", hasta: "2026-09-27" };
    const r = await app.request(url("exportaciones"), authedJson(ctx.staff.owner.token, body, "POST"));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ registrada: true, vista: "resumen", formato: "pdf" });
    expect(repo.auditoria).toEqual([{ action: "cfo.exportacion", detalle: { vista: "resumen", formato: "pdf", desde: "2026-09-01", hasta: "2026-09-27", todas: true } }]);
    expect((await app.request(url("exportaciones"), authedJson(ctx.staff.adminSucursalA.token, { ...body, sucursales: A }, "POST"))).status).toBe(201);
    expect((await app.request(url("exportaciones"), authedJson(ctx.staff.adminSucursalA.token, { ...body, sucursales: B }, "POST"))).status).toBe(403);
    for (const mal of [{ ...body, vista: "otra" }, { ...body, formato: "csv" }, { ...body, desde: "mal" }, { ...body, extra: 1 }, {}])
      expect((await app.request(url("exportaciones"), authedJson(ctx.staff.owner.token, mal, "POST"))).status).toBe(422);
  });
});

describe("entradas hostiles y sucursales inactivas (revisión de #509)", () => {
  it("sucursal INACTIVA con historia: /resumen, /clientes, /patrones y /ventas cuentan lo mismo que la SQL (todas las sucursales de la organización) y la marcan activa:false", async () => {
    const { ctx, app, url, C } = await construir({ inactiva: true });
    const t = ctx.staff.owner.token;
    const resumen = await app.request(url(`resumen?${Q}`), authedGet(t));
    expect(resumen.status).toBe(200);
    const r = await resumen.json();
    expect(r.kpis.porSucursal.map((c: { propertyId: string }) => c.propertyId)).toContain(C);
    expect(r.sucursales.find((x: { propertyId: string }) => x.propertyId === C)).toMatchObject({ nombre: "Cerrada", activa: false });
    expect(r.kpis.total.sumas.netaCentavos).toBe(r.kpis.porSucursal.reduce((s: number, c: { sumas: { netaCentavos: number } }) => s + c.sumas.netaCentavos, 0));
    const cl = await app.request(url(`clientes?${Q}`), authedGet(t));
    expect(cl.status).toBe(200);
    expect((await app.request(url(`patrones?${Q}`), authedGet(t))).status).toBe(200);
    // Un admin acotado no la ve (no está en su membresía).
    const acotado = await (await app.request(url(`resumen?${Q}`), authedGet(ctx.staff.adminSucursalA.token))).json();
    expect(acotado.kpis.porSucursal.map((c: { propertyId: string }) => c.propertyId)).not.toContain(C);
  });

  it("sucursales=<inactiva> se acepta explícitamente (la SQL no filtra por status): el owner la consulta sola; el admin acotado que no la tiene recibe el mismo 403", async () => {
    const { ctx, app, url, A, C } = await construir({ inactiva: true });
    const t = ctx.staff.owner.token;
    const sola = await app.request(url(`resumen?${Q}&sucursales=${C}`), authedGet(t));
    expect(sola.status).toBe(200);
    const r = await sola.json();
    expect(r.kpis.porSucursal.map((c: { propertyId: string }) => c.propertyId)).toEqual([C]);
    expect(r.sucursales).toEqual([expect.objectContaining({ propertyId: C, nombre: "Cerrada", activa: false })]);
    // Mezclada con una activa también se acepta.
    const mezcla = await app.request(url(`resumen?${Q}&sucursales=${A},${C}`), authedGet(t));
    expect(mezcla.status).toBe(200);
    expect((await mezcla.json()).kpis.porSucursal.map((c: { propertyId: string }) => c.propertyId).sort()).toEqual([A, C].sort());
    // Fuera de la membresía del admin acotado: el MISMO 403 que una sucursal ajena.
    expect((await app.request(url(`resumen?${Q}&sucursales=${C}`), authedGet(ctx.staff.adminSucursalA.token))).status).toBe(403);
  });

  it("llaves del prototipo en PUT /config -> 422 (no 500)", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    for (const llave of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
      const raw = `{"${llave}": 5}`;
      const init = { method: "PUT", body: raw, headers: { authorization: `Bearer ${t}`, "content-type": "application/json", "content-length": String(raw.length) } };
      const res = await app.request(url("config"), init);
      expect(res.status, llave).toBe(422);
    }
  });

  it.each([
    ["año 0000", "desde=0000-01-01&hasta=0000-01-31"],
    ["año 0001 (el periodo anterior caería al año 0000)", "desde=0001-01-01&hasta=0001-01-31"],
    ["año 9999 (rango de más de 800 días al expandir)", "desde=9999-12-01&hasta=9999-12-31"],
    ["año 1999", "desde=1999-12-01&hasta=1999-12-31"],
    ["año 2101", "desde=2101-01-01&hasta=2101-01-31"],
  ])("fecha fuera de 2000..2100 (%s) -> 422 en todas las vistas de periodo", async (_n, qs) => {
    const { ctx, app, url } = await construir();
    for (const ep of ["resumen", "ventas", "sucursales", "estado-resultados", "clientes", "productos", "patrones", "operacion", "pedidos", "softrestaurant/cuadre"])
      expect((await app.request(url(`${ep}?${qs}`), authedGet(ctx.staff.owner.token))).status, ep).toBe(422);
  });

  it("los extremos admitidos (2000-01-01 y 2100-12-31) no revientan ni siquiera con el periodo anterior y las 4 semanas previas", async () => {
    const { ctx, app, url } = await construir();
    for (const qs of ["desde=2000-01-01&hasta=2000-01-31", "desde=2100-12-01&hasta=2100-12-31"]) {
      expect((await app.request(url(`resumen?${qs}&comparar=mismo_dia_semana_4`), authedGet(ctx.staff.owner.token))).status).toBe(200);
      expect((await app.request(url(`resumen?${qs}&comparar=anio_anterior`), authedGet(ctx.staff.owner.token))).status).toBe(200);
    }
  });

  it("mes inválido o fuera de 2000..2100 en PUT /costos y /costos/historial -> 422", async () => {
    const { ctx, app, url, A } = await construir();
    const t = ctx.staff.owner.token;
    for (const mes of ["0000-01", "0001-01-01", "9999-12", "1999-12", "2101-01"]) {
      const put = await app.request(url("costos"), authedJson(t, { costos: [{ propertyId: A, mes, concepto: "renta", montoCentavos: 1 }] }, "PUT"));
      expect(put.status, mes).toBe(422);
      expect((await app.request(url(`costos/historial?propertyId=${A}&mes=${mes}&concepto=renta`), authedGet(t))).status, mes).toBe(422);
    }
    expect((await app.request(url("costos?mesDesde=0000-01&mesHasta=0000-12"), authedGet(t))).status).toBe(422);
  });

  it("un cuerpo de importación por encima de 4 MB devuelve el 413 propio (por debajo del límite de la plataforma)", async () => {
    const { ctx, app, url, A } = await construir();
    const relleno = Array.from({ length: 45 }, () => "x".repeat(100_000)); // ≈ 4.5 MB
    const r = await app.request(url("softrestaurant/importar"), authedJson(ctx.staff.owner.token, { propertyId: A, nombreArchivo: "a.csv", tabla: [["Fecha"], relleno] }, "POST"));
    expect(r.status).toBe(413);
    expect((await r.json()).code).toBe("payload_too_large");
  });
});

describe("rangos válidos que cruzan 15 meses calendario (CFO-05c)", () => {
  // La SQL (cfo_costos_leer -> cfo_validar_rango) valida los meses expandidos al día 1: 2025-07-01..2026-09-01 mide 428 días. El servicio parte la
  // lectura de costos en tramos de meses completos; el rango del usuario (≤ 400 días) debe responder 200 en todas las vistas que leen costos.
  it.each([
    ["400 días, 15 meses", "desde=2025-07-31&hasta=2026-09-03", ["2025-07-01", "2025-12-01", "2026-03-01", "2026-09-01"]],
    ["397 días, 15 meses", "desde=2025-01-30&hasta=2026-03-02", ["2025-01-01", "2025-08-01", "2026-03-01"]],
  ])("%s: /resumen y /estado-resultados responden 200 con los costos de TODOS los meses, sin duplicar", async (_n, qs, meses) => {
    const { ctx, app, url, A } = await construir();
    const t = ctx.staff.owner.token;
    const put = await app.request(url("costos"), authedJson(t, { costos: meses.map((m) => ({ propertyId: A, mes: m.slice(0, 7), concepto: "renta", montoCentavos: 100_000 })) }, "PUT"));
    expect(put.status, JSON.stringify(await put.clone().json())).toBe(200);
    const res = await app.request(url(`resumen?${qs}`), authedGet(t));
    expect(res.status).toBe(200);
    const fuente = (await res.json()).fuentes.find((f: { id: string }) => f.id === "costos_capturados");
    expect(fuente.disponible).toBe(true);
    expect(fuente.cobertura).toEqual({ desde: meses[0], hasta: meses[meses.length - 1] });
    const pyl = await app.request(url(`estado-resultados?${qs}`), authedGet(t));
    expect(pyl.status).toBe(200);
  });

  it("el borde: 401 días sigue siendo 422 y 14 meses calendario exactos (400 días) pasan en una sola lectura", async () => {
    const { ctx, app, url, repo } = await construir();
    const t = ctx.staff.owner.token;
    expect((await app.request(url("resumen?desde=2025-07-31&hasta=2026-09-04"), authedGet(t))).status).toBe(422);
    const antes = repo.llamadas.get("costosLeer") ?? 0;
    expect((await app.request(url("resumen?desde=2026-01-01&hasta=2027-02-04"), authedGet(t))).status).toBe(200);
    expect((repo.llamadas.get("costosLeer") ?? 0) - antes).toBe(1);
  });
});
