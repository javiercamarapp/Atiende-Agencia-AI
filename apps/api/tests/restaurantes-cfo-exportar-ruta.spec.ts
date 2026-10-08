// CFO-06 · ruta `GET /v1/restaurantes/:propertyId/admin/cfo/exportar`: roles por acción, alcance (el admin acotado exporta solo lo suyo y no recibe «No asignado»),
// validación de query, bitácora ANTES de responder (con vista, formato y rango; si falla, 503 y ningún archivo), encabezados de descarga sin datos personales,
// tope por persona y respuesta honesta con la base sin migrar.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { InMemoryCfoRepository } from "@atiende/domain-restaurantes/cfo";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { SUCURSALES_PM_SINTETICAS, costosCapturadosSinteticos, generarDatasetSintetico, resumirClientes } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { textoDelPdf } from "./support/pdf-text.ts";

const D = generarDatasetSintetico({ diasRango: 120 });
const [T1, T2] = SUCURSALES_PM_SINTETICAS.map((s) => s.propertyId) as [string, string];
const CLIENTES = resumirClientes(D.pedidos.filter((p) => p.propertyId === T1 || p.propertyId === T2), D.desde, D.hasta);
const Q = "desde=2026-08-31&hasta=2026-09-27";

type Fila = { propertyId: string | null };
function remap<T extends Fila>(filas: readonly T[], mapa: ReadonlyMap<string, string>): T[] {
  return filas.filter((f) => f.propertyId === null || mapa.has(f.propertyId)).map((f) => (f.propertyId === null ? f : { ...f, propertyId: mapa.get(f.propertyId)! }));
}

