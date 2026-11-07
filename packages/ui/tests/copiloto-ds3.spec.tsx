// @vitest-environment jsdom
//
// «Pregúntale a tus datos» en el diseno ds3 (piezas nuevas del shell compartido): temas con preguntas, historial con la anatomia del
// Drawer (cabecera, «Chat nuevo», grupos Hoy/Ayer/7/30 dias/Anteriores, pie y logo), «Cómo se calculó» con la evidencia que mando el
// servidor, y textos en ES/EN. Todo lo nuevo nace con `hidden` (+ `ds3-solo`): la bandera lo revela por CSS (ds3-copiloto-css.spec.ts);
// sin ella no se ve ni se anuncia y la pantalla actual no cambia.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { partirUltimoMes } from "../src/components/copiloto/formato";
import { traductorCopiloto } from "../src/components/copiloto/idioma";
import type { ConversacionResumen } from "../src/components/copiloto/tipos";
import { CLAVE_IDIOMA, guardarIdioma } from "../src/lib/idioma";
import { textoMs } from "../src/components/copiloto/CopilotoTraza";
import { RESPUESTA_OK, clic, envioColgado, limpiarDom, microtareas, montar, propsBase, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  window.localStorage.removeItem(CLAVE_IDIOMA);
});

const AHORA = new Date("2026-10-01T18:00:00Z");
const ZONA = "America/Mexico_City";
const CONVS: ConversacionResumen[] = [
  { id: "c1", titulo: "Ventas de hoy", actualizadaEn: "2026-10-01T16:00:00Z" },
  { id: "c2", titulo: "Hace dos semanas", actualizadaEn: "2026-09-17T20:00:00Z" },
  { id: "c3", titulo: "Hace dos meses", actualizadaEn: "2026-08-01T20:00:00Z" },
];
const visibles = (raiz: ParentNode, sel: string) => Array.from(raiz.querySelectorAll<HTMLElement>(sel)).filter((e) => !e.closest("[hidden]"));

describe("temas sugeridos (ds3)", () => {
  it("salen de las categorias de la vertical, nacen ocultos y elegir una pregunta la envia", async () => {
    const { t, enviar } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { directas: { "Ticket medio": { tool: "ticket_medio" } } })} />);
    const temas = montado.container.querySelector("[data-testid=copiloto-temas]") as HTMLElement;
    expect(temas.hidden).toBe(true);
    expect(temas.className).toContain("ds3-solo");
    const botones = Array.from(temas.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
    expect(botones.map((b) => b.textContent)).toEqual(["Ventas", "Operación", "Clientes"]);
    expect(botones.map((b) => b.dataset.serie)).toEqual(["1", "2", "3"]);
    expect(botones[0]?.getAttribute("aria-pressed")).toBe("true");
    clic(botones[1] as HTMLButtonElement);
    expect(botones[1]?.getAttribute("aria-pressed")).toBe("true");
    // La pregunta se pinta por CSS (::before desde data-pregunta) y se anuncia por aria-label: no es texto del DOM sin la bandera.
    expect(Array.from(temas.querySelectorAll("[data-pregunta]")).map((b) => [b.getAttribute("data-pregunta"), b.getAttribute("aria-label"), b.textContent])).toEqual([["Pedidos por canal", "Pedidos por canal", ""]]);
    clic(botones[0] as HTMLButtonElement);
    clic(temas.querySelector("[title='Ticket medio']") as HTMLButtonElement);
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]?.[0]).toMatchObject({ pregunta: "Ticket medio", directa: { tool: "ticket_medio" } });
  });

  it("con temas, «Consulta» y los chips sueltos quedan marcados para apagarse bajo la bandera (sin cambiar la pantalla actual)", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    expect(c.querySelector("[data-ds3='consulta']")?.textContent).toContain("Consulta");
    expect(c.querySelector("[data-ds3='chips-con-temas']")?.textContent).toContain("¿Cuánto vendí esta semana?");
    expect(c.querySelector("[data-ds3-copiloto]")).not.toBeNull();
  });

  it("sin categorias no hay temas y los chips siguen", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { categorias: [] })} />);
    expect(montado.container.querySelector("[data-testid=copiloto-temas]")).toBeNull();
    expect(montado.container.querySelector("[data-ds3='chips']")).not.toBeNull();
  });
});

