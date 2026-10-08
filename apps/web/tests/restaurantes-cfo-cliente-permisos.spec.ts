// CFO-07 · permisos (ocultar por rol, fail-closed), cliente HTTP del CFO (403 / 404 / 503 / disponible:false) y enlaces de las acciones de «Lo más importante».
import { describe, expect, it, vi } from "vitest";
import { MENSAJE_SIN_ACCESO_CFO, CfoExportarNoDisponibleError, CfoSinAccesoError, descargarExportacionCfo, fetchAlcance, fetchPedidos, fetchResumen, guardarCostos, guardarConfig, urlExportarCfo, type ContextoCfo } from "../src/verticals/restaurantes/cfo/cfo-client.ts";
import { aplicarDrill, describirFiltro, enlaceDeAccion, filtroDeParams, pedidosAbiertos, quitarDrill } from "../src/verticals/restaurantes/cfo/contexto.ts";
import { filtrosPorDefecto } from "../src/verticals/restaurantes/cfo/filtros-url.ts";
import { PAGINAS_CFO } from "../src/verticals/restaurantes/cfo/paginas.ts";
import { resaltarNarrativa } from "../src/verticals/restaurantes/cfo/CfoResumen.tsx";
import { puedeEn } from "../src/verticals/restaurantes/lib/permisos.ts";
import { VozNoDisponibleError } from "../src/verticals/restaurantes/lib/voz-client.ts";

describe("permisos del CFO por rol (fail-closed)", () => {
  const ACCIONES = ["cfo.ver", "cfo.capturar", "cfo.importar_sr", "cfo.exportar"] as const;
  it("owner y admin tienen todas las acciones del CFO", () => {
    for (const rol of ["owner", "admin"]) for (const a of ACCIONES) expect(puedeEn(rol, a), `${rol} ${a}`).toBe(true);
  });
  it("staff, repartidor, roles desconocidos, vacío, null y undefined NO tienen ninguna", () => {
    for (const rol of ["staff", "repartidor", "finanzas", "contador", "", "OWNER", "Owner ", null, undefined]) for (const a of ACCIONES) expect(puedeEn(rol, a), `${String(rol)} ${a}`).toBe(false);
  });
});

