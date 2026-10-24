// @vitest-environment jsdom
//
// <CfoAnalisisClientes />: los siete bloques con su tooltip de definición + periodo, el orden de los segmentos, la reactivación con alias y consentimiento (sin
// PII y sin enviar nada), la afinidad con lift, la tortilla, lo que no está disponible aún, y los estados carga / error / vacío / sin acceso / base sin migrar.
// La API simulada sirve la vista del servicio REAL con datos SINTÉTICOS (e2e/mock-api/fixtures/restaurantes-cfo-analisis.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import type { AnalisisClientesVista } from "@atiende/domain-restaurantes/cfo";
import { CfoAnalisisClientes } from "../src/verticals/restaurantes/cfo/CfoAnalisisClientes.tsx";
import { CfoLayout } from "../src/verticals/restaurantes/cfo/CfoLayout.tsx";
import { PAGINAS_CFO } from "../src/verticals/restaurantes/cfo/paginas.ts";
import { crearApiCfo, propsPagina, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";
import { click, renderComponent } from "./test-utils/render.tsx";
import { elegirOpcion, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);
const b = bancoCfoB();
const listo = () => b.esperar(() => b.q("[data-testid=bloque-pendientes]") !== null, "análisis pintado");
const base = () => respuestaBase<AnalisisClientesVista>("/analisis-clientes", { limite: "50" });

describe("registro de la pestaña", () => {
  it("«Análisis de clientes» está registrada en paginas.ts, antes de Platillos, sin exportación todavía", () => {
    const slugs = PAGINAS_CFO.map((p) => p.slug);
    expect(slugs).toContain("analisis-clientes");
    expect(slugs.indexOf("analisis-clientes")).toBe(slugs.indexOf("clientes") + 1);
    const p = PAGINAS_CFO.find((x) => x.slug === "analisis-clientes")!;
    expect(p.etiqueta).toBe("Análisis de clientes");
    expect(p.vistaExportacion).toBeNull();
  });

  it("el marco del CFO es fail-closed: un rol sin cfo.ver no pide el análisis ni pinta una cifra", async () => {
    const api = crearApiCfo();
    const r = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/demo/cfo/analisis-clientes"]}>
        <CfoLayout apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role="staff" staffFullName="Persona de prueba" staffEmail="staff@ejemplo.test" fetchImpl={api.fetch} hoy="2026-09-28" />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(r.container.textContent).toContain("Tu rol no tiene acceso al CFO");
    expect(api.registro.filter((x) => x.ruta === "/analisis-clientes")).toHaveLength(0);
    r.unmount();
  });
});

describe("<CfoAnalisisClientes /> con datos", () => {
  it("pinta los bloques en orden, cada uno con su definición + periodo (botón accesible)", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const titulos = b.qa("[data-testid=chart-card] h3").map((h) => h.textContent);
    expect(titulos).toEqual(["Resumen", "Segmentos RFM", "Concentración (Pareto)", "Reactivación priorizada", "Intervalo de recompra", "Productos que se piden juntos", "Tortilla en los pedidos", "Todavía no disponible"]);
    const defs = b.qa("button[data-testid=definicion]");
    expect(defs).toHaveLength(7);
    for (const d of defs) {
      const etiqueta = d.getAttribute("aria-label") ?? "";
      expect(etiqueta, etiqueta).toMatch(/^Definición de .+: .{20,}Periodo: 21 sep a 27 sep \(7 días\)\.$/);
    }
    expect(b.q("[data-testid=analisis-periodo]")!.textContent).toContain("La recencia se mide contra el último día del periodo");
  });

  it("al pulsar el botón de un bloque se abre su definición y el periodo (también con teclado y en pantalla táctil)", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    expect(document.body.querySelector("[data-testid=definicion-texto]")).toBeNull();
    click(b.qa("button[data-testid=definicion]")[1]!);
    await b.esperar(() => document.body.querySelector("[data-testid=definicion-texto]") !== null, "definición abierta");
    const texto = document.body.querySelector("[data-testid=definicion-texto]")!.textContent ?? "";
    expect(texto).toContain("Periodo: 21 sep a 27 sep (7 días)");
    expect(texto).toContain("Días entre la última venta");
  });

  it("resumen: clientes, recompra, intervalo mediano, dormidos y venta en riesgo", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const t = b.q("[data-testid=analisis-resumen]")!.textContent ?? "";
    expect(t).toContain("Clientes con venta");
    expect(t).toContain("10");
    expect(t).toMatch(/Recompra.*70 %/);
    expect(t).toMatch(/Intervalo mediano.*10 d/);
    expect(t).toContain("Dormidos (de cualquier segmento)");
    expect(t).toContain("compraron en 2 o más días distintos");
    expect(t).toContain("$1,940");
  });

  it("segmentos RFM: los seis, en el orden de evaluación, con clientes, venta y ticket; y sus definiciones", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const filas = b.qa("table[aria-label='Segmentos RFM'] tbody tr");
    expect(filas.map((f) => f.getAttribute("data-segmento"))).toEqual(["campeon", "leal", "en_riesgo_alto_valor", "nuevo_prometedor", "dormido", "ocasional"]);
    expect(filas[0]!.textContent).toContain("Campeones");
    expect(filas[0]!.textContent).toContain("2 (20 %)");
    expect(filas[0]!.textContent).toContain("$1,400");
    expect(b.q("[data-testid=segmentos-definiciones]")!.textContent).toContain("Es la única definición de «dormido»");
    expect(b.q("[data-testid=segmentos-pocos]")).toBeNull();
  });

  it("concentración: el texto del Pareto y la tabla de datos de la gráfica", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=pareto-texto]")!.textContent).toBe("El 30 % de tus clientes reúne el 50 % de la venta y el 50 % reúne el 80 %.");
    expect(b.q("[data-testid=bloque-concentracion] [data-testid=bar-chart]")).not.toBeNull();
    expect(b.q("[data-testid=bloque-concentracion] details[data-testid=tabla-datos-grafica]")).not.toBeNull();
  });

  it("reactivación: alias de 8 caracteres, consentimiento visible, totales y nota de que no envía nada", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const filas = b.qa("table[aria-label='Clientes por reactivar'] tbody tr");
    expect(filas).toHaveLength(4);
    expect(filas.map((f) => f.getAttribute("data-alias"))).toEqual(["a1b2c3d4", "e5f6a7b8", "c9d0e1f2", "0a1b2c3d"]);
    expect(filas[0]!.textContent).toContain("Otorgado");
    expect(filas[1]!.textContent).toContain("Revocado");
    expect(filas[2]!.textContent).toContain("Sin registro");
    expect(filas[2]!.textContent).toContain("Sin ritmo propio");
    expect(b.q("[data-testid=reactivacion-resumen]")!.textContent).toContain("4 clientes por reactivar");
    expect(b.q("[data-testid=reactivacion-resumen]")!.textContent).toContain("2 otorgado, 1 revocado, 1 sin registro");
    expect(b.q("[data-testid=reactivacion-nota]")!.textContent).toContain("no envía mensajes");
    expect(b.q("[data-testid=reactivacion-nota] a")!.getAttribute("href")).toBe("/restaurantes/demo/campanas");
  });

  it("no hay controles que envíen o preparen campañas desde esta pantalla (fuera de la fase A)", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const botones = b.qa("button").map((x) => `${x.textContent} ${x.getAttribute("aria-label") ?? ""}`);
    expect(botones.join("|")).not.toMatch(/Preparar campaña|Enviar|Mandar/i);
  });

  it("cambiar «Clientes por mostrar» vuelve a pedir con ese límite", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoAnalisisClientes, api);
    await listo();
    expect(api.peticiones("GET", "/analisis-clientes")[0]!.consulta.get("limite")).toBe("50");
    await elegirOpcion(b.q("[data-testid=analisis-limite]") as HTMLElement, "100 clientes");
    await b.esperar(() => api.peticiones("GET", "/analisis-clientes").length >= 2, "segunda petición");
    expect(api.peticiones("GET", "/analisis-clientes").at(-1)!.consulta.get("limite")).toBe("100");
    // Solo se recarga la reactivación: el resto de la pantalla no vuelve a «cargando» ni se reemplaza.
    expect(b.q("[data-testid=analisis-cargando]")).toBeNull();
    expect(b.q("[data-testid=cfo-analisis-clientes]")!.getAttribute("aria-busy")).not.toBe("true");
    expect(b.q("[data-testid=bloque-resumen]")!.getAttribute("data-estado")).toBe("listo");
  });

  it("avisa en la pantalla que la lista sirve para dimensionar y que identificar clientes llegará después", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    expect(b.q("[data-testid=reactivacion-alcance]")!.textContent).toContain("sirve para dimensionar");
    expect(b.q("[data-testid=reactivacion-alcance]")!.textContent).toContain("llegará en una fase posterior");
  });

  it("rotula «Dormidos (resto)» en la tabla de segmentos, distinto de la tarjeta del resumen", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    expect(b.q("tr[data-segmento=dormido]")!.textContent).toContain("Dormidos (resto)");
    expect(b.q("[data-testid=segmentos-definiciones]")!.textContent).toContain("un campeón o un leal también puede estar dormido");
  });

  it("sin PII: ningún teléfono ni nombre, solo alias", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    expect(b.nodosDeTexto().filter((t) => /\d{10}|\+52/.test(t))).toEqual([]);
    expect(b.texto()).not.toMatch(/Cliente SINT/i);
  });

  it("intervalo de recompra: percentiles por grupo y «—» (no 0) donde hay menos de 5 intervalos", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const filas = b.qa("table[aria-label='Intervalo de recompra por segmento'] tbody tr");
    expect(filas[0]!.textContent).toContain("Todos los clientes");
    expect(filas[0]!.textContent).toContain("16.6 d");
    expect(filas[2]!.textContent).toContain("En riesgo de alto valor");
    expect(filas[2]!.textContent).toContain("—");
    expect(filas[2]!.textContent).not.toMatch(/\b0 d\b/);
  });

  it("afinidad: pares con soporte, confianza y lift; el nombre sale del catálogo y se avisa de los pares ocultos", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const filas = b.qa("table[aria-label='Pares de productos con afinidad'] tbody tr");
    expect(filas).toHaveLength(2);
    expect(filas[0]!.textContent).toContain("Flan + Refresco");
    expect(filas[0]!.textContent).toContain("1.60");
    expect(filas[1]!.textContent).toContain("Refresco + Tacos al pastor");
    expect(filas[1]!.textContent).toContain("1.50");
    const nota = b.q("[data-testid=afinidad-nota]")!.textContent ?? "";
    expect(nota).toContain("5 o más pedidos juntos");
    expect(nota).toContain("1 pares con menos pedidos se ocultan por privacidad");
    expect(nota).toContain("aproximados");
  });

  it("tortilla: maíz, harina y mixta por renglones, y las salsas como «no disponible aún»", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const filas = b.qa("table[aria-label='Tortilla por tipo'] tbody tr");
    expect(filas.map((f) => f.querySelector("td,th")?.textContent)).toEqual(["Maíz", "Harina", "Mixta"]);
    expect(filas[0]!.textContent).toContain("20 (74.1 %)");
    expect(b.q("[data-testid=tortilla-salsas]")!.textContent).toMatch(/No disponible aún: requiere decidir un campo estructurado/);
  });

  it("lo que no tiene dato honesto se lista como «no disponible aún: requiere …»", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo());
    await listo();
    const items = b.qa("[data-testid=pendientes-lista] li");
    expect(items.map((i) => i.getAttribute("data-clave"))).toEqual(["quejas_por_tipo", "respuesta_humana", "segmentos_por_producto", "salsas_omisiones", "historial_importado"]);
    for (const i of items) expect(i.textContent).toMatch(/No disponible aún: requiere /);
  });
});

