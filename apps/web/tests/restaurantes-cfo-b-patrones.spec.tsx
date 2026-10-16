// @vitest-environment jsdom
//
// <CfoPatrones />: estacionalidad, días pico, colonias con k = 5 («(otras)» visible y nota de privacidad), canal × hora y días entre pedidos. Datos SINTÉTICOS.
import { describe, expect, it } from "vitest";
import type { ColoniaApi, PatronesVista } from "@atiende/domain-restaurantes/cfo";
import { CfoPatrones, agruparColoniasChicas } from "../src/verticals/restaurantes/cfo/CfoPatrones.tsx";
import { crearApiCfo, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";

const b = bancoCfoB();
const listo = () => b.esperar(() => b.q("[data-testid=cfo-patrones] [data-testid=chart-card]") !== null, "patrones pintados");
const cifra = (valor: number | null) => ({ valor, confianza: valor === null ? ("sin_dato" as const) : ("medido" as const), fuente: "x" });
const colonia = (propertyId: string, nombre: string, pedidos: number, extra: Partial<ColoniaApi> = {}): ColoniaApi => ({
  propertyId, colonia: nombre, pedidos, netaCentavos: pedidos * 30_000, ticket: cifra(30_000), entregaPromedioMin: cifra(40), sucursalCercanaId: propertyId, distanciaKm: 2, ...extra,
});

describe("<CfoPatrones />", () => {
  it("trae estacionalidad semanal y mensual, colonias, canal por hora y días entre pedidos, cada gráfica con su tabla", async () => {
    await b.pintar(CfoPatrones, crearApiCfo());
    await listo();
    expect(b.qa("[data-testid=chart-card] h3").map((h) => h.textContent)).toEqual(["Venta por día de la semana", "Venta por mes", "Colonias", "Canal por hora"]);
    expect(b.q("[data-testid=patrones-frecuencia]")!.textContent).toMatch(/\d+ días/);
    expect(b.texto()).toContain("aún no la entrega el servicio del CFO");
    expect(b.qa("details[data-testid=tabla-datos-grafica]").length).toBeGreaterThanOrEqual(3);
  });

  it("colonias: «(otras)» visible, nota de privacidad con k = 5 y ninguna colonia chica suelta", async () => {
    await b.pintar(CfoPatrones, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=colonias-privacidad]")!.textContent).toMatch(/menos de 5 pedidos o 5 clientes se agrupan en «\(otras\)»/);
    expect(b.qa("[data-testid=ranking-fila]").map((f) => f.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("(otras)")]));
    expect(b.q("[data-testid=colonias-otras]")!.textContent).toMatch(/«\(otras\)» junta [\d,]+ pedidos/);
    const tabla = b.q("table[aria-label='Colonias con pedidos a domicilio']")!;
    const col = [...tabla.querySelectorAll("thead th")].findIndex((t) => t.textContent?.trim() === "Pedidos");
    const filas = [...tabla.querySelectorAll("tbody tr[data-colonia]")];
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      const pedidos = Number((f.children[col]?.textContent ?? "").replace(/[^\d]/g, ""));
      if (f.getAttribute("data-colonia") !== "(otras)") expect(pedidos).toBeGreaterThanOrEqual(5);
    }
  });

  it("agruparColoniasChicas: aunque el API mande una colonia con menos de 5 pedidos, se agrupa por sucursal y nunca se muestra suelta", () => {
    const out = agruparColoniasChicas([
      colonia("s1", "Colonia SINTÉTICA A", 20),
      colonia("s1", "Colonia SINTÉTICA B", 3),
      colonia("s1", "Colonia SINTÉTICA C", 2),
      colonia("s1", "(otras)", 6),
      colonia("s2", "Colonia SINTÉTICA D", 4),
    ]);
    expect(out.map((c) => `${c.propertyId}|${c.colonia}|${c.pedidos}`).sort()).toEqual(["s1|(otras)|11", "s1|Colonia SINTÉTICA A|20", "s2|(otras)|4"]);
    const otras = out.find((c) => c.propertyId === "s1" && c.colonia === "(otras)")!;
    expect(otras.sucursalCercanaId).toBeNull();
    expect(otras.distanciaKm).toBeNull();
    expect(otras.netaCentavos).toBe(11 * 30_000);
  });

  it("la sucursal de despacho más cercana se escribe con nombre y distancia; sin dato, «—»", async () => {
    const base = await respuestaBase<PatronesVista>("/patrones");
    const id = base.sucursales[0]!.propertyId;
    const cuerpo = { ...base, colonias: [colonia(id, "Colonia SINTÉTICA A", 20, { distanciaKm: 3.46 }), colonia(id, "Colonia SINTÉTICA Z", 30, { sucursalCercanaId: null, distanciaKm: null })] };
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 200, cuerpo } }));
    await listo();
    const a = b.q("tr[data-colonia='Colonia SINTÉTICA A']")!.textContent!;
    expect(a).toContain(`${base.sucursales[0]!.nombre} · 3.5 km`);
    expect(b.q("tr[data-colonia='Colonia SINTÉTICA Z']")!.textContent).toContain("—");
  });

  it("los días pico se marcan con texto", async () => {
    const base = await respuestaBase<PatronesVista>("/patrones");
    const semanal = base.estacionalidadSemanal.map((f) => ({ ...f, promedioDiaCentavos: f.dow === 6 ? 500_000 : 100_000 }));
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 200, cuerpo: { ...base, estacionalidadSemanal: semanal } } }));
    await listo();
    expect(b.q("[data-testid=dias-pico]")!.textContent).toContain(base.estacionalidadSemanal[5]!.etiqueta);
  });

  it("enlaza a platillos para revisar el efecto de las promociones", async () => {
    await b.pintar(CfoPatrones, crearApiCfo());
    await listo();
    const a = b.q("[data-testid=patrones-promos] a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toMatch(/^\/restaurantes\/demo\/cfo\/platillos\?/);
  });

  it("sin pedidos: estado vacío", async () => {
    const base = await respuestaBase<PatronesVista>("/patrones");
    const vacio = { ...base, estacionalidadSemanal: base.estacionalidadSemanal.map((f) => ({ ...f, pedidos: 0, netaCentavos: 0, promedioDiaCentavos: null })), estacionalidadMensual: [], colonias: [], canalPorHora: [] };
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 200, cuerpo: vacio } }));
    await b.esperar(() => b.texto().includes("Sin patrones todavía"), "vacío");
  });

  it("estados: 403, base sin migrar y error con reintento", async () => {
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 403 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO"), "403");
    b.desmontar();
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 404 } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "404");
    b.desmontar();
    await b.pintar(CfoPatrones, crearApiCfo({ "GET /patrones": { status: 500, cuerpo: { message: "Falló patrones." } } }));
    await b.esperar(() => b.texto().includes("Falló patrones."), "500");
    expect(b.boton("Reintentar")).toBeDefined();
  });
});