function api(respuestas: Record<string, { status: number; cuerpo?: unknown }>): { ctx: ContextoCfo; llamadas: string[] } {
  const llamadas: string[] = [];
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    llamadas.push(`${init?.method ?? "GET"} ${u}`);
    const clave = Object.keys(respuestas).find((k) => u.includes(k)) ?? "";
    const r = respuestas[clave] ?? { status: 200, cuerpo: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(), json: async () => r.cuerpo ?? {}, blob: async () => new Blob(["x"]), text: async () => JSON.stringify(r.cuerpo ?? {}) } as unknown as Response;
  });
  return { ctx: { fetchImpl: f as unknown as typeof fetch, apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1" }, llamadas };
}

describe("cliente del CFO", () => {
  const F = filtrosPorDefecto("2026-09-28");
  it("403 -> CfoSinAccesoError «Tu rol no tiene acceso al CFO»", async () => {
    const { ctx } = api({ "/resumen": { status: 403, cuerpo: { message: "no" } } });
    const err = await fetchResumen(ctx, F, "impacto").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfoSinAccesoError);
    expect((err as Error).message).toBe(MENSAJE_SIN_ACCESO_CFO);
  });
  it("404 y 503 (base sin migrar) y disponible:false -> VozNoDisponibleError, no un error genérico", async () => {
    for (const status of [404, 503]) {
      const { ctx } = api({ "/resumen": { status } });
      expect(await fetchResumen(ctx, F, "impacto").catch((e: unknown) => e)).toBeInstanceOf(VozNoDisponibleError);
    }
    const { ctx } = api({ "/alcance": { status: 200, cuerpo: { disponible: false } } });
    expect(await fetchAlcance(ctx).catch((e: unknown) => e)).toBeInstanceOf(VozNoDisponibleError);
  });
  it("otros errores conservan el mensaje del servidor (500)", async () => {
    const { ctx } = api({ "/resumen": { status: 500, cuerpo: { message: "Falló la consulta." } } });
    expect(((await fetchResumen(ctx, F, "impacto").catch((e: unknown) => e)) as Error).message).toContain("Falló la consulta.");
  });
  it("pide el filtro de pedidos como JSON, con cursor y límite, y manda sucursales solo si no es «Todas»", async () => {
    const { ctx, llamadas } = api({ "/pedidos": { status: 200, cuerpo: { pedidos: [], cursor: null, limite: 25, disponible: true } } });
    await fetchPedidos(ctx, { ...F, sucursales: ["s1"] }, { filtro: { status: "cancelado", con_descuento: true }, cursor: "2026-09-27|1010" });
    const u = new URL(llamadas[0]!.replace("GET ", ""));
    expect(u.pathname).toBe("/v1/restaurantes/p1/admin/cfo/pedidos");
    expect(JSON.parse(u.searchParams.get("filtro")!)).toEqual({ status: "cancelado", con_descuento: true });
    expect(u.searchParams.get("cursor")).toBe("2026-09-27|1010");
    expect(u.searchParams.get("sucursales")).toBe("s1");
    expect(u.searchParams.get("limite")).toBe("25");
    const { ctx: c2, llamadas: l2 } = api({ "/pedidos": { status: 200, cuerpo: { disponible: true } } });
    await fetchPedidos(c2, F, { filtro: {} });
    expect(new URL(l2[0]!.replace("GET ", "")).searchParams.has("filtro")).toBe(false);
  });
  it("PUT /costos manda { costos } y PUT /config manda solo los cambios", async () => {
    const { ctx, llamadas } = api({ "/costos": { status: 200, cuerpo: { guardados: 1, ids: ["a"], disponible: true } }, "/config": { status: 200, cuerpo: { disponible: true } } });
    await guardarCostos(ctx, [{ propertyId: null, mes: "2026-09-01", concepto: "renta", montoCentavos: 800_000, pct: null, nota: null }]);
    await guardarConfig(ctx, { ivaPct: 8, comisionTerminalPct: null });
    expect(llamadas).toEqual(["PUT https://api.test/v1/restaurantes/p1/admin/cfo/costos", "PUT https://api.test/v1/restaurantes/p1/admin/cfo/config"]);
    const f = ctx.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } };
    expect(JSON.parse(f.mock.calls[0]![1].body as string)).toEqual({ costos: [{ propertyId: null, mes: "2026-09-01", concepto: "renta", montoCentavos: 800_000, pct: null, nota: null }] });
    expect(JSON.parse(f.mock.calls[1]![1].body as string)).toEqual({ ivaPct: 8, comisionTerminalPct: null });
  });
  it("403 al ESCRIBIR conserva el mensaje del servidor (el rol ve el CFO pero no puede capturar eso); en una lectura es «sin acceso»", async () => {
    const { ctx } = api({ "/costos": { status: 403, cuerpo: { message: "Solo el dueño o un administrador de toda la organización puede capturar costos de la organización." } } });
    const err = (await guardarCostos(ctx, []).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(CfoSinAccesoError);
    expect(err.message).toContain("Solo el dueño o un administrador de toda la organización");
  });
  it("422 al guardar un costo trae el mensaje del servidor", async () => {
    const { ctx } = api({ "/costos": { status: 422, cuerpo: { code: "validation_error", message: "costos[0].concepto no es válido." } } });
    const err = (await guardarCostos(ctx, []).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("costos[0].concepto no es válido.");
  });
  it("exportar: arma la URL de CFO-06 (formato, vista y filtros); 404 -> no disponible; 403 -> sin acceso", async () => {
    const f = { ...F, sucursales: ["s1", "s2"] };
    const url = new URL(urlExportarCfo({ apiBaseUrl: "https://api.test", propertyId: "p1" }, f, "estado_resultados", "xlsx"));
    expect(url.pathname).toBe("/v1/restaurantes/p1/admin/cfo/exportar");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ formato: "xlsx", vista: "estado_resultados", desde: F.desde, hasta: F.hasta, comparar: "periodo_anterior", sucursales: "s1,s2" });
    expect(await descargarExportacionCfo(api({ "/exportar": { status: 404 } }).ctx, F, "ventas", "pdf").catch((e: unknown) => e)).toBeInstanceOf(CfoExportarNoDisponibleError);
    expect(await descargarExportacionCfo(api({ "/exportar": { status: 403 } }).ctx, F, "ventas", "pdf").catch((e: unknown) => e)).toBeInstanceOf(CfoSinAccesoError);
    const ok = await descargarExportacionCfo(api({ "/exportar": { status: 200 } }).ctx, F, "ventas", "pdf");
    expect(ok.nombre).toBe("atiende-cfo-ventas.pdf");
  });
});