describe("<CfoAnalisisClientes /> estados", () => {
  it("cargando: cada bloque muestra su propia carga hasta que llega la respuesta", async () => {
    // Una petición que nunca responde deja la pantalla en carga: cada bloque (no una sola rueda global) lo dice.
    const props = await propsPagina(crearApiCfo());
    const r = renderComponent(
      <MemoryRouter>
        <CfoAnalisisClientes {...props} api={{ ...props.api, fetchImpl: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch }} />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(r.container.querySelector("[data-testid=analisis-cargando]")).not.toBeNull();
    const bloques = [...r.container.querySelectorAll("[data-testid^=bloque-]")];
    expect(bloques.map((x) => x.getAttribute("data-testid"))).toEqual(["bloque-resumen", "bloque-segmentos", "bloque-concentracion", "bloque-reactivacion", "bloque-intervalo", "bloque-afinidad", "bloque-tortilla"]);
    for (const x of bloques) {
      expect(x.getAttribute("data-estado")).toBe("cargando");
      expect(x.querySelector("[role=status]")).not.toBeNull();
    }
    r.unmount();
  });

  it("error 500: mensaje y reintento; 403: sin acceso; 503: el CFO aún no está disponible", async () => {
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 500, cuerpo: { message: "Falló el análisis." } } }));
    await b.esperar(() => b.texto().includes("Falló el análisis."), "500");
    expect(b.boton("Reintentar")).toBeDefined();
    b.desmontar();
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 403 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO"), "403");
    expect(b.q("[data-testid=bloque-resumen]")).toBeNull();
    b.desmontar();
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 503 } }));
    await b.esperar(() => b.texto().includes("El CFO aún no está disponible"), "503");
  });

  it("sin la actualización 095: las secciones dicen «no disponible aún» con su motivo y la afinidad (081) sigue visible", async () => {
    const v = await respuestaBase<AnalisisClientesVista>("/analisis-clientes", { mock: "sin095" });
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 200, cuerpo: v } }));
    await listo();
    for (const id of ["resumen", "segmentos", "concentracion", "reactivacion", "intervalo", "tortilla"]) {
      const bloque = b.q(`[data-testid=bloque-${id}]`)!;
      expect(bloque.getAttribute("data-estado"), id).toBe("no_disponible");
      expect(bloque.textContent, id).toMatch(/No disponible aún/);
      expect(bloque.textContent, id).toMatch(/095/);
    }
    expect(b.q("[data-testid=bloque-afinidad]")!.getAttribute("data-estado")).toBe("listo");
    expect(b.q("table[aria-label='Pares de productos con afinidad']")).not.toBeNull();
  });

  it("negocio sin ventas con cliente: estados vacíos honestos en vez de ceros", async () => {
    const v = await respuestaBase<AnalisisClientesVista>("/analisis-clientes", { mock: "vacio" });
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 200, cuerpo: v } }));
    await listo();
    expect(b.q("[data-testid=bloque-resumen]")!.textContent).toContain("Sin clientes con venta en este periodo");
    expect(b.q("[data-testid=bloque-segmentos]")!.textContent).toContain("Sin clientes para segmentar");
    expect(b.q("[data-testid=bloque-concentracion]")!.textContent).toContain("Sin ventas para medir la concentración");
    expect(b.q("[data-testid=bloque-reactivacion]")!.textContent).toContain("Nadie por reactivar");
    expect(b.q("[data-testid=bloque-intervalo]")!.textContent).toContain("Aún no hay compras repetidas");
    expect(b.q("[data-testid=bloque-afinidad]")!.textContent).toContain("Sin pares frecuentes");
    expect(b.q("[data-testid=bloque-tortilla]")!.textContent).toContain("Sin renglones con tortilla");
    expect(b.texto()).not.toMatch(/\b0 %/);
  });

  it("una sección con error del servidor se dice «no disponible aún» sin filtrar el motivo técnico", async () => {
    const v = await base();
    const conError: AnalisisClientesVista = { ...v, disponible: false, secciones: { ...v.secciones, tortilla: { disponible: false, motivo: "No se pudo leer esta sección. Intente de nuevo en unos minutos.", datos: null } } };
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 200, cuerpo: conError } }));
    await listo();
    expect(b.q("[data-testid=bloque-tortilla]")!.textContent).toContain("No se pudo leer esta sección");
    expect(b.q("[data-testid=bloque-resumen]")!.getAttribute("data-estado")).toBe("listo");
  });

  it("pocos clientes: avisa que los puntajes no son estables", async () => {
    const v = await base();
    const poco: AnalisisClientesVista = { ...v, secciones: { ...v.secciones, segmentos: { ...v.secciones.segmentos, datos: { ...v.secciones.segmentos.datos!, pocosClientes: true } } } };
    await b.pintar(CfoAnalisisClientes, crearApiCfo({ "GET /analisis-clientes": { status: 200, cuerpo: poco } }));
    await listo();
    expect(b.q("[data-testid=segmentos-pocos]")!.textContent).toContain("menos de 5 clientes");
  });

  it("pide la ruta correcta con el rango y el límite por omisión", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoAnalisisClientes, api);
    await listo();
    const q = api.peticiones("GET", "/analisis-clientes")[0]!.consulta;
    expect(q.get("desde")).toBe("2026-09-21");
    expect(q.get("hasta")).toBe("2026-09-27");
    expect(q.get("limite")).toBe("50");
  });
});