async function construir(op: { m083?: boolean; falloBitacora?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const A = ctx.propertyIdA;
  const B = ctx.propertyIdB;
  const mapa = new Map([[T1, A], [T2, B]]);
  const repo = new InMemoryCfoRepository({
    sucursales: [A, B],
    ...(op.m083 === false ? { migraciones: { m083: false } } : {}),
    dataset: {
      ventasDiarias: remap(D.ventasDiarias, mapa), cortesias: remap(D.cortesias, mapa), ventasHora: remap(D.ventasHora, mapa), productos: remap(D.productos, mapa), agenteDiario: remap(D.agenteDiario, mapa),
      comandasPos: remap(D.comandasPos, mapa), clientesResumen: remap(CLIENTES, mapa), agotados: remap(D.agotados, mapa),
      entregasPercentiles: [
        { propertyId: A, alcance: "sucursal", entregados: 100, p50Min: 35, p90Min: 52 },
        { propertyId: B, alcance: "sucursal", entregados: 80, p50Min: 38, p90Min: 57 },
        { propertyId: null, alcance: "conjunto", entregados: 180, p50Min: 36, p90Min: 55 },
      ],
      cobertura: [A, B].map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" })),
    },
  });
  if (op.m083 !== false) for (const mes of ["2026-08-01", "2026-09-01"]) for (const c of costosCapturadosSinteticos(mes)) if (mapa.has(c.propertyId as string)) await repo.costoGuardar({ organizationId: ctx.organizationId, propertyId: mapa.get(c.propertyId as string)!, mes: c.mes, concepto: c.concepto, montoCentavos: c.montoCentavos, pct: c.pct, nota: null });
  const llamadas: Array<Parameters<typeof repo.registrarExportacion>[0]> = [];
  const original = repo.registrarExportacion.bind(repo);
  repo.registrarExportacion = async (e) => {
    llamadas.push(e);
    if (op.falloBitacora) throw new Error("la base no responde");
    return original(e);
  };
  const deps: AppDeps = { ...ctx.deps, cfoRestaurantesRepo: () => repo };
  const app = buildApp(deps);
  const url = (query: string, propertyId = A) => `/v1/restaurantes/${propertyId}/admin/cfo/exportar?${query}`;
  return { ctx, repo, app, url, A, B, llamadas };
}

async function hojas(r: Response): Promise<{ zip: JSZip; nombres: string[] }> {
  const zip = await JSZip.loadAsync(new Uint8Array(await r.arrayBuffer()));
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  return { zip, nombres: [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!) };
}

describe("GET /admin/cfo/exportar", () => {
  it("owner: 200 con un .xlsx real (zip) y encabezados de descarga sin datos personales", async () => {
    const { ctx, app, url } = await construir();
    const r = await app.request(url(`formato=xlsx&${Q}`), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const cd = r.headers.get("content-disposition")!;
    expect(cd).toMatch(/^attachment; filename="cfo-[0-9a-f]{8}-2026-08-31-2026-09-27-todas\.xlsx"$/);
    expect(cd).not.toMatch(/@|Prolongaci|Montejo/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { nombres } = await hojas(r);
    expect(nombres).toContain("Estado de resultados");
    expect(nombres.filter((n) => n.startsWith("Suc "))).toHaveLength(2);
  });

  it("owner: PDF real, de hasta 40 páginas, con el aviso de no sustitución", async () => {
    const { ctx, app, url } = await construir();
    const r = await app.request(url(`formato=pdf&vista=completo&${Q}`), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toMatch(/\.pdf"$/);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(textoDelPdf(bytes).includes("no sustituye a su contabilidad")).toBe(true);
  });

  it("admin de toda la organización exporta igual; admin acotado exporta solo lo suyo y NO recibe «No asignado»", async () => {
    const { ctx, app, url, A } = await construir();
    expect((await app.request(url(`formato=xlsx&${Q}`), authedGet(ctx.staff.admin.token))).status).toBe(200);
    const dueno = await hojas(await app.request(url(`formato=xlsx&${Q}`), authedGet(ctx.staff.owner.token)));
    expect((await dueno.zip.file("xl/worksheets/sheet3.xml")!.async("string")).includes("No asignado")).toBe(true);
    const r = await app.request(url(`formato=xlsx&${Q}`), authedGet(ctx.staff.adminSucursalA.token));
    expect(r.status).toBe(200);
    // «todas» es solo para la organización completa: el admin acotado lleva otro rótulo.
    expect(r.headers.get("content-disposition")).toMatch(/-acotado\.xlsx"$/);
    const acotado = await hojas(r);
    expect(acotado.nombres.filter((n) => n.startsWith("Suc "))).toHaveLength(1);
    for (const n of acotado.nombres) {
      const i = acotado.nombres.indexOf(n) + 1;
      const xml = await acotado.zip.file(`xl/worksheets/sheet${i}.xml`)!.async("string");
      expect(xml.includes("No asignado"), n).toBe(false);
    }
    // Sucursal ajena (la otra de la misma organización) -> el mismo 403 sin revelar nada.
    const ajena = await app.request(url(`formato=xlsx&${Q}&sucursales=${ctx.propertyIdB}`), authedGet(ctx.staff.adminSucursalA.token));
    expect(ajena.status).toBe(403);
    expect((await ajena.json() as { message: string }).message).toBe("No tienes acceso a esta sucursal.");
    expect((await app.request(url(`formato=xlsx&${Q}&sucursales=${A}`), authedGet(ctx.staff.adminSucursalA.token))).status).toBe(200);
  });

  it("staff y repartidor: 403 (acción cfo.exportar); otra organización: 403; sin sesión: 401; y nunca se registra bitácora", async () => {
    const { ctx, app, url, llamadas } = await construir();
    for (const t of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(url(`formato=xlsx&${Q}`), authedGet(t))).status).toBe(403);
    }
    expect((await app.request(url(`formato=xlsx&${Q}`))).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it("la bitácora se llama con vista, formato, rango y alcance; «completo» se registra como resumen y «estado-resultados» como estado_resultados", async () => {
    const { ctx, app, url, llamadas, A } = await construir();
    const tok = ctx.staff.owner.token;
    await app.request(url(`formato=xlsx&${Q}`), authedGet(tok));
    await app.request(url(`formato=pdf&vista=estado-resultados&${Q}`), authedGet(tok));
    await app.request(url(`formato=xlsx&vista=sucursales&${Q}&sucursales=${A}`), authedGet(tok));
    expect(llamadas.map((l) => [l.vista, l.formato, l.desde, l.hasta, l.propertyIds])).toEqual([
      ["resumen", "xlsx", "2026-08-31", "2026-09-27", null],
      ["estado_resultados", "pdf", "2026-08-31", "2026-09-27", null],
      ["sucursales", "xlsx", "2026-08-31", "2026-09-27", [A]],
    ]);
    expect(llamadas[0]!.organizationId).toBe(ctx.organizationId);
  });

  it("si la bitácora falla NO se entrega el archivo: 503 con mensaje y sin cuerpo de archivo", async () => {
    const { ctx, app, url, llamadas } = await construir({ falloBitacora: true });
    for (const formato of ["xlsx", "pdf"]) {
      const r = await app.request(url(`formato=${formato}&${Q}`), authedGet(ctx.staff.owner.token));
      expect(r.status).toBe(503);
      expect(r.headers.get("content-disposition")).toBeNull();
      expect(r.headers.get("content-type")).toMatch(/json/);
      expect(JSON.stringify(await r.json())).toMatch(/no se entrega el archivo/);
    }
    expect(llamadas).toHaveLength(2); // se intentó registrar antes de responder
  });

  it("base sin la migración 083 (la bitácora no existe): 503 y nada se descarga", async () => {
    const { ctx, app, url } = await construir({ m083: false });
    const r = await app.request(url(`formato=xlsx&${Q}`), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(503);
    expect(r.headers.get("content-disposition")).toBeNull();
  });

  it.each([
    ["sin formato", Q],
    ["formato inválido", `formato=csv&${Q}`],
    ["vista inválida", `formato=xlsx&vista=todo&${Q}`],
    ["sin fechas", "formato=xlsx"],
    ["fecha inválida", "formato=xlsx&desde=2026-02-30&hasta=2026-03-05"],
    ["más de 400 días", "formato=xlsx&desde=2026-01-01&hasta=2027-02-05"],
    ["id de sucursal", `formato=xlsx&${Q}&sucursales=hola`],
  ])("validación: %s -> 422 y sin bitácora", async (_n, query) => {
    const { ctx, app, url, llamadas } = await construir();
    expect((await app.request(url(query), authedGet(ctx.staff.owner.token))).status).toBe(422);
    expect(llamadas).toHaveLength(0);
  });

  it("tope por persona: la 7.ª exportación del minuto da 429", async () => {
    const { ctx, app, url } = await construir();
    const estados: number[] = [];
    for (let i = 0; i < 7; i += 1) estados.push((await app.request(url(`formato=xlsx&vista=resumen&${Q}`), authedGet(ctx.staff.owner.token))).status);
    expect(estados.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(estados[6]).toBe(429);
  });
});
