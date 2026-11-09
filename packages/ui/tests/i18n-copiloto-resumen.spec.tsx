// @vitest-environment jsdom
//
// i18n ES/EN del Copiloto («Pregúntale a tus datos») y del marco del Resumen. En espanol los textos son los de siempre (las demas
// pruebas de copiloto-* y resumen-* los fijan byte a byte); en ingles cambia la carroceria completa: compositor, acciones, avisos,
// graficas, tarjeta de accion, fijados, antetitulo/H1 del Resumen y «Requiere tu atención». Lo que manda el servidor (texto de la
// respuesta, titulos de tabla, fuentes) y lo que escribe el cliente no se traduce aqui.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ResumenLayout } from "../src/components/ResumenLayout";
import { CopilotoAcciones } from "../src/components/copiloto/CopilotoAcciones";
import { CopilotoCompositor } from "../src/components/copiloto/CopilotoCompositor";
import { textoAviso } from "../src/components/copiloto/CopilotoMensaje";
import { CopilotoTarjetaAccion } from "../src/components/copiloto/CopilotoTarjetaAccion";
import { SeccionFijadosCopiloto } from "../src/components/copiloto/SeccionFijadosCopiloto";
import { planGrafica, resumenAria, valorCompacto } from "../src/components/copiloto/CopilotoGraficas";
import { traductorCopiloto } from "../src/components/copiloto/idioma";
import type { CopilotoAccionesCliente, CopilotoBloque, CopilotoTransporte, FijadosCliente } from "../src/components/copiloto/tipos";
import { IdiomaProvider, cargarIdioma } from "../src/i18n/index";
import { CLAVE_IDIOMA, guardarIdioma } from "../src/lib/idioma";
import { montar, type Montado } from "./copiloto-utils";

let montado: Montado | null = null;

beforeAll(() => cargarIdioma("en"));

afterEach(() => {
  montado?.unmount();
  montado = null;
  window.localStorage.removeItem(CLAVE_IDIOMA);
  delete document.documentElement.dataset.diseno;
});

const enIngles = () => {
  document.documentElement.dataset.diseno = "ds3";
  window.localStorage.setItem(CLAVE_IDIOMA, "en");
};

const ESPANOL = /[áéíóúñ¿¡]|\b(de|el|la|los|las|para|tus|una?)\b/i;

describe("catalogo del Copiloto", () => {
  it("los textos nuevos de la pagina, la respuesta, la tarjeta y los fijados tienen su ingles", () => {
    const es = traductorCopiloto("es");
    const en = traductorCopiloto("en");
    // (`csv`, `csvDe` y `ariaValores` son iguales a proposito: sigla o solo variables.)
    for (const clave of ["paginaPreparando", "paginaProntoMensaje", "usoHoy", "consulta", "avisoSinDatos", "filasMostradasMas", "fijadosTitulo", "fijadosVacio", "accionEjecutada", "motivoAyuda", "notaDona", "borrarTitulo", "errorAbrir"] as const) {
      expect(en(clave)).not.toBe(es(clave));
      expect(en(clave)).not.toMatch(ESPANOL);
    }
  });
});

describe("Resumen (marco)", () => {
  it("en espanol el antetitulo y el H1 dicen «Resumen»; en ingles «Overview», con «Needs your attention»", () => {
    montado = montar(
      <IdiomaProvider>
        <ResumenLayout saludo="Hola" nombre="Ana" atencion={[]} estadoDatos={[{ etiqueta: "x", valor: "1" }]} />
      </IdiomaProvider>,
    );
    const c = montado.container;
    expect(c.querySelector('[data-parte="eyebrow"]')?.textContent).toBe("Resumen");
    expect(c.querySelector('[data-testid="resumen-titulo-ds3"]')?.textContent).toBe("Resumen");
    expect(c.querySelector('[data-parte="atencion"] h2')?.textContent).toBe("Requiere tu atención (0)");
    expect(c.querySelector('[data-parte="estado-datos"]')?.getAttribute("aria-label")).toBe("Estado de los datos");
    document.documentElement.dataset.diseno = "ds3";
    act(() => guardarIdioma("en"));
    expect(c.querySelector('[data-parte="eyebrow"]')?.textContent).toBe("Overview");
    expect(c.querySelector('[data-testid="resumen-titulo-ds3"]')?.textContent).toBe("Overview");
    expect(c.querySelector('[data-parte="atencion"] h2')?.textContent).toBe("Needs your attention (0)");
    expect(c.querySelector('[data-parte="atencion-vacia"]')?.textContent).toBe("Nothing needs your attention right now.");
    expect(c.querySelector('[data-parte="estado-datos"]')?.getAttribute("aria-label")).toBe("Data status");
  });

  it("un antetitulo o titulo explicito de la pagina gana sobre el del catalogo", () => {
    enIngles();
    montado = montar(
      <IdiomaProvider>
        <ResumenLayout saludo="Hi" nombre="Ana" eyebrow="Money" titulo="Today" />
      </IdiomaProvider>,
    );
    expect(montado.container.querySelector('[data-parte="eyebrow"]')?.textContent).toBe("Money");
    expect(montado.container.querySelector('[data-testid="resumen-titulo-ds3"]')?.textContent).toBe("Today");
  });
});

