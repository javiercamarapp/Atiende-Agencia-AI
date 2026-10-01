import { describe, expect, it, vi } from "vitest";
import { descargarReporte, fetchReporte, formatearMoneda, formatearOcupacion } from "../src/verticals/rentas/lib/reportes-client.ts";

const METRICAS = { llegadas: 1, noches_ocupadas: 6, noches_disponibles: 61, ocupacion_basis_points: 984, ingreso_bruto_centavos: 100003, comision_canal_centavos: 16000, comision_gestor_centavos: 0, gastos_centavos: 0, impuestos_centavos: 0, neto_centavos: 84003, adr_centavos: 16667 };
const WIRE = {
  periodo: { desde: "2026-03-01", hasta: "2026-05-01" },
  moneda: "MXN",
  financiero_disponible: true,
  totales: METRICAS,
  por_unidad: [{ clave: "u1", etiqueta: "Casa Mar", ...METRICAS }],
  por_propietario: [],
  por_canal: [{ clave: "airbnb", etiqueta: "airbnb", ...METRICAS, noches_disponibles: null, ocupacion_basis_points: null }],
  por_mes: [],
  advertencias: { reservas_sin_movimiento_financiero: 1, reservas_moneda_distinta: 0, noches_solapadas_omitidas: 2, reservas_duplicadas_omitidas: 0 },
};

describe("reportes-client", () => {
  it("pide el periodo y mapea snake_case a camelCase", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/p1/reportes/ocupacion-ingresos?desde=2026-03-01&hasta=2026-05-01");
      return new Response(JSON.stringify(WIRE), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchReporte(fetchImpl, "http://api.local", "tok", "p1", { desde: "2026-03-01", hasta: "2026-05-01" });
    expect(r.desde).toBe("2026-03-01");
    expect(r.totales).toMatchObject({ nochesOcupadas: 6, ingresoBrutoCentavos: 100003, ocupacionBasisPoints: 984 });
    expect(r.grupos.canal[0]).toMatchObject({ clave: "airbnb", nochesDisponibles: null });
    expect(r.advertencias).toEqual({ reservasSinMovimientoFinanciero: 1, reservasMonedaDistinta: 0, nochesSolapadasOmitidas: 2, reservasDuplicadasOmitidas: 0 });
  });

  it("sin periodo no manda desde/hasta (el servidor usa el mes en curso)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/p1/reportes/ocupacion-ingresos");
      return new Response(JSON.stringify(WIRE), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchReporte(fetchImpl, "http://api.local", "tok", "p1");
  });

  it("descarga CSV/PDF con formato y agrupación en la URL; un 403 es un error legible", async () => {
    const urls: string[] = [];
    const ok = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("x", { status: 200 });
    }) as unknown as typeof fetch;
    await descargarReporte(ok, "http://api.local", "tok", "p1", { desde: "2026-03-01", hasta: "2026-04-01", agrupar: "mes" }, "csv");
    expect(urls[0]).toBe("http://api.local/rentas/p1/reportes/ocupacion-ingresos?desde=2026-03-01&hasta=2026-04-01&agrupar=mes&formato=csv");
    const denegado = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(descargarReporte(denegado, "http://api.local", "tok", "p1", {}, "pdf")).rejects.toThrow(/permiso/);
  });

  it("formatea moneda y ocupación sin punto flotante en centavos", () => {
    expect(formatearMoneda(100003, "MXN")).toBe("$1,000.03 MXN");
    expect(formatearMoneda(-5, "MXN")).toBe("-$0.05 MXN");
    expect(formatearOcupacion(7550)).toBe("75.5%");
    expect(formatearOcupacion(null)).toBe("—");
  });
});
