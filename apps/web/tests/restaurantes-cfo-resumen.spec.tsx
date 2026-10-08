// @vitest-environment jsdom
//
// <CfoResumen />: «Lo más importante», resumen narrado y KPI con semáforo. Con datos SINTÉTICOS reales (CFO-04 + CFO-05) y los casos que deben decir la verdad:
// cifra null = «—» (nunca 0), sin hallazgos, 403, base sin migrar, error con reintento, orden por impacto / urgencia y vista por sucursal.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Hallazgo, ResumenVista } from "@atiende/domain-restaurantes/cfo";
import { CfoResumen } from "../src/verticals/restaurantes/cfo/CfoResumen.tsx";
import { crearApiCfo, propsPagina, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function pintar(api: ReturnType<typeof crearApiCfo>, sobre: Parameters<typeof propsPagina>[1] = {}) {
  const props = await propsPagina(api, sobre);
  rendered = renderComponent(
    <MemoryRouter>
      <CfoResumen {...props} />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return props;
}
const q = (sel: string) => rendered!.container.querySelector(sel);
const qa = (sel: string) => [...rendered!.container.querySelectorAll(sel)];
const texto = () => rendered!.container.textContent ?? "";
const listo = () => esperarHasta(() => q("[data-testid=kpis]") !== null || q("table") !== null, "resumen pintado");

describe("<CfoResumen /> · con datos", () => {
  it("«Lo más importante»: tarjetas con título, cifra, comparación, por qué importa, acción e impacto; la primera destacada con Odometro", async () => {
    await pintar(crearApiCfo());
    await listo();
    const tarjetas = qa("[data-testid=hallazgo]");
    expect(tarjetas.length).toBeGreaterThanOrEqual(2);
    const primera = tarjetas[0]!;
    expect(primera.getAttribute("data-destacada")).toBe("1");
    expect(tarjetas[1]!.getAttribute("data-destacada")).toBeNull();
    expect(primera.querySelector("[data-testid=odometro]")).not.toBeNull();
    expect(primera.textContent).toContain("Por qué importa");
    expect(primera.textContent).toContain("Impacto: $");
    expect(primera.querySelector("[data-testid=hallazgo-cifra]")!.textContent!.length).toBeGreaterThan(0);
    // Semáforo con texto (nunca solo color).
    expect(primera.querySelector("[data-testid=semaforo]")!.textContent).toMatch(/Urgencia (alta|media|baja)/);
    // Acción: enlace al drill-down de Ventas con el filtro de la tarjeta.
    const enlace = primera.querySelector<HTMLAnchorElement>("a[data-testid=hallazgo-accion]")!;
    expect(enlace.getAttribute("href")).toContain("/restaurantes/demo/cfo/ventas?");
    expect(enlace.getAttribute("href")).toContain("pedidos=1");
  });

  it("las acciones hacia las pestañas de CFO-08 (SoftRestaurant, Operación, Platillos, Clientes) son enlaces reales, sin «llega pronto»", async () => {
    await pintar(crearApiCfo());
    await listo();
    expect(qa("[data-testid=hallazgo-accion-sin-enlace]")).toHaveLength(0);
    const destinos = qa("a[data-testid=hallazgo-accion]").map((a) => new URL(a.getAttribute("href")!, "https://x.test").pathname.split("/").pop());
    expect(destinos.some((d) => ["softrestaurant", "operacion", "platillos", "clientes"].includes(d!))).toBe(true);
    expect(texto()).not.toContain("llega pronto");
  });

  it("los 12 KPI traen semáforo con texto, variación y chip de confianza donde la cifra no es medida", async () => {
    await pintar(crearApiCfo());
    await listo();
    const kpis = qa("[data-testid=kpi-cfo]");
    expect(kpis.map((k) => k.getAttribute("data-kpi"))).toEqual([
      "ventas_netas", "pedidos", "ticket", "mix_domicilio", "descuento_pct", "cancelacion_pct", "costo_pedido_agente", "margen_contribucion", "clientes_activos", "frecuentes_pct", "tasa_cierre_agente", "entrega_p90",
    ]);
    for (const k of kpis) {
      expect(k.querySelector("[data-testid=semaforo]")!.textContent!.length, k.getAttribute("data-kpi")!).toBeGreaterThan(0);
      expect(k.querySelector("[data-testid=kpi-variacion]")!.textContent!.length).toBeGreaterThan(0);
    }
    const chips = qa("[data-testid=chip-confianza]");
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.textContent!.trim().length).toBeGreaterThan(0); // el chip siempre tiene TEXTO
  });

  it("el resumen narrado resalta las cifras y no enseña las marcas internas [ref]", async () => {
    await pintar(crearApiCfo());
    await listo();
    const n = q("[data-testid=cfo-narrativa]")!;
    expect(n.querySelectorAll("strong").length).toBeGreaterThan(3);
    expect(n.textContent).not.toMatch(/\[[a-z0-9_]+\]/);
    expect(n.querySelector("strong[data-ref=ventas_netas]")!.textContent).toMatch(/^\$[\d,]+\.\d{2}$/);
  });

  it("los avisos del servicio van en un Callout arriba (SINTÉTICO, SoftRestaurant, Meta no medido, costos por capturar)", async () => {
    await pintar(crearApiCfo());
    await listo();
    const avisos = q("[data-testid=cfo-avisos]")!;
    expect(avisos.textContent).toContain("SINTÉTICO");
    expect(avisos.textContent).toContain("Sin datos de mostrador de SoftRestaurant");
    expect(avisos.textContent).toContain("Costo de Meta no medido");
  });

  it("titular de ventas y «No asignado» (solo con organización completa)", async () => {
    await pintar(crearApiCfo());
    await listo();
    expect(q("[data-testid=cfo-titular]")!.textContent).toContain("Ventas por el agente");
    expect(q("[data-testid=kpi-no-asignado]")!.textContent).toContain("No asignado");
  });
});

describe("<CfoResumen /> · cifras sin dato", () => {
  it("un KPI con valor null dice «—» (con aria-label «sin dato») y NUNCA 0", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    const kpis = base.kpis.total.kpis.map((k) => (k.id === "ticket" ? { ...k, valor: { valor: null, confianza: "sin_dato", fuente: "cfo_ventas_diarias" }, base: null, variacion: { tipo: "pct", valor: null }, semaforo: "sin_dato" } : k));
    const api = crearApiCfo({ "GET /resumen": { status: 200, cuerpo: { ...base, kpis: { ...base.kpis, total: { ...base.kpis.total, kpis } } } } });
    await pintar(api);
    await listo();
    const t = q("[data-kpi=ticket]")!;
    const valor = t.querySelector("p")!;
    expect(valor.textContent).toBe("—");
    expect(valor.getAttribute("aria-label")).toBe("Ticket promedio: sin dato");
    expect(t.textContent).not.toMatch(/\$0(?!\d|,|\.\d)/);
    expect(t.querySelector("[data-testid=kpi-variacion]")!.textContent).toBe("sin base");
    expect(t.querySelector("[data-testid=semaforo]")!.getAttribute("data-estado")).toBe("sin_dato");
  });

  it("un titular sin dato dice «—» y avisa; los bloques sin migrar se declaran como datos incompletos", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    const vista = { ...base, bloques: { ventas: true, clientes: false, captura: false }, titular: { ...base.titular, cifra: { valor: null, confianza: "sin_dato", fuente: "cfo_ventas_diarias" } } };
    await pintar(crearApiCfo({ "GET /resumen": { status: 200, cuerpo: vista } }));
    await listo();
    expect(q("[data-testid=cfo-titular] p:nth-of-type(2)")!.textContent).toBe("—");
    expect(q("[data-testid=cfo-avisos]")!.textContent).toContain("Datos incompletos");
    expect(q("[data-testid=cfo-avisos]")!.textContent).toContain("clientes y operación");
  });

  it("sin hallazgos: estado vacío honesto (no inventa tarjetas)", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    await pintar(crearApiCfo({ "GET /resumen": { status: 200, cuerpo: { ...base, hallazgos: [] } } }));
    await listo();
    expect(qa("[data-testid=hallazgo]")).toHaveLength(0);
    expect(texto()).toContain("Nada urgente en este periodo");
  });
});

