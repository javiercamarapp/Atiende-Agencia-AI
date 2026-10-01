// Rn-03 -- HTTP real (app.request) del reporte de ocupación e ingresos: roles finos,
// periodo, prorrateo entre meses sin doble conteo, filtros, CSV/PDF y validación.
import { describe, expect, it } from "vitest";
import { InMemoryRentasReportesRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

interface GrupoJson {
  clave: string;
  etiqueta: string;
  noches_ocupadas: number;
  ingreso_bruto_centavos: number;
}
interface ReporteJson {
  moneda: string;
  financiero_disponible: boolean;
  periodo: { desde: string; hasta: string };
  totales: { noches_ocupadas: number; ingreso_bruto_centavos: number; llegadas: number };
  por_unidad: GrupoJson[];
  por_propietario: GrupoJson[];
  por_canal: GrupoJson[];
  por_mes: GrupoJson[];
  advertencias: { reservas_sin_movimiento_financiero: number };
}

const get = (token: string) => authedJson(token, undefined, {}, "GET");
const OWNER = "11111111-1111-4111-8111-111111111111";

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const repo = new InMemoryRentasReportesRepository();
  repo.unidades.push(
    { id: ctx.unidadId, nombre: "Depa de Prueba", ownerId: OWNER, ownerNombre: "Ana" },
    { id: "22222222-2222-4222-8222-222222222222", nombre: "Casa Dos", ownerId: null, ownerNombre: null },
  );
  const fin = (bruto: number) => ({ moneda: "MXN", brutoCentavos: bruto, comisionCanalCentavos: Math.round(bruto * 0.1), comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: bruto - Math.round(bruto * 0.1) });
  // cruza marzo/abril: 6 noches, $1,000.03
  repo.reservas.push({ ocupacionId: "r1", unidadId: ctx.unidadId, canal: "airbnb", inicio: "2026-03-28", fin: "2026-04-03", creadaEn: "2026-01-01", financiero: fin(100003) });
  repo.reservas.push({ ocupacionId: "r2", unidadId: "22222222-2222-4222-8222-222222222222", canal: "manual", inicio: "2026-03-10", fin: "2026-03-12", creadaEn: "2026-01-02", financiero: null });
  const app = buildApp({ ...ctx.deps, rentasReportesRepo: () => repo });
  return { ctx, app, repo, url: `/rentas/${ctx.propertyId}/reportes/ocupacion-ingresos` };
}

describe("GET /rentas/:propertyId/reportes/ocupacion-ingresos", () => {
  it("devuelve todas las agrupaciones, prorratea el cruce de meses y no cuenta la reserva dos veces", async () => {
    const { ctx, app, url } = await preparar();
    const res = await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01`, get(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReporteJson;
    expect(body.moneda).toBe("MXN");
    expect(body.financiero_disponible).toBe(true);
    expect(body.totales.noches_ocupadas).toBe(8);
    expect(body.totales.ingreso_bruto_centavos).toBe(100003);
    expect(body.totales.llegadas).toBe(2);
    const meses = Object.fromEntries(body.por_mes.map((m: GrupoJson) => [m.clave, m]));
    expect(meses["2026-03"].noches_ocupadas).toBe(6); // 4 de r1 + 2 de r2
    expect(meses["2026-04"].noches_ocupadas).toBe(2);
    expect(meses["2026-03"].ingreso_bruto_centavos + meses["2026-04"].ingreso_bruto_centavos).toBe(100003);
    expect(body.por_canal.map((c: GrupoJson) => c.clave).sort()).toEqual(["airbnb", "manual"]);
    expect(body.por_propietario.map((p: GrupoJson) => p.etiqueta).sort()).toEqual(["Ana", "Sin propietario"]);
    expect(body.advertencias.reservas_sin_movimiento_financiero).toBe(1);
  });

  it("sin desde/hasta usa el mes en curso (periodo calendario completo, fin exclusivo)", async () => {
    const { ctx, app, url } = await preparar();
    const body = (await (await app.request(url, get(ctx.staff.adminGestora.token))).json()) as ReporteJson;
    expect(body.periodo.desde).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.periodo.hasta).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.periodo.hasta > body.periodo.desde).toBe(true);
  });

  it("el contador (lectura de finanzas) puede; operador de calendario y limpieza reciben 403", async () => {
    const { ctx, app, url } = await preparar();
    const q = `${url}?desde=2026-03-01&hasta=2026-04-01`;
    expect((await app.request(q, get(ctx.staff.contador.token))).status).toBe(200);
    expect((await app.request(q, get(ctx.staff.operadorSoloCalendario.token))).status).toBe(403);
    expect((await app.request(q, get(ctx.staff.limpieza.token))).status).toBe(403);
    expect((await app.request(q, { method: "GET" })).status).toBe(401);
  });

  it("filtra por canal y por propietario", async () => {
    const { ctx, app, url } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const porCanal = (await (await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01&canal=manual`, get(t))).json()) as ReporteJson;
    expect(porCanal.totales.noches_ocupadas).toBe(2);
    const porOwner = (await (await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01&propietario_id=${OWNER}`, get(t))).json()) as ReporteJson;
    expect(porOwner.totales.noches_ocupadas).toBe(6);
    expect(porOwner.por_unidad).toHaveLength(1);
  });

  it("CSV: descarga con BOM y encabezados; PDF: application/pdf", async () => {
    const { ctx, app, url } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const csv = await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01&formato=csv&agrupar=mes`, get(t));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("reporte-ocupacion-ingresos_2026-03-01_2026-05-01.csv");
    const crudo = new Uint8Array(await csv.arrayBuffer());
    expect([...crudo.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 para que Excel detecte la codificacion
    const texto = new TextDecoder().decode(crudo);
    expect(texto).toContain("2026-04,0,2");
    const pdf = await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01&formato=pdf`, get(t));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 8))).toBe("%PDF-1.4");
  });

  it("valida parámetros: formato, agrupar, fechas, uuid, periodo enorme o invertido, desde sin hasta", async () => {
    const { ctx, app, url } = await preparar();
    const t = ctx.staff.adminGestora.token;
    for (const q of ["formato=xls", "agrupar=zona", "desde=2026-3-1&hasta=2026-04-01", "desde=2026-02-30&hasta=2026-03-10", "desde=2026-03-10&hasta=2026-03-01", "desde=2020-01-01&hasta=2026-01-01", "desde=2026-03-01", "unidad_id=no-es-uuid", "propietario_id=x", "canal=A%20B&desde=2026-03-01&hasta=2026-04-01"]) {
      const res = await app.request(`${url}?${q}`, get(t));
      expect(res.status, q).toBe(400);
    }
  });

  it("base sin movimiento financiero legible: responde 200 con financiero_disponible=false y sin montos", async () => {
    const { ctx, repo, app, url } = await preparar();
    repo.financieroDisponible = false;
    const body = (await (await app.request(`${url}?desde=2026-03-01&hasta=2026-05-01`, get(ctx.staff.adminGestora.token))).json()) as ReporteJson;
    expect(body.financiero_disponible).toBe(false);
    expect(body.totales.ingreso_bruto_centavos).toBe(0);
    expect(body.totales.noches_ocupadas).toBe(8);
  });
});