describe("registro de pestañas y enlaces de «Lo más importante»", () => {
  const F = { ...filtrosPorDefecto("2026-09-28"), comparar: "anio_anterior" as const };
  const DISPONIBLES = new Set(PAGINAS_CFO.map((p) => p.slug));
  it("el registro trae las 4 pestañas de CFO-07, con slug único y vista de exportación", () => {
    expect(PAGINAS_CFO.map((p) => p.slug)).toEqual(["resumen", "ventas", "sucursales", "estado-resultados"]);
    expect(new Set(PAGINAS_CFO.map((p) => p.slug)).size).toBe(PAGINAS_CFO.length);
    for (const p of PAGINAS_CFO) expect(p.vistaExportacion, p.slug).not.toBeNull();
  });
  it("enlaza a una pestaña existente con la sucursal, el rango y el filtro de pedidos de la acción", () => {
    const to = enlaceDeAccion("/cfo/ventas?sucursal=s4&desde=2026-09-21&hasta=2026-09-27&es_compensacion=1", "/restaurantes/demo", F, DISPONIBLES)!;
    const u = new URL(to, "https://x.test");
    expect(u.pathname).toBe("/restaurantes/demo/cfo/ventas");
    expect(Object.fromEntries(u.searchParams)).toEqual({ desde: "2026-09-21", hasta: "2026-09-27", comparar: "anio_anterior", sucursales: "s4", pedidos: "1", es_compensacion: "1" });
  });
  it("una acción hacia una pestaña que no existe (CFO-08) NO se enlaza", () => {
    for (const ruta of ["/cfo/softrestaurant?sucursal=s1", "/cfo/operacion?sucursal=s1", "/cfo/platillos", "/otra/cosa", "https://malo.test/x"]) {
      expect(enlaceDeAccion(ruta, "/restaurantes/demo", F, DISPONIBLES), ruta).toBeNull();
    }
  });
  it("el drill-down vive en la URL: aplicar, leer y quitar", () => {
    const sp = aplicarDrill(new URLSearchParams("desde=2026-09-01"), { status: "cancelado", hora_local: 14, con_descuento: true });
    expect(pedidosAbiertos(sp)).toBe(true);
    expect(filtroDeParams(sp)).toEqual({ status: "cancelado", hora_local: 14, con_descuento: true });
    const sin = quitarDrill(sp);
    expect(pedidosAbiertos(sin)).toBe(false);
    expect(sin.toString()).toBe("desde=2026-09-01");
    // Llaves que el API no admite se ignoran.
    expect(filtroDeParams(new URLSearchParams("pedidos=1&customer_name=Ana&hora_local=99&dow_negocio=3"))).toEqual({ dow_negocio: 3 });
    expect(describirFiltro({ status: "cancelado", dow_negocio: 6, hora_local: 14 })).toEqual(["Cancelados", "Día: sábado", "Hora: 14 h"]);
  });
});

describe("resumen narrado: cifras resaltadas, marcas internas fuera", () => {
  const refs = { ventas_netas: "$238,185.80", pedidos: "837", variacion: "4.9 %" };
  it("resalta la cifra que precede a la marca y quita la marca", () => {
    const p = resaltarNarrativa("El agente vendió $238,185.80 [ventas_netas] en 837 [pedidos] pedidos, 4.9 % [variacion] más.", refs);
    expect(p).toEqual(["El agente vendió ", { cifra: "$238,185.80", ref: "ventas_netas" }, " en ", { cifra: "837", ref: "pedidos" }, " pedidos, ", { cifra: "4.9 %", ref: "variacion" }, " más."]);
  });
  it("una marca sin valor pegado se descarta sin inventar nada", () => {
    expect(resaltarNarrativa("Las compensaciones se duplicaron [hallazgo_1], fin.", { hallazgo_1: "$468.60" })).toEqual(["Las compensaciones se duplicaron", ", fin."]);
    expect(resaltarNarrativa("Sin marcas.", refs)).toEqual(["Sin marcas."]);
  });
});