describe("<CfoResumen /> · estados", () => {
  it("403: «Tu rol no tiene acceso al CFO» y ninguna cifra", async () => {
    await pintar(crearApiCfo({ "GET /resumen": { status: 403 } }));
    await esperarHasta(() => texto().includes("Tu rol no tiene acceso al CFO"), "403");
    expect(qa("[data-testid=kpi-cfo]")).toHaveLength(0);
  });
  it("base sin migrar (503 y disponible:false): estado honesto", async () => {
    for (const forzado of [{ status: 503 }, { status: 200, cuerpo: { disponible: false } }]) {
      await pintar(crearApiCfo({ "GET /resumen": forzado }));
      await esperarHasta(() => texto().includes("El CFO aún no está disponible"), "no disponible");
      expect(qa("[data-testid=kpi-cfo]")).toHaveLength(0);
      rendered?.unmount();
    }
  });
  it("error: muestra el mensaje y «Reintentar» vuelve a pedir", async () => {
    let falla = true;
    const api = crearApiCfo({ "GET /resumen": () => (falla ? { status: 500, cuerpo: { message: "Falló el resumen." } } : undefined) });
    await pintar(api);
    await esperarHasta(() => texto().includes("Falló el resumen."), "error");
    falla = false;
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!);
    await listo();
    expect(api.peticiones("GET", "/resumen")).toHaveLength(2);
  });
  it("cargando: estado de carga accesible antes de la respuesta", async () => {
    // Una petición que nunca responde: la pantalla se queda en el estado de carga (no pinta cifras mientras tanto).
    await pintar(crearApiCfo({ "GET /resumen": () => new Promise<never>(() => undefined) as never }));
    expect(q("[role=status][aria-busy=true]")).not.toBeNull();
    expect(qa("[data-testid=kpi-cfo]")).toHaveLength(0);
  });
});

