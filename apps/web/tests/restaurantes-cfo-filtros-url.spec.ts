// CFO-07 · filtros del CFO en la URL: atajos de rango, validación (máx. 400 días como el API), ida y vuelta URL <-> filtros y query del API.
import { describe, expect, it } from "vitest";
import { ATAJOS_RANGO, MAX_DIAS_CFO, atajoActivo, consultaApi, diasEntre, errorDeRango, escribirFiltros, etiquetaFecha, etiquetaRango, filtrosPorDefecto, granularidadAuto, hoyLocal, leerFiltros, sumarDias } from "../src/verticals/restaurantes/cfo/filtros-url.ts";

const HOY = "2026-09-28"; // lunes
const ID1 = "00000000-0000-4000-8000-0000000000a1";
const ID2 = "00000000-0000-4000-8000-0000000000a2";

describe("atajos de rango", () => {
  const rango = (id: string) => ATAJOS_RANGO.find((a) => a.id === id)!.rango(HOY);
  it("hoy, ayer, 7 d, 30 d, mes actual, mes anterior, trimestre y 12 meses", () => {
    expect(rango("hoy")).toEqual({ desde: "2026-09-28", hasta: "2026-09-28" });
    expect(rango("ayer")).toEqual({ desde: "2026-09-27", hasta: "2026-09-27" });
    expect(rango("7d")).toEqual({ desde: "2026-09-22", hasta: "2026-09-28" });
    expect(rango("30d")).toEqual({ desde: "2026-08-30", hasta: "2026-09-28" });
    expect(rango("mes")).toEqual({ desde: "2026-09-01", hasta: "2026-09-28" });
    expect(rango("mes_anterior")).toEqual({ desde: "2026-08-01", hasta: "2026-08-31" });
    expect(rango("trimestre")).toEqual({ desde: "2026-07-01", hasta: "2026-09-28" });
    expect(rango("12m")).toEqual({ desde: "2025-09-29", hasta: "2026-09-28" });
  });
  it("mes anterior cruza el año y respeta febrero", () => {
    expect(ATAJOS_RANGO.find((a) => a.id === "mes_anterior")!.rango("2026-01-15")).toEqual({ desde: "2025-12-01", hasta: "2025-12-31" });
    expect(ATAJOS_RANGO.find((a) => a.id === "mes_anterior")!.rango("2026-03-02")).toEqual({ desde: "2026-02-01", hasta: "2026-02-28" });
  });
  it("todos los atajos caben en el máximo de 400 días", () => {
    for (const a of ATAJOS_RANGO) {
      const r = a.rango(HOY);
      expect(errorDeRango(r.desde, r.hasta), a.id).toBeNull();
    }
  });
  it("atajoActivo reconoce el atajo exacto y si no, «personalizado»", () => {
    expect(atajoActivo("2026-09-22", "2026-09-28", HOY)).toBe("7d");
    expect(atajoActivo("2026-09-10", "2026-09-12", HOY)).toBe("personalizado");
  });
});

describe("validación del rango", () => {
  it("acepta 400 días y rechaza 401, fechas inválidas y desde > hasta", () => {
    expect(errorDeRango("2025-08-25", "2026-09-28")).toBeNull();
    expect(diasEntre("2025-08-25", "2026-09-28")).toBe(MAX_DIAS_CFO);
    expect(errorDeRango("2025-08-24", "2026-09-28")).toMatch(/400 días/);
    expect(errorDeRango("2026-02-30", "2026-03-01")).toMatch(/válidas/);
    expect(errorDeRango("2026-09-28", "2026-09-01")).toMatch(/posterior/);
    expect(errorDeRango("", "")).toMatch(/válidas/);
  });
});

