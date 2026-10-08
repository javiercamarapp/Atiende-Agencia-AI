// @vitest-environment jsdom
//
// <CfoPlatillos /> y <MatrizDispersion />: ranking por unidades o ingreso, mix por categoría, matriz con cuadrantes «sin margen», canasta con soporte y lift,
// efecto de promociones rotulado «estimado», agotados de hoy con la venta en riesgo (reloj fijo) y estados. Datos SINTÉTICOS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductosVista } from "@atiende/domain-restaurantes/cfo";
import { CfoPlatillos, rankingsDe } from "../src/verticals/restaurantes/cfo/CfoPlatillos.tsx";
import { crearApiCfo, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";
import { click } from "./test-utils/render.tsx";

const b = bancoCfoB();
const listo = () => b.esperar(() => b.q("[data-testid=cfo-platillos] [data-testid=chart-card]") !== null, "platillos pintados");

// El CI corre a cualquier hora: «hoy» es un miércoles 12:00 de Mérida (18:00 UTC).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T18:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("<CfoPlatillos />", () => {
  it("trae ranking, mix por categoría, matriz, canasta, ticket por número de productos, promociones y agotados", async () => {
    await b.pintar(CfoPlatillos, crearApiCfo());
    await listo();
    const titulos = b.qa("[data-testid=chart-card] h3").map((h) => h.textContent);
    expect(titulos).toEqual(["Más y menos vendidos", "Mix por categoría", "Popularidad × ingreso", "Canasta: lo que se pide junto", "Ticket por número de productos", "Efecto de las promociones", "Agotados hoy"]);
    expect(b.q("[data-testid=matriz-dispersion] svg")!.getAttribute("aria-label")).toMatch(/Estrella: .*Taco al pastor/);
    expect(b.q("[data-testid=platillos-sin-margen]")!.textContent).toContain("Aún no hay margen por platillo");
    expect(b.q("[data-testid=matriz-sin-margen]")!.textContent).toContain("Sin margen hasta capturar costo por platillo");
  });

  it("el conmutador cambia el ranking de unidades a ingreso", async () => {
    const base = await respuestaBase<ProductosVista>("/productos");
    await b.pintar(CfoPlatillos, crearApiCfo());
    await listo();
    const porUnidades = rankingsDe(base.matriz, "unidades").top.map((p) => p.nombre);
    const porIngreso = rankingsDe(base.matriz, "ingreso").top.map((p) => p.nombre);
    expect(b.q("[data-testid=ranking-top]")!.textContent).toContain(porUnidades[0]!);
    const radio = b.q("input[name=cfo-platillos-metrica][value=ingreso]") as HTMLInputElement;
    click(radio);
    await b.esperar(() => b.q("[data-testid=chart-card] p")!.textContent!.includes("por ingreso"), "ranking por ingreso");
    expect(b.q("[data-testid=ranking-top]")!.textContent).toContain(porIngreso[0]!);
  });

  it("rankingsDe: top y bottom completos desde la matriz, sin empates ambiguos", () => {
    const m = [
      { productoRef: "a", nombre: "A", unidades: 10, ingresoCentavos: 100, cuadrante: "estrella" as const },
      { productoRef: "b", nombre: "B", unidades: 10, ingresoCentavos: 900, cuadrante: "estrella" as const },
      { productoRef: "c", nombre: "C", unidades: 1, ingresoCentavos: 50, cuadrante: "revisar" as const },
      { productoRef: "d", nombre: "D", unidades: 0, ingresoCentavos: 0, cuadrante: "revisar" as const },
    ];
    expect(rankingsDe(m, "unidades").top.map((p) => p.productoRef)).toEqual(["a", "b", "c"]);
    expect(rankingsDe(m, "ingreso").top.map((p) => p.productoRef)).toEqual(["b", "a", "c"]);
    expect(rankingsDe(m, "unidades").bottom.map((p) => p.productoRef)).toEqual(["c", "b", "a"]);
    expect(rankingsDe(m, "ingreso").top[0]!.participacionIngresoPct).toBe(85.7);
  });

  it("la canasta muestra soporte y lift con su explicación; el efecto de promociones va como estimado y sin dato dice «—»", async () => {
    await b.pintar(CfoPlatillos, crearApiCfo());
    await listo();
    const canasta = b.q("table[aria-label='Pares de platillos más frecuentes']")!;
    expect([...canasta.querySelectorAll("thead th")].map((t) => t.textContent?.trim())).toEqual(["Par", "Sucursal", "Pedidos juntos", "Soporte", "Lift"]);
    expect(b.texto()).toContain("Lift mayor que 1");
    const promos = b.q("table[aria-label='Efecto de las promociones por platillo']")!;
    expect(promos.textContent).toContain("—");
    expect(b.texto()).toContain("no prueba que la promoción causó el cambio");
  });

  it("agotados de hoy: lista el agotado, suma la venta en riesgo y dice que es estimado", async () => {
    await b.pintar(CfoPlatillos, crearApiCfo());
    await listo();
    const tabla = b.q("table[aria-label='Platillos agotados hoy']")!;
    expect(tabla.textContent).toContain("Flan");
    expect(tabla.textContent).toContain("Sin fecha de regreso");
    expect(b.texto()).toContain("Venta en riesgo por día");
  });

  it("un agotado programado cuya fecha ya pasó no cuenta como agotado hoy", async () => {
    const base = await respuestaBase<ProductosVista>("/productos");
    const pasado = { ...base, agotados: base.agotados.map((a) => ({ ...a, disponible: true, agotadoHasta: "2026-09-29T12:00:00.000Z" })) };
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 200, cuerpo: pasado } }));
    await listo();
    expect(b.texto()).toContain("Nada agotado hoy");
  });

  it("vista «Por sucursal»: ranking de cada sucursal", async () => {
    await b.pintar(CfoPlatillos, crearApiCfo(), { filtros: { vista: "sucursal" } });
    await listo();
    expect(b.qa("[data-testid=platillos-por-sucursal] h4").length).toBe(7);
  });

  it("matriz sin puntos: aviso honesto, no un lienzo vacío", async () => {
    const base = await respuestaBase<ProductosVista>("/productos");
    const sinMatriz = { ...base, matriz: [], agotados: [{ ...base.agotados[0]! }] };
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 200, cuerpo: sinMatriz } }));
    await listo();
    expect(b.q("[data-testid=matriz-dispersion] svg")).toBeNull();
    expect(b.texto()).toContain("Sin ventas por platillo en este periodo");
  });

  it("sin ventas de platillos: estado vacío", async () => {
    const base = await respuestaBase<ProductosVista>("/productos");
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 200, cuerpo: { ...base, matriz: [], agotados: [], canasta: [], mixCategoria: [], efectoPromocion: [], ticketPorNumeroProductos: [] } } }));
    await b.esperar(() => b.texto().includes("Sin ventas de platillos"), "vacío");
  });

  it("estados: 403, base sin migrar, disponible:false y error con reintento", async () => {
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 403 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO"), "403");
    b.desmontar();
    const base = await respuestaBase<ProductosVista>("/productos");
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 200, cuerpo: { ...base, disponible: false } } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "no disponible");
    b.desmontar();
    await b.pintar(CfoPlatillos, crearApiCfo({ "GET /productos": { status: 500, cuerpo: { message: "Falló platillos." } } }));
    await b.esperar(() => b.texto().includes("Falló platillos."), "500");
    expect(b.boton("Reintentar")).toBeDefined();
  });

  it("el rango de fechas viaja al API", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoPlatillos, api);
    await listo();
    const peticion = api.peticiones("GET", "/productos")[0]!;
    expect(peticion.consulta.get("desde")).toBe("2026-09-21");
    expect(peticion.consulta.get("hasta")).toBe("2026-09-27");
  });
});