const BLOQUE: CopilotoBloque = {
  tool: "ventas",
  title: "Ventas",
  columns: [
    { key: "dia", label: "Día", kind: "text" },
    { key: "total", label: "Total", kind: "mxn" },
  ],
  rows: [
    { dia: "Lun", total: 1500 },
    { dia: "Mar", total: 2500 },
  ],
  truncated: false,
};

describe("Copiloto en ingles", () => {
  it("compositor: pregunta, consulta, enviar y adjuntar", () => {
    enIngles();
    montado = montar(
      <CopilotoCompositor
        valor=""
        onCambia={() => undefined}
        onEnviar={() => undefined}
        onDetener={() => undefined}
        onConsulta={() => undefined}
        enviando={false}
        placeholder="Ask about your business…"
        maxCaracteres={600}
        categoriasId="cat"
        categoriasVisibles={false}
        inputId="q"
        adjuntos={{ accept: ".csv", maxBytes: 1024 }}
        onAdjuntar={() => undefined}
      />,
    );
    const c = montado.container;
    expect(c.querySelector("form")?.getAttribute("aria-label")).toBe("Ask the Copilot");
    expect(c.querySelector("label")?.textContent).toBe("Your question");
    expect(c.querySelector('[data-ds3="consulta"]')?.textContent).toBe("Explore");
    expect(c.querySelector('[data-ds3="enviar"]')?.getAttribute("aria-label")).toBe("Send");
    expect(c.querySelector('[data-ds3="adjuntar"]')?.getAttribute("title")).toBe("Attach file (CSV, Excel or PDF)");
  });

  it("acciones de la respuesta", () => {
    enIngles();
    const transporte = { enviar: vi.fn(), fijar: vi.fn(), urlPdf: () => "/x.pdf" } as unknown as CopilotoTransporte;
    montado = montar(
      <CopilotoAcciones mensaje={{ id: "a", role: "assistant", text: "ok", seq: 1, blocks: [BLOQUE] }} conversacionId="c1" transporte={transporte} esUltima ocupado={false} onRegenerar={() => undefined} />,
    );
    const textos = Array.from(montado.container.querySelectorAll("button, a")).map((b) => b.textContent?.trim());
    expect(textos).toEqual(["Copy", "CSV", "Download PDF", "Pin", "Regenerate"]);
    expect(montado.container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy answer");
  });

  it("avisos por estado y textos de las graficas", () => {
    const en = traductorCopiloto("en");
    expect(textoAviso({ status: "no_data" }, en)).toBe("There's no data for that period.");
    expect(textoAviso({ status: "rate_limited", limiteDiario: 20 }, en)).toBe("You've used your 20 questions for today.");
    expect(textoAviso({ status: "rate_limited", reintentarEnSeg: 30 }, en)).toBe("Too many questions in a row; wait 30 s.");
    // Sin traductor sigue en espanol (las pruebas de copiloto-estados lo fijan).
    expect(textoAviso({ status: "no_data" })).toBe("No hay datos para ese periodo.");
    const plan = planGrafica({ ...BLOQUE, chart: { kind: "bar", x: "dia", y: "total" } }, en);
    expect(plan && resumenAria("Sales", plan, en)).toBe("Sales, bars: Lun $1,500.00; Mar $2,500.00.");
    expect(valorCompacto("integer", 1500, "en")).toBe("1.5K");
    expect(valorCompacto("integer", 1500)).not.toBe("1.5K");
  });

  it("tarjeta de accion propuesta", async () => {
    enIngles();
    const cliente: CopilotoAccionesCliente = {
      consultar: vi.fn(async () => ({ estado: "vencida" as const, resumen: "Pause agent" })),
      confirmar: vi.fn(),
      enlacePendientes: "/acciones",
    } as unknown as CopilotoAccionesCliente;
    montado = montar(<CopilotoTarjetaAccion propuesta={{ propuesta: "p1", clase: "intent", tipo: "x", resumen: "Pause agent" }} cliente={cliente} />);
    await act(async () => undefined);
    const c = montado.container;
    expect(c.querySelector("section")?.getAttribute("aria-label")).toBe("Action proposed by the Copilot");
    expect(c.textContent).toContain("Expired");
    expect(c.textContent).toContain("It expired without confirmation. Ask the Copilot to prepare it again.");
    expect(c.textContent).toContain("See pending items in Actions");
  });

  it("fijados del Resumen", async () => {
    enIngles();
    const cliente = { listar: vi.fn(async () => ({ disponible: true, fijados: [] })) } as unknown as FijadosCliente;
    montado = montar(<SeccionFijadosCopiloto cliente={cliente} rutaCopiloto="/copiloto" />);
    await act(async () => undefined);
    expect(montado.container.textContent).toContain("Copilot pins");
    expect(montado.container.textContent).toContain("You haven't pinned anything yet.");
    expect(montado.container.querySelector("a")?.textContent).toBe("Open the Copilot");
  });
});