describe("URL <-> filtros", () => {
  it("sin parámetros: 7 días, todas las sucursales, periodo anterior, vista total", () => {
    const f = leerFiltros(new URLSearchParams(), HOY);
    expect(f).toEqual({ desde: "2026-09-22", hasta: "2026-09-28", sucursales: null, comparar: "periodo_anterior", vista: "total" });
    expect(f).toEqual(filtrosPorDefecto(HOY));
  });
  it("ida y vuelta con sucursales, comparar y vista", () => {
    const f = { desde: "2026-09-01", hasta: "2026-09-10", sucursales: [ID1, ID2], comparar: "anio_anterior" as const, vista: "sucursal" as const };
    const sp = escribirFiltros(new URLSearchParams("otro=1"), f);
    expect(sp.get("otro")).toBe("1");
    expect(sp.get("sucursales")).toBe(`${ID1},${ID2}`);
    expect(sp.get("vista")).toBe("sucursal");
    expect(leerFiltros(new URLSearchParams(sp.toString()), HOY)).toEqual(f);
  });
  it("«Todas» no escribe sucursales y la vista total no escribe vista", () => {
    const sp = escribirFiltros(new URLSearchParams(`sucursales=${ID1}&vista=sucursal`), filtrosPorDefecto(HOY));
    expect(sp.has("sucursales")).toBe(false);
    expect(sp.has("vista")).toBe(false);
  });
  it("valores inválidos en la URL caen al defecto (nunca lanzan)", () => {
    const f = leerFiltros(new URLSearchParams("desde=basura&hasta=2026-09-01&comparar=hackeado&sucursales=<script>&vista=otra"), HOY);
    expect(f.desde).toBe("2026-09-22");
    expect(f.comparar).toBe("periodo_anterior");
    expect(f.sucursales).toBeNull();
    expect(f.vista).toBe("total");
    // Un rango de más de 400 días también cae al defecto.
    expect(leerFiltros(new URLSearchParams("desde=2020-01-01&hasta=2026-09-01"), HOY).desde).toBe("2026-09-22");
  });
  it("sucursales: solo UUID; basura, XSS y rutas se descartan (`abc,<script>,../x,t1`)", () => {
    for (const malo of ["abc,<script>,../x,t1", "abc", "<script>alert(1)</script>", "../../x", "t1,t2"]) expect(leerFiltros(new URLSearchParams({ sucursales: malo }), HOY).sucursales, malo).toBeNull();
    // Mezcla: se conserva lo válido, en minúsculas y sin duplicados.
    expect(leerFiltros(new URLSearchParams({ sucursales: `abc,${ID1.toUpperCase()},${ID1},../x` }), HOY).sucursales).toEqual([ID1]);
  });
  it("años fuera de 2000..2100 caen al rango por defecto, como el API", () => {
    expect(errorDeRango("1999-12-31", "2000-01-02")).toMatch(/válidas/);
    expect(errorDeRango("2100-12-30", "2101-01-02")).toMatch(/válidas/);
    expect(leerFiltros(new URLSearchParams("desde=0001-01-01&hasta=0001-01-05"), HOY).desde).toBe("2026-09-22");
    expect(errorDeRango("2000-01-01", "2000-01-10")).toBeNull();
  });
  it("más de 20 sucursales se ignora", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    expect(leerFiltros(new URLSearchParams({ sucursales: ids }), HOY).sucursales).toBeNull();
  });
});

describe("consulta del API y formato", () => {
  it("consultaApi lleva desde, hasta, comparar y sucursales (solo si no es «Todas»)", () => {
    const f = { ...filtrosPorDefecto(HOY), sucursales: [ID1] };
    expect(consultaApi(f, { granularidad: "dia", vacio: undefined, orden: "" }).toString()).toBe(`desde=2026-09-22&hasta=2026-09-28&comparar=periodo_anterior&sucursales=${ID1}&granularidad=dia`);
    expect(consultaApi(filtrosPorDefecto(HOY)).has("sucursales")).toBe(false);
  });
  it("granularidad automática según el largo del rango", () => {
    expect(granularidadAuto({ desde: "2026-09-01", hasta: "2026-09-30" })).toBe("dia");
    expect(granularidadAuto({ desde: "2026-07-01", hasta: "2026-09-30" })).toBe("semana");
    expect(granularidadAuto({ desde: "2025-09-29", hasta: "2026-09-28" })).toBe("mes");
  });
  it("fechas a mano, sin toLocale: «7 oct 2026», rango «1 sep al 10 sep 2026», hoy local", () => {
    expect(etiquetaFecha("2026-10-07")).toBe("7 oct 2026");
    expect(etiquetaFecha("2026-10-07", false)).toBe("7 oct");
    expect(etiquetaRango("2026-09-01", "2026-09-10")).toBe("1 sep al 10 sep 2026");
    expect(etiquetaRango("2026-09-01", "2026-09-01")).toBe("1 sep 2026");
    expect(hoyLocal(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(sumarDias("2026-02-28", 1)).toBe("2026-03-01");
  });
});
