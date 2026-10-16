// @vitest-environment jsdom
//
// <CfoClientes />: aviso permanente de mostrador, «el total no es la suma», cohortes con mapa de calor, concentración, estados (vacío, error, 403,
// base sin migrar) y la leyenda de «Frecuente» que abre los Ajustes del CFO. Datos SINTÉTICOS.
import { describe, expect, it } from "vitest";
import type { ClientesVista } from "@atiende/domain-restaurantes/cfo";
import { CfoClientes } from "../src/verticals/restaurantes/cfo/CfoClientes.tsx";
import { crearApiCfo, IDS, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";
import { click } from "./test-utils/render.tsx";

const b = bancoCfoB();
const listo = () => b.esperar(() => b.q("[data-testid=cfo-clientes] [data-testid=chart-card]") !== null, "clientes pintados");

describe("<CfoClientes />", () => {
  it("muestra el aviso permanente de que los clientes de mostrador no se identifican", async () => {
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=clientes-aviso-mostrador]")!.textContent).toBe("Clientes = quienes pidieron por WhatsApp o voz; los clientes de mostrador no se identifican.");
  });

  it("con varias sucursales dice que el total no es la suma y cuánto suman por separado", async () => {
    const base = await respuestaBase<ClientesVista>("/clientes");
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    const nota = b.q("[data-testid=clientes-multisucursal]")!.textContent ?? "";
    expect(nota).toMatch(/clientes compraron en más de una sucursal/);
    expect(nota).toContain("el total no es la suma");
    expect(base.multiSucursal.clientes).toBeGreaterThan(0);
    expect(base.multiSucursal.sumaPorSucursal).toBeGreaterThan(base.total!.resumen.clientesConPedido);
  });

  it("trae altas por semana, base activa/dormida/perdida, cohortes con celdas, churn, concentración y horario por segmento", async () => {
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    const titulos = b.qa("[data-testid=chart-card] h3").map((h) => h.textContent);
    expect(titulos).toEqual(["Clientes nuevos por semana", "Base de clientes", "Recompra por cohorte", "Ticket por segmento", "Horario preferido por segmento"]);
    expect(b.q("[data-testid=bar-chart]")).not.toBeNull();
    expect(b.q("[data-testid=dona] svg")!.getAttribute("aria-label")).toBeTruthy();
    expect(b.qa("[data-testid=cohorte-celda]").length).toBeGreaterThanOrEqual(3);
    expect(b.q("[data-testid=clientes-churn]")!.textContent).toContain("Atribuido, no causal");
    expect(b.q("[data-testid=clientes-valor]")!.textContent).toMatch(/El 10 % de tus clientes genera el [\d.]+ % de la venta/);
    expect(b.q("[data-testid=heatmap]")).not.toBeNull();
    // Cada gráfica con su tabla «Ver datos».
    expect(b.qa("details[data-testid=tabla-datos-grafica]").length).toBeGreaterThanOrEqual(3);
  });

  it("churn sin base de activos al inicio se dice «—» con su razón, no 0 %", async () => {
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    const churn = b.qa("[data-testid=clientes-churn] > div")[0]!;
    expect(churn.textContent).toContain("—");
    expect(churn.textContent).not.toContain("0 %");
  });

  it("nunca pinta nombres, teléfonos ni direcciones", async () => {
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    expect(b.nodosDeTexto().filter((t) => /\d{10}/.test(t))).toEqual([]);
    expect(b.texto()).not.toMatch(/Cliente SINT/i);
  });

  it("la leyenda de «Frecuente» se lee del API y abre «Ajustes del CFO»", async () => {
    await b.pintar(CfoClientes, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=clientes-leyenda-frecuente]")!.textContent).toContain("Frecuente: 3 o más pedidos en 90 días.");
    click(b.boton("Editar en Ajustes del CFO"));
    await b.esperar(() => b.dialogo()?.textContent?.includes("Ajustes del CFO") === true, "diálogo de ajustes");
  });

  it("drill-down: lleva a la lista de pedidos (con alias)", async () => {
    const abrir = (await import("vitest")).vi.fn();
    await b.pintar(CfoClientes, crearApiCfo(), { abrirPedidos: abrir });
    await listo();
    click(b.boton("Ver pedidos del periodo (con alias de cliente)"));
    expect(abrir).toHaveBeenCalledWith({});
    expect(b.q("[data-testid=clientes-drill]")!.textContent).toContain("alias de 8 caracteres");
  });

  it("una sola sucursal: el renglón de la sucursal es el total y no sale la nota de varias sucursales", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoClientes, api, { filtros: { sucursales: [IDS.T1] } });
    await listo();
    expect(b.q("[data-testid=clientes-multisucursal]")).toBeNull();
    expect(b.q("[data-testid=clientes-resumen]")).not.toBeNull();
  });

  it("vista «Por sucursal»: tabla por sucursal", async () => {
    await b.pintar(CfoClientes, crearApiCfo(), { filtros: { vista: "sucursal" } });
    await listo();
    expect(b.q("table[aria-label='Clientes por sucursal']")).not.toBeNull();
  });

  it("sin clientes: estado vacío honesto", async () => {
    const base = await respuestaBase<ClientesVista>("/clientes");
    const vacio = { ...base, total: null, porSucursal: [], cohortes: [], altas: { porSemana: [], porMes: [] }, segmentoHora: [] };
    await b.pintar(CfoClientes, crearApiCfo({ "GET /clientes": { status: 200, cuerpo: vacio } }));
    await b.esperar(() => b.texto().includes("Sin datos de clientes en esta selección"), "vacío");
    expect(b.q("[data-testid=clientes-aviso-mostrador]")).not.toBeNull();
  });

  it("estados: 403, base sin migrar (503 y disponible:false) y error con reintento", async () => {
    await b.pintar(CfoClientes, crearApiCfo({ "GET /clientes": { status: 403 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO"), "403");
    b.desmontar();
    await b.pintar(CfoClientes, crearApiCfo({ "GET /clientes": { status: 503 } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "503");
    b.desmontar();
    const base = await respuestaBase<ClientesVista>("/clientes");
    await b.pintar(CfoClientes, crearApiCfo({ "GET /clientes": { status: 200, cuerpo: { ...base, disponible: false } } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "disponible:false");
    b.desmontar();
    await b.pintar(CfoClientes, crearApiCfo({ "GET /clientes": { status: 500, cuerpo: { message: "Falló clientes." } } }));
    await b.esperar(() => b.texto().includes("Falló clientes."), "500");
    expect(b.boton("Reintentar")).toBeDefined();
  });
});