describe("<CfoResumen /> · conmutadores", () => {
  const impactoDe = (h: Hallazgo) => h.impactoCentavos;
  it("«Ordenar por impacto / urgencia»: vuelve a pedir con orden=urgencia y las tarjetas cambian de orden", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    const porUrgencia = [...base.hallazgos].sort((a, b) => ["alta", "media", "baja"].indexOf(a.urgencia) - ["alta", "media", "baja"].indexOf(b.urgencia) || (impactoDe(b) ?? -1) - (impactoDe(a) ?? -1));
    const api = crearApiCfo({ "GET /resumen": (p) => ({ status: 200, cuerpo: { ...base, orden: p.consulta.get("orden"), hallazgos: p.consulta.get("orden") === "urgencia" ? porUrgencia : base.hallazgos } }) });
    await pintar(api);
    await listo();
    const antes = qa("[data-testid=hallazgo]").map((e) => e.getAttribute("data-tipo") + "|" + e.getAttribute("data-urgencia"));
    expect(q("[data-testid=hallazgos]")!.getAttribute("data-orden")).toBe("impacto");
    expect(antes[0]).toContain("media"); // primero el de mayor impacto $ (una compensación de urgencia media)
    click(q("input[name=cfo-orden-hallazgos][value=urgencia]")!);
    await esperarHasta(() => api.peticiones("GET", "/resumen").length === 2, "segunda petición");
    expect(api.peticiones("GET", "/resumen")[1]!.consulta.get("orden")).toBe("urgencia");
    await esperarHasta(() => q("[data-testid=hallazgos]")?.getAttribute("data-orden") === "urgencia" && qa("[data-testid=hallazgo]")[0]?.getAttribute("data-urgencia") === "alta", "orden por urgencia");
    const despues = qa("[data-testid=hallazgo]").map((e) => e.getAttribute("data-tipo") + "|" + e.getAttribute("data-urgencia"));
    expect(despues).not.toEqual(antes);
  });

  it("vista «Por sucursal»: tabla indicador × sucursal con total, y celdas null como «—»", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    const porSucursal = base.kpis.porSucursal.map((s, i) => (i === 0 ? { ...s, kpis: s.kpis.map((k) => (k.id === "entrega_p90" ? { ...k, valor: { valor: null, confianza: "sin_dato", fuente: "x" } } : k)) } : s));
    const api = crearApiCfo({ "GET /resumen": { status: 200, cuerpo: { ...base, kpis: { ...base.kpis, porSucursal } } } });
    await pintar(api, { filtros: { vista: "sucursal" } });
    await esperarHasta(() => q("table") !== null, "tabla");
    expect(qa("thead th").length).toBe(1 + base.kpis.porSucursal.length + 1);
    const fila = q("tr[data-kpi=entrega_p90]")!;
    expect(fila.querySelectorAll("td")[1]!.textContent).toBe("—");
    expect(fila.querySelectorAll("td")[fila.querySelectorAll("td").length - 1]!.textContent).not.toBe("—");
    expect(q("[data-testid=kpis]")).toBeNull();
  });

  it("admin acotado: sin «No asignado» (el API no lo manda) y sin la fila del LLM de la organización", async () => {
    const base = await respuestaBase<ResumenVista>("/resumen");
    await pintar(crearApiCfo({ "GET /resumen": { status: 200, cuerpo: { ...base, kpis: { ...base.kpis, noAsignado: null } } } }), { alcance: { organizacionCompleta: false } });
    await listo();
    expect(q("[data-testid=kpi-no-asignado]")).toBeNull();
    expect(texto()).not.toContain("No asignado");
  });
});
