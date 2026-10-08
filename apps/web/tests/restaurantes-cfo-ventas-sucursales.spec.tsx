// @vitest-environment jsdom
//
// <CfoVentas /> y <CfoSucursales />: gráficas con aria-label y tabla «Ver datos», drill-down a pedidos, cascada que cuadra, tabla lado a lado que suma el total,
// «No asignado» solo con organización completa, atípicos con texto y cifras null como «—».
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SucursalesVista, VentasVista } from "@atiende/domain-restaurantes/cfo";
import { CfoSucursales } from "../src/verticals/restaurantes/cfo/CfoSucursales.tsx";
import { CfoVentas, pasosCascada } from "../src/verticals/restaurantes/cfo/CfoVentas.tsx";
import { IDS, crearApiCfo, propsPagina, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function pintar(Pagina: typeof CfoVentas | typeof CfoSucursales, api: ReturnType<typeof crearApiCfo>, sobre: Parameters<typeof propsPagina>[1] = {}) {
  const props = await propsPagina(api, sobre);
  rendered = renderComponent(
    <MemoryRouter>
      <Pagina {...props} />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}
const q = (sel: string) => rendered!.container.querySelector(sel);
const qa = (sel: string) => [...rendered!.container.querySelectorAll(sel)];
const texto = () => rendered!.container.textContent ?? "";
const boton = (nombre: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === nombre || b.getAttribute("aria-label") === nombre) as HTMLButtonElement;

describe("<CfoVentas />", () => {
  const listo = () => esperarHasta(() => q("[data-testid=cfo-ventas] [data-testid=chart-card]") !== null, "ventas pintadas");

  it("trae tendencia con comparativa, canales, mapa de calor, cascada, forma de pago, propinas y cancelaciones", async () => {
    await pintar(CfoVentas, crearApiCfo());
    await listo();
    const titulos = qa("[data-testid=chart-card] h3").map((h) => h.textContent);
    expect(titulos).toEqual(["Tendencia de ventas netas", "Ventas por canal y origen", "Forma de pago", "Ventas por día y hora", "De ventas brutas a netas sin IVA"]);
    expect(q("[data-testid=area-chart]")).not.toBeNull();
    expect(texto()).toContain("Línea punteada: periodo de comparación");
    expect(q("[data-testid=heatmap]")).not.toBeNull();
    expect(q("[data-testid=cascada]")).not.toBeNull();
    expect(q("[data-testid=ventas-estadisticas]")).not.toBeNull();
  });

  it("accesibilidad: cada gráfica lleva aria-label con cifras y una tabla «Ver datos»", async () => {
    await pintar(CfoVentas, crearApiCfo());
    await listo();
    expect(q("[data-testid=area-chart]")!.getAttribute("aria-label")).toBeTruthy();
    expect(q("[data-testid=heatmap] svg")!.getAttribute("aria-label")).toMatch(/Mapa de calor de ventas.*Máximo: \$[\d,]+/);
    expect(q("[data-testid=cascada]")!.getAttribute("aria-label")).toMatch(/Ventas brutas: \$[\d,]+.*Descuentos de promoción: menos \$[\d,]+/);
    expect(q("[data-testid=ranking-barras]")!.getAttribute("aria-label")).toContain("1.");
    expect(q("[data-testid=dona] svg")!.getAttribute("aria-label")).toBeTruthy();
    const detalles = qa("details[data-testid=tabla-datos-grafica]");
    expect(detalles.length).toBe(5);
    for (const d of detalles) {
      expect(d.querySelector("summary")!.textContent).toBe("Ver datos");
      expect(d.querySelector("table caption")!.textContent!.length).toBeGreaterThan(0);
    }
  });

  it("respeta prefers-reduced-motion: las barras animadas llevan motion-safe y la hoja de estilos apaga el resto", async () => {
    await pintar(CfoVentas, crearApiCfo());
    await listo();
    for (const el of qa("[data-testid=ranking-barra],[data-testid=cascada-barra]")) {
      const animadas = (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /(^|:)(transition|animate|duration)/.test(c));
      for (const c of animadas) expect(c.startsWith("motion-safe:"), c).toBe(true);
    }
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ui/src/index.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{[^}]*transition-duration: 0\.001ms !important/);
  });

  it("la cascada de la fixture cuadra (bruta − descuentos − compensaciones = neta) y sus pasos usan las cifras del API", async () => {
    const base = await respuestaBase<VentasVista>("/ventas");
    const c = base.ventas.total.cascada;
    expect(c.descuadreCentavos).toBe(0);
    const pasos = pasosCascada(c);
    expect(pasos.map((p) => p.etiqueta)).toEqual(["Ventas brutas", "Descuentos de promoción", "Compensaciones", "Ventas netas (con IVA)", "IVA estimado", "Ventas netas sin IVA"]);
    expect(pasos[0]!.valor).toBe(c.brutaCentavos.valor);
    await pintar(CfoVentas, crearApiCfo());
    await listo();
    expect(q("[data-testid=cascada-descuadre]")).toBeNull();
  });

  it("si la cascada NO cuadra lo dice con una alerta (danger) en vez de esconderlo", async () => {
    const base = await respuestaBase<VentasVista>("/ventas");
    const roto = { ...base, ventas: { ...base.ventas, total: { ...base.ventas.total, cascada: { ...base.ventas.total.cascada, descuadreCentavos: 1250 } } } };
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 200, cuerpo: roto } }));
    await listo();
    const alerta = q("[data-testid=cascada-descuadre]")!;
    expect(alerta.getAttribute("role")).toBe("alert");
    expect(alerta.textContent).toContain("$12.50");
  });

  it("propinas: la nota dice que solo es con tarjeta; sin propinas registradas dice «—» y la razón, no $0", async () => {
    const base = await respuestaBase<VentasVista>("/ventas");
    await pintar(CfoVentas, crearApiCfo());
    await listo();
    expect(q("[data-testid=ventas-estadisticas]")!.textContent).toMatch(/la propina en efectivo entregada en mano no se registra/i);
    rendered?.unmount();
    const sin = { ...base, propinas: { ...base.propinas, tarjetaCentavos: { valor: null, confianza: "sin_dato", fuente: "cfo_ventas_diarias" } } };
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 200, cuerpo: sin } }));
    await listo();
    const tarjeta = qa("[data-testid=ventas-estadisticas] > div")[0]!;
    expect(tarjeta.textContent).toContain("—");
    expect(tarjeta.textContent).toContain("Sin propinas con tarjeta registradas en el periodo.");
    expect(tarjeta.textContent).not.toContain("$0");
  });

  it("sin ventas en el periodo: avisos honestos en cada gráfica, ninguna gráfica de relleno", async () => {
    const base = await respuestaBase<VentasVista>("/ventas");
    const vacia = { ...base, serieComparativo: null, porCanal: [], heatmap: [], formaPago: [], ventas: { ...base.ventas, total: { ...base.ventas.total, serie: [], cascada: { ...base.ventas.total.cascada, brutaCentavos: { valor: null, confianza: "sin_dato", fuente: "x" }, descuentoPromocionCentavos: { valor: null, confianza: "sin_dato", fuente: "x" }, compensacionesCentavos: { valor: null, confianza: "sin_dato", fuente: "x" }, netaCentavos: { valor: null, confianza: "sin_dato", fuente: "x" }, ivaEstimadoCentavos: { valor: null, confianza: "sin_dato", fuente: "x" }, netaSinIvaCentavos: { valor: null, confianza: "sin_dato", fuente: "x" } } } } };
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 200, cuerpo: vacia } }));
    await listo();
    expect(qa("[data-testid=grafica-sin-datos]").length).toBeGreaterThanOrEqual(5);
    expect(q("[data-testid=area-chart]")).toBeNull();
    expect(q("[data-testid=heatmap] svg")).toBeNull();
    expect(q("[data-testid=cascada]")).toBeNull();
    expect(qa("details[data-testid=tabla-datos-grafica]")).toHaveLength(0);
  });

  it("drill-down: cada pieza abre la lista de pedidos con SU filtro", async () => {
    const abrir = vi.fn();
    const base = await respuestaBase<VentasVista>("/ventas");
    await pintar(CfoVentas, crearApiCfo(), { abrirPedidos: abrir });
    await listo();
    click(boton("Ver los pedidos del periodo"));
    expect(abrir).toHaveBeenLastCalledWith({});
    click(boton("Ver pedidos con descuento"));
    expect(abrir).toHaveBeenLastCalledWith({ con_descuento: true });
    click(boton("Ver pedidos de compensación"));
    expect(abrir).toHaveBeenLastCalledWith({ es_compensacion: true });
    click(boton("Ver cancelados"));
    expect(abrir).toHaveBeenLastCalledWith({ status: "cancelado" });
    click(boton("Ver no recogidos"));
    expect(abrir).toHaveBeenLastCalledWith({ status: "no_recogido" });
    const canal = base.porCanal[0]!;
    click(boton(`Ver pedidos de ${canal.canal === "domicilio" ? "Domicilio" : "Para recoger"} · ${{ web: "En línea", voice: "Voz", whatsapp: "WhatsApp", admin: "Equipo" }[canal.source]}`));
    expect(abrir).toHaveBeenLastCalledWith({ canal: canal.canal, source: canal.source });
    const pico = base.heatmap.reduce((m, c) => (c.netaCentavos > m.netaCentavos ? c : m));
    click(qa("button").find((b) => b.getAttribute("aria-label")?.startsWith("Ver pedidos de la hora pico"))!);
    expect(abrir).toHaveBeenLastCalledWith({ dow_negocio: pico.dow, hora_local: pico.hora });
    click(boton("Ver pedidos pagados con tarjeta"));
    expect(abrir).toHaveBeenLastCalledWith({ payment_method: "tarjeta" });
  });

  it("vista «Por sucursal»: barras agrupadas neta/bruta y cascada por sucursal con total, null como «—»", async () => {
    await pintar(CfoVentas, crearApiCfo(), { filtros: { vista: "sucursal" } });
    await listo();
    expect(q("[data-testid=barras-agrupadas]")).not.toBeNull();
    expect(qa("[data-testid=barras-grupo]")).toHaveLength(7);
    const tabla = q("table[aria-label='Cascada de ventas por sucursal']")!;
    expect([...tabla.querySelectorAll("thead th")].map((t) => t.textContent?.trim())[0]).toBe("Concepto");
    expect([...tabla.querySelectorAll("thead th")].at(-1)!.textContent?.trim()).toBe("Total");
    // Pedidos: el total es la suma de las columnas por sucursal.
    const celdas = [...tabla.querySelectorAll("tbody tr")][0]!.querySelectorAll("td");
    const nums = [...celdas].map((c) => Number((c.textContent ?? "").replace(/[^\d]/g, "")));
    expect(nums.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(nums.at(-1));
  });

  it("estados: 403, base sin migrar y error con reintento", async () => {
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 403 } }));
    await esperarHasta(() => texto().includes("Tu rol no tiene acceso al CFO"), "403");
    rendered?.unmount();
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 503 } }));
    await esperarHasta(() => texto().includes("El CFO aún no está disponible"), "503");
    rendered?.unmount();
    await pintar(CfoVentas, crearApiCfo({ "GET /ventas": { status: 500, cuerpo: { message: "Falló ventas." } } }));
    await esperarHasta(() => texto().includes("Falló ventas."), "500");
    expect(boton("Reintentar")).toBeDefined();
  });
});

