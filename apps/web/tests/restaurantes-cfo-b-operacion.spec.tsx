// @vitest-environment jsdom
//
// <CfoOperacion />: tiempos de entrega con «p90 del conjunto, no suma», repartidores, embudo del agente, escalaciones por hora y costo del agente con
// «Meta: no medido» (nunca $0) y la IA de texto «No asignado». Datos SINTÉTICOS.
import { describe, expect, it, vi } from "vitest";
import type { OperacionVista } from "@atiende/domain-restaurantes/cfo";
import { CfoOperacion } from "../src/verticals/restaurantes/cfo/CfoOperacion.tsx";
import { crearApiCfo, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";
import { click } from "./test-utils/render.tsx";

const b = bancoCfoB();
const listo = () => b.esperar(() => b.q("[data-testid=cfo-operacion] [data-testid=chart-card]") !== null, "operación pintada");

describe("<CfoOperacion />", () => {
  it("trae entregas, entregas por hora, repartidores, embudo, escalaciones y costo del agente", async () => {
    await b.pintar(CfoOperacion, crearApiCfo());
    await listo();
    expect(b.qa("[data-testid=chart-card] h3").map((h) => h.textContent)).toEqual(["Tiempos de entrega por sucursal", "Tiempo de entrega por hora", "Repartidores", "Embudo del agente", "Escalaciones por hora", "Costo del agente"]);
    expect(b.q("[data-testid=embudo-agente]")!.textContent).toMatch(/WhatsApp: conversaciones/);
    expect(b.q("[data-testid=embudo-agente]")!.textContent).toMatch(/Voz: llamadas/);
  });

  it("el p90 del conjunto se rotula «p90 del conjunto, no suma»", async () => {
    await b.pintar(CfoOperacion, crearApiCfo());
    await listo();
    const conjunto = b.q("tr[data-tipo=conjunto]")!;
    expect(conjunto.textContent).toContain("p90 del conjunto, no suma");
    expect(b.qa("tr[data-tipo=sucursal]").length).toBe(7);
    for (const s of b.qa("tr[data-tipo=sucursal]")) expect(s.textContent).not.toContain("p90 del conjunto");
  });

  it("Meta sin eventos dice «No medido» y «Meta: no medido», nunca $0; la IA de texto va como «No asignado»", async () => {
    await b.pintar(CfoOperacion, crearApiCfo());
    await listo();
    const costo = b.q("[data-testid=costo-agente]")!;
    const meta = [...costo.children].find((c) => c.textContent?.includes("Meta (WhatsApp)"))!;
    expect(meta.textContent).toContain("No medido");
    expect(meta.textContent).toContain("Meta: no medido");
    expect(meta.textContent).not.toContain("$0");
    expect(costo.textContent).toContain("IA de texto · No asignado");
    expect(b.q("[data-testid=meta-no-medido]")!.textContent).toContain("no es $0");
  });

  it("con Meta medido se muestra el monto y no el aviso", async () => {
    const base = await respuestaBase<OperacionVista>("/operacion");
    const cuerpo = { ...base, costoAgente: { ...base.costoAgente, total: { ...base.costoAgente.total, meta: { valor: 12_345, confianza: "medido", fuente: "x" } } } };
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 200, cuerpo } }));
    await listo();
    const meta = [...b.q("[data-testid=costo-agente]")!.children].find((c) => c.textContent?.includes("Meta (WhatsApp)"))!;
    expect(meta.textContent).toContain("$123.45");
    expect(b.q("[data-testid=meta-no-medido]")).toBeNull();
  });

  it("sin organización completa (admin acotado) la tarjeta «IA de texto · No asignado» no se muestra; con ella, sí", async () => {
    const base = await respuestaBase<OperacionVista>("/operacion");
    const acotado = { ...base, alcance: { ...base.alcance, organizacionCompleta: false }, costoAgente: { ...base.costoAgente, noAsignado: null } };
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 200, cuerpo: acotado } }));
    await listo();
    expect(b.q("[data-testid=costo-agente]")!.textContent).not.toContain("IA de texto");
    expect(b.q("[data-testid=costo-agente]")!.textContent).toContain("Voz");
    b.desmontar();
    await b.pintar(CfoOperacion, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=costo-agente]")!.textContent).toContain("IA de texto · No asignado");
  });

  it("repartidores: por nombre del personal, con entregas, tiempo, tarde e incidencias", async () => {
    await b.pintar(CfoOperacion, crearApiCfo());
    await listo();
    const tabla = b.q("table[aria-label='Repartidores']")!;
    expect([...tabla.querySelectorAll("thead th")].map((t) => t.textContent?.trim())).toEqual(["Repartidor", "Sucursal", "Entregas", "Tiempo prom.", "Tarde", "Incidencias"]);
    expect(tabla.textContent).toContain("Repartidor SINTÉTICO");
  });

  it("el botón de entregas tardías abre la lista de pedidos con ese filtro", async () => {
    const abrir = vi.fn();
    await b.pintar(CfoOperacion, crearApiCfo(), { abrirPedidos: abrir });
    await listo();
    click(b.boton("Ver entregas tardías"));
    expect(abrir).toHaveBeenCalledWith({ entrega_tarde: true });
  });

  it("sin operación: estado vacío honesto", async () => {
    const base = await respuestaBase<OperacionVista>("/operacion");
    const cero = { ...base, entregas: base.entregas.map((e) => ({ ...e, entregados: 0 })), embudo: { ...base.embudo, total: { ...base.embudo.total, whatsapp: { ...base.embudo.total.whatsapp, conversaciones: 0 }, voz: { ...base.embudo.total.voz, llamadas: 0 } } } };
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 200, cuerpo: cero } }));
    await b.esperar(() => b.texto().includes("Sin operación en este periodo"), "vacío");
  });

  it("estados: 403, base sin migrar, disponible:false y error con reintento", async () => {
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 403 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO"), "403");
    b.desmontar();
    const base = await respuestaBase<OperacionVista>("/operacion");
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 200, cuerpo: { ...base, disponible: false } } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "no disponible");
    b.desmontar();
    await b.pintar(CfoOperacion, crearApiCfo({ "GET /operacion": { status: 500, cuerpo: { message: "Falló operación." } } }));
    await b.esperar(() => b.texto().includes("Falló operación."), "500");
    expect(b.boton("Reintentar")).toBeDefined();
  });
});