describe("historial con la anatomia del Drawer (ds3)", () => {
  async function abrirHistorial(listar = vi.fn(async () => CONVS)) {
    const { t } = transporteFalso({ listar, borrar: vi.fn(async () => undefined), renombrar: vi.fn(async () => undefined) });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA })} />);
    clic(montado.container.querySelector("button[aria-controls]") as HTMLButtonElement);
    await microtareas();
    return montado.container.querySelector("[role=dialog]") as HTMLElement;
  }

  it("cabecera «Historial» con cuantos chats hay en la cuenta, pie de privacidad y logo: todo oculto sin la bandera", async () => {
    const panel = await abrirHistorial();
    const cabecera = panel.querySelector("header") as HTMLElement;
    expect(cabecera.hidden).toBe(true);
    expect(cabecera.textContent).toContain("Historial");
    expect(cabecera.textContent).toContain("3 chats guardados en tu cuenta");
    expect((panel.querySelector("footer") as HTMLElement).textContent).toContain("Se guardan en tu cuenta de Atiende");
    const marca = panel.querySelector("[data-testid=copiloto-hist-marca]") as HTMLElement;
    expect(marca.hidden).toBe(true);
    expect(marca.getAttribute("aria-hidden")).toBe("true");
    expect(panel.querySelector("[data-testid=copiloto-hist-agarre]")?.hasAttribute("hidden")).toBe(true);
    // Sin la bandera, ningun control nuevo es alcanzable: los visibles son los de siempre.
    expect(visibles(panel, "button").map((b) => b.getAttribute("aria-label"))).toContain("Cerrar historial");
    const cerrarDs3 = panel.querySelector(".ds3-copiloto-hist-cerrar") as HTMLButtonElement;
    expect(cerrarDs3.hidden).toBe(true);
    expect(cerrarDs3.getAttribute("aria-label")).toBe("Cerrar historial");
  });

  it("«Chat nuevo» se pinta junto a «Nuevo chat» (uno por diseno) y la fila lleva la clase de 40 px", async () => {
    const panel = await abrirHistorial();
    const nuevo = panel.querySelector(".ds3-copiloto-hist-nuevo") as HTMLButtonElement;
    expect(visibles(nuevo, "span").map((s) => s.textContent)).toEqual(["Nuevo chat"]);
    expect((nuevo.querySelector(".ds3-solo") as HTMLElement).textContent).toBe("Chat nuevo");
    expect(panel.querySelectorAll(".ds3-copiloto-hist-titulo")).toHaveLength(3);
  });

  it("«Anteriores» del diseno actual se parte en «Últimos 30 días» + «Anteriores» para ds3, sin cambiar lo que se ve hoy", async () => {
    const panel = await abrirHistorial();
    const encabezados = visibles(panel, "h2").map((h) => visibles(h, "span").map((s) => s.textContent).join("") || h.textContent);
    expect(encabezados).toEqual(["Hoy", "Anteriores"]);
    const ds3 = Array.from(panel.querySelectorAll<HTMLElement>("h2 .ds3-solo, h2.ds3-solo")).map((h) => h.textContent);
    expect(ds3).toEqual(["Últimos 30 días", "Anteriores"]);
    const titulos = Array.from(panel.querySelectorAll(".ds3-copiloto-hist-titulo")).map((b) => b.textContent);
    expect(titulos).toEqual(["Ventas de hoy", "Hace dos semanas", "Hace dos meses"]);
  });

  it("el velo (clic fuera) cierra el panel", async () => {
    const panel = await abrirHistorial();
    expect(panel).not.toBeNull();
    const velo = montado?.container.querySelector(".ds3-copiloto-velo") as HTMLElement;
    expect(velo.hidden).toBe(true);
    clic(velo);
    await new Promise((r) => setTimeout(r, 520));
    await microtareas();
    expect(montado?.container.querySelector("[role=dialog]")).toBeNull();
  });

  it("partirUltimoMes: 8 a 30 dias en la zona de la organizacion, el resto aparte, mismo orden", () => {
    const { mes, resto } = partirUltimoMes(CONVS.slice(1), AHORA, ZONA);
    expect(mes.map((c) => c.id)).toEqual(["c2"]);
    expect(resto.map((c) => c.id)).toEqual(["c3"]);
    expect(partirUltimoMes([{ id: "x", titulo: "x", actualizadaEn: "no-es-fecha" }], AHORA, ZONA).resto).toHaveLength(1);
  });
});