describe("<CfoSucursales />", () => {
  const listo = () => esperarHasta(() => q("[data-testid=cfo-tabla-sucursales] table") !== null, "tabla de sucursales");
  const filaDe = (id: string) => q(`tr[data-fila="${id}"]`)!;
  const celdas = (id: string) => [...filaDe(id).querySelectorAll("td")].map((c) => c.textContent ?? "");
  const num = (t: string) => Number(t.replace(/[^\d]/g, ""));

  it("tabla lado a lado: una fila por sucursal + «No asignado» + «Total»; el Total es la suma de los pedidos", async () => {
    const base = await respuestaBase<SucursalesVista>("/sucursales");
    await pintar(CfoSucursales, crearApiCfo());
    await listo();
    const filas = qa("[data-testid=cfo-tabla-sucursales] tbody tr").map((r) => r.getAttribute("data-fila"));
    expect(filas).toEqual([...base.tabla.map((s) => s.propertyId), "no-asignado", "total"]);
    const suma = base.tabla.reduce((s, f) => s + num(celdas(f.propertyId)[1]!), 0);
    expect(num(celdas("total")[1]!)).toBe(suma);
    expect(num(celdas("total")[1]!)).toBe(base.total.pedidos);
    expect(q("[data-testid=leyenda-total]")!.textContent).toContain("Total = suma de sucursales + no asignado");
    expect(celdas("no-asignado")[0]).toContain("No asignado");
    expect(celdas("no-asignado").slice(1, 4)).toEqual(["—", "—", "—"]);
  });

  it("«No asignado» NO aparece con un alcance acotado (el API no lo manda) y la leyenda cambia", async () => {
    const base = await respuestaBase<SucursalesVista>("/sucursales");
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 200, cuerpo: { ...base, noAsignado: null } } }), { alcance: { organizacionCompleta: false } });
    await listo();
    expect(q('tr[data-fila="no-asignado"]')).toBeNull();
    expect(q("[data-testid=leyenda-total]")!.textContent).toContain("Total = suma de las sucursales del alcance");
  });

  it("ranking con posición, valor y participación; los atípicos se marcan con TEXTO", async () => {
    const base = await respuestaBase<SucursalesVista>("/sucursales");
    const o = base.tabla[0]!;
    const conAtipica = { ...base, outliers: [{ propertyId: o.propertyId, nombre: o.nombre, metrica: "netaCentavos", valor: o.netaCentavos, mediana: Math.round(o.netaCentavos / 3), z: 2.4, motivo: "z>=2" }] };
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 200, cuerpo: conAtipica } }));
    await listo();
    const filas = qa("[data-testid=ranking-fila]");
    expect(filas).toHaveLength(base.ranking.length);
    expect(filas[0]!.textContent).toContain("1");
    expect(filas[0]!.textContent).toMatch(/\$[\d,]+/);
    expect(q("[data-testid=ranking-barras]")!.getAttribute("aria-label")).toContain("1.");
    expect(q("[data-testid=cfo-outliers]")!.textContent).toContain("z = 2.4");
    expect(qa("[data-testid=ranking-outlier]").map((e) => e.textContent)).toEqual(["Atípica"]);
    expect(filaDe(o.propertyId).textContent).toContain("Atípica");
    expect(qa("details[data-testid=tabla-datos-grafica]")).toHaveLength(1);
  });

  it("mini tendencias: una por sucursal con ≥ 2 puntos, con nombre accesible; sin serie dice «—»", async () => {
    const base = await respuestaBase<SucursalesVista>("/sucursales");
    const tabla = base.tabla.map((s, i) => (i === 0 ? { ...s, miniTendencia: [] } : s));
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 200, cuerpo: { ...base, tabla } } }));
    await listo();
    expect(qa("[data-testid=sparkline]")).toHaveLength(base.tabla.length - 1);
    expect(qa("[data-testid=cfo-tabla-sucursales] tbody tr")[0]!.querySelector("td:last-child")!.textContent).toBe("—");
    expect(qa("[role=img][aria-label^='Tendencia de ventas de']").length).toBe(base.tabla.length - 1);
  });

  it("selección múltiple que filtra la tabla: ocultar una sucursal la quita; el Total sigue siendo el del alcance y lo dice", async () => {
    await pintar(CfoSucursales, crearApiCfo());
    await listo();
    const total = celdas("total")[1];
    const caja = q(`input[data-testid="mostrar-${IDS.T3}"]`) as HTMLInputElement;
    expect(caja.checked).toBe(true);
    click(caja);
    await esperarHasta(() => q(`tr[data-fila="${IDS.T3}"]`) === null, "fila oculta");
    expect(celdas("total")[1]).toBe(total);
    expect(q("[data-testid=leyenda-total]")!.textContent).toContain("aunque algunas estén ocultas");
    click(caja);
    await esperarHasta(() => q(`tr[data-fila="${IDS.T3}"]`) !== null, "fila de regreso");
  });

  it("sin sucursales con datos: estado vacío; 403 y base sin migrar tienen su estado", async () => {
    const base = await respuestaBase<SucursalesVista>("/sucursales");
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 200, cuerpo: { ...base, tabla: [], ranking: [], outliers: [], noAsignado: null } } }));
    await esperarHasta(() => texto().includes("Sin sucursales en esta selección"), "vacío");
    rendered?.unmount();
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 403 } }));
    await esperarHasta(() => texto().includes("Tu rol no tiene acceso al CFO"), "403");
    rendered?.unmount();
    await pintar(CfoSucursales, crearApiCfo({ "GET /sucursales": { status: 200, cuerpo: { disponible: false } } }));
    await esperarHasta(() => texto().includes("El CFO aún no está disponible"), "no disponible");
  });
});