describe("«Cómo se calculó» (ds3)", () => {
  it("bajo una respuesta con fuentes abre el Drawer con fuente, periodo, alcance y la consulta legible", async () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    clic(Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    await microtareas();
    const boton = c.querySelector(".ds3-copiloto-calculo") as HTMLButtonElement;
    expect(boton.closest("[hidden]")).not.toBeNull();
    clic(boton);
    await microtareas();
    const drawer = document.querySelector("[data-testid=copiloto-como-se-calculo]") as HTMLElement;
    expect(drawer).not.toBeNull();
    const dialogo = drawer.closest("[role=dialog]") as HTMLElement;
    expect(dialogo.textContent).toContain("Cómo se calculó: Ventas por día");
    expect(drawer.textContent).toContain("Pedidos");
    expect(drawer.textContent).toContain("Últimos 7 días");
    expect(drawer.textContent).toContain("Todas tus sucursales");
    expect(dialogo.textContent).toContain("Leyendo ventas por día · 2 filas");
    expect(dialogo.textContent).not.toContain("Qué no sabemos");
  });

  it("una tabla recortada aparece en «Qué no sabemos»; una respuesta sin fuentes ni bloques no ofrece el boton", async () => {
    const recortada = { ...RESPUESTA_OK, blocks: RESPUESTA_OK.blocks?.map((b) => ({ ...b, truncated: true })) };
    const { t } = transporteFalso({ enviar: vi.fn(async () => recortada) });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    clic(Array.from(montado.container.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    await microtareas();
    clic(montado.container.querySelector(".ds3-copiloto-calculo") as HTMLButtonElement);
    await microtareas();
    expect(document.body.textContent).toContain("Qué no sabemos");
    montado.unmount();
    limpiarDom();

    const { t: t2 } = transporteFalso({ enviar: vi.fn(async () => ({ text: "Hola.", status: "ok" as const })) });
    montado = montar(<ChatDatosShell {...propsBase(t2)} />);
    clic(Array.from(montado.container.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    await microtareas();
    expect(montado.container.textContent).toContain("Hola.");
    expect(montado.container.querySelector(".ds3-copiloto-calculo")).toBeNull();
  });
});

describe("pensamiento en vivo y «Cómo llegué a esto» (ds3)", () => {
  it("mientras piensa: «Pensamiento del sistema en vivo · n» (oculto sin bandera) pliega y despliega los pasos", async () => {
    const colgado = envioColgado();
    const { t } = transporteFalso({ enviar: colgado.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    clic(Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    const { act } = await import("react");
    act(() => colgado.emitir({ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" }));
    const pensando = c.querySelector("[data-testid=copiloto-pensando]") as HTMLElement;
    const toggle = pensando.querySelector(".ds3-copiloto-pensamiento") as HTMLButtonElement;
    expect(toggle.hidden).toBe(true);
    expect(toggle.textContent).toBe("Pensamiento del sistema en vivo · 1");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const lista = pensando.querySelector("ul") as HTMLElement;
    expect(lista.hidden).toBe(false);
    expect(lista.textContent).toContain("Leyendo ventas por día");
    clic(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(lista.hidden).toBe(true);
    act(() => colgado.p.resolver(RESPUESTA_OK));
    await microtareas();
  });

  it("al terminar, la respuesta lleva la traza de pasos del servidor con su tiempo; sin pasos no hay traza", async () => {
    const { t } = transporteFalso({
      enviar: vi.fn(async (args) => {
        args.onEvento({ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" });
        args.onEvento({ t: "paso", fase: "fin", herramienta: "ventas_por_dia" });
        return RESPUESTA_OK;
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    clic(Array.from(montado.container.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    await microtareas();
    const traza = montado.container.querySelector("[data-testid=copiloto-traza]") as HTMLElement;
    expect(traza.closest("[hidden]")).not.toBeNull();
    expect(traza.querySelector("summary")?.textContent).toMatch(/^Cómo llegué a esto · 1 paso · \d+ ms$/);
    expect(traza.querySelector("li")?.textContent).toMatch(/^Leyendo ventas por día · \d+ ms$/);
    expect(montado.container.querySelector(".ds3-copiloto-calculo")?.textContent).toBe("Ver cómo lo calculé");
    montado.unmount();
    limpiarDom();

    const { t: t2 } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t2)} />);
    clic(Array.from(montado.container.querySelectorAll("button")).find((b) => b.textContent === "¿Cuánto vendí esta semana?") as HTMLButtonElement);
    await microtareas();
    await microtareas();
    expect(montado.container.querySelector("[data-testid=copiloto-traza]")).toBeNull();
  });

  it("textoMs: ms por debajo de un segundo y segundos con un decimal", () => {
    expect(textoMs(850)).toBe("850 ms");
    expect(textoMs(1234)).toBe("1.2 s");
    expect(textoMs(1234, "en")).toBe("1.2 s");
    expect(textoMs(null)).toBe("");
  });
});

describe("idioma (ES/EN)", () => {
  it("en espanol los textos son los de siempre; en ingles cambia la carroceria", () => {
    const es = traductorCopiloto("es");
    const en = traductorCopiloto("en");
    expect(es("historialAria")).toBe("Historial de chats");
    expect(es("subtituloVarios", { n: 4 })).toBe("4 chats guardados en tu cuenta");
    expect(en("historial")).toBe("History");
    expect(en("grupoMes")).toBe("Last 30 days");
    expect(en("comoSeCalculoDe", { t: "Sales" })).toBe("How it was calculated: Sales");
  });

  it("el boton de historial sigue la preferencia del selector de idioma en vivo", async () => {
    const { t } = transporteFalso({ listar: vi.fn(async () => CONVS) });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const boton = montado.container.querySelector("button[aria-controls]") as HTMLButtonElement;
    expect(boton.getAttribute("aria-label")).toBe("Historial de chats");
    const { act } = await import("react");
    act(() => guardarIdioma("en"));
    expect(boton.getAttribute("aria-label")).toBe("Chat history");
    expect(boton.textContent).toContain("History");
  });
});
