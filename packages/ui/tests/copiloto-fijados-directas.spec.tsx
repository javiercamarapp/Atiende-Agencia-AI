// @vitest-environment jsdom
//
// CHAT-06 / CHAT-15 en la UI: los chips y tarjetas con consulta directa viajan SIN modelo (`directa` en el transporte); lo
// escrito a mano y lo que no tiene mapa pasa por el modelo; "Regenerar" de un chip repite la consulta directa; cada bloque se fija
// por separado; y el tablero de fijados (SeccionFijadosCopiloto) lista, re-ejecuta, comparte y quita contra un cliente inyectado.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { SeccionFijadosCopiloto, MAX_FIJADOS_VISIBLES } from "../src/components/copiloto/SeccionFijadosCopiloto";
import { FijadosErrorCliente, type CopilotoDirecta, type FijadoResultado, type FijadoResumen, type FijadosCliente } from "../src/components/copiloto/tipos";
import { clic, escribir, limpiarDom, microtareas, montar, porEtiqueta, porTexto, propsBase, RESPUESTA_OK, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const DIRECTA_VENTAS: CopilotoDirecta = { tool: "ventas_por_dia", args: { periodo: "esta_semana" } };
const DIRECTA_TICKET: CopilotoDirecta = { tool: "ticket_medio", args: { periodo: "este_mes" } };
const DIRECTAS = { "¿Cuánto vendí esta semana?": DIRECTA_VENTAS, "Ticket medio": DIRECTA_TICKET };

function montarShell(transporteOver = {}) {
  const fake = transporteFalso(transporteOver);
  montado = montar(<ChatDatosShell {...propsBase(fake.t, { directas: DIRECTAS })} />);
  return { c: montado.container, ...fake };
}

describe("chips con consulta directa (sin modelo)", () => {
  it("un chip con mapa manda `directa` y su texto como etiqueta", async () => {
    const { c, enviar } = montarShell();
    clic(porTexto(c, "button", "¿Cuánto vendí esta semana?"));
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]![0]).toMatchObject({ pregunta: "¿Cuánto vendí esta semana?", directa: DIRECTA_VENTAS });
  });

  it("un chip SIN mapa pasa por el modelo (sin `directa`)", async () => {
    const { c, enviar } = montarShell();
    clic(porTexto(c, "button", "¿Cuál es mi ticket medio?"));
    await microtareas();
    expect(enviar.mock.calls[0]![0].directa).toBeUndefined();
  });

  it("lo escrito a mano NUNCA va por la ruta directa, aunque coincida con un chip", async () => {
    const { c, enviar } = montarShell();
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "¿Cuánto vendí esta semana?");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    expect(enviar.mock.calls[0]![0].directa).toBeUndefined();
  });

  it("las tarjetas de la portada tambien usan la consulta directa", async () => {
    const { c, enviar } = montarShell();
    clic(porTexto(c, "button", "Consulta"));
    await microtareas();
    clic(porTexto(c, "button", "Ticket medio"));
    await microtareas();
    expect(enviar.mock.calls[0]![0]).toMatchObject({ pregunta: "Ticket medio", directa: DIRECTA_TICKET });
  });

  it("Regenerar la respuesta de un chip repite la MISMA consulta directa; despues de una pregunta escrita ya no", async () => {
    const { c, enviar } = montarShell();
    clic(porTexto(c, "button", "¿Cuánto vendí esta semana?"));
    await microtareas();
    clic(porEtiqueta(c, "Regenerar respuesta"));
    await microtareas();
    expect(enviar.mock.calls[1]![0]).toMatchObject({ pregunta: "¿Cuánto vendí esta semana?", directa: DIRECTA_VENTAS });
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "otra cosa");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    clic(porEtiqueta(c, "Regenerar respuesta"));
    await microtareas();
    expect(enviar.mock.calls[3]![0]).toMatchObject({ pregunta: "otra cosa" });
    expect(enviar.mock.calls[3]![0].directa).toBeUndefined();
  });
});

describe("fijar por bloque", () => {
  it("una respuesta con dos tablas ofrece un boton por bloque y fija el indice correcto", async () => {
    const dos = { ...RESPUESTA_OK, blocks: [RESPUESTA_OK.blocks![0]!, { ...RESPUESTA_OK.blocks![0]!, tool: "ticket_medio", title: "Ticket medio" }] };
    const fijar = vi.fn().mockResolvedValue(undefined);
    const enviar = vi.fn(async (p: { onEvento: (e: never) => void }) => {
      p.onEvento({ t: "fin", respuesta: dos, conversacionId: "conv-1" } as never);
      return dos;
    });
    const fake = transporteFalso({ fijar, enviar: enviar as never });
    montado = montar(<ChatDatosShell {...propsBase(fake.t)} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    expect(c.querySelector("[aria-label='Fijar en el tablero']")).toBeNull();
    clic(porEtiqueta(c, "Fijar Ticket medio en el tablero"));
    await microtareas();
    expect(fijar).toHaveBeenCalledWith("conv-1", 2, 1);
    expect(porEtiqueta<HTMLButtonElement>(c, "Fijar Ticket medio en el tablero").textContent).toContain("Fijado");
    expect(porEtiqueta<HTMLButtonElement>(c, "Fijar Ventas por día en el tablero").textContent).toContain("Fijar");
  });
});

const BLOQUE = RESPUESTA_OK.blocks![0]!;
const resumen = (id: string, over: Partial<FijadoResumen> = {}): FijadoResumen => ({ id, titulo: `Fijado ${id}`, herramienta: "ventas_por_dia", compartido: false, propio: true, ...over });
const resultado = (id: string, over: Partial<FijadoResultado> = {}): FijadoResultado => ({
  id,
  titulo: `Fijado ${id}`,
  status: "ok",
  text: "ok",
  blocks: [{ ...BLOQUE, title: `Ventas ${id}` }],
  sources: [{ tool: "ventas_por_dia", source: "Pedidos", periodLabel: "esta semana", scopeLabel: "todas tus sucursales" }],
  ...over,
});

function clienteFalso(over: Partial<FijadosCliente> = {}, lista: FijadoResumen[] = [resumen("a"), resumen("b", { compartido: true, propio: false })]) {
  const listar = vi.fn(async () => ({ disponible: true, fijados: lista }));
  const resultadoFn = vi.fn(async (id: string) => resultado(id));
  const quitar = vi.fn(async () => undefined);
  const compartir = vi.fn(async () => undefined);
  const cliente: FijadosCliente = { listar, resultado: resultadoFn, quitar, compartir, ...over };
  return { cliente, listar, resultado: resultadoFn, quitar, compartir };
}

describe("SeccionFijadosCopiloto", () => {
  it("lista los fijados y RE-EJECUTA cada uno: tabla, fuente con periodo y alcance, y marca de compartido", async () => {
    const f = clienteFalso();
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    await microtareas();
    const c = montado.container;
    expect(c.textContent).toContain("Fijados del Copiloto");
    expect(f.resultado).toHaveBeenCalledTimes(2);
    expect(c.textContent).toContain("Ventas a");
    expect(c.textContent).toContain("Pedidos · esta semana · todas tus sucursales");
    expect(c.textContent).toContain("Compartido");
    // Solo el autor ve Quitar/Compartir: el compartido por otro es de solo lectura.
    expect(c.querySelector("[aria-label='Quitar Fijado a del tablero']")).not.toBeNull();
    expect(c.querySelector("[aria-label='Quitar Fijado b del tablero']")).toBeNull();
  });

  it("con `sinCompartir` (tablero personal) no se ofrece Compartir pero Quitar sigue disponible", async () => {
    const f = clienteFalso();
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} sinCompartir />);
    await microtareas();
    await microtareas();
    const c = montado.container;
    expect(c.querySelector("[aria-label='Quitar Fijado a del tablero']")).not.toBeNull();
    expect(c.querySelector("[aria-label^='Compartir']")).toBeNull();
    expect(c.querySelector("[aria-label^='Dejar de compartir']")).toBeNull();
  });

  it("Quitar llama al servidor y retira la tarjeta; si falla avisa y la deja", async () => {
    const f = clienteFalso({ quitar: vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(undefined) });
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    await microtareas();
    const c = montado.container;
    clic(porEtiqueta(c, "Quitar Fijado a del tablero"));
    await microtareas();
    expect(c.querySelector("[role=alert]")?.textContent).toBe("No se pudo quitar; intenta de nuevo.");
    expect(c.querySelectorAll("[data-testid=fijado]").length).toBe(2);
    clic(porEtiqueta(c, "Quitar Fijado a del tablero"));
    await microtareas();
    expect(f.cliente.quitar).toHaveBeenCalledTimes(2);
    expect(c.querySelectorAll("[data-testid=fijado]").length).toBe(1);
  });

  it("Compartir cambia el estado; sin permiso (autor no owner/admin) lo dice y no cambia nada", async () => {
    const compartir = vi.fn().mockRejectedValueOnce(new FijadosErrorCliente("sin_permiso")).mockResolvedValueOnce(undefined);
    const f = clienteFalso({ compartir }, [resumen("a")]);
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    await microtareas();
    const c = montado.container;
    clic(porEtiqueta(c, "Compartir Fijado a"));
    await microtareas();
    expect(c.querySelector("[role=alert]")?.textContent).toContain("Solo el dueño o un administrador");
    expect(c.textContent).not.toContain("Compartido");
    clic(porEtiqueta(c, "Compartir Fijado a"));
    await microtareas();
    expect(compartir).toHaveBeenLastCalledWith("a", true);
    expect(c.textContent).toContain("Compartido");
    expect(c.querySelector("[aria-label='Dejar de compartir Fijado a']")).not.toBeNull();
  });

  it("base sin migrar (disponible:false): lo dice con honestidad, sin lista inventada", async () => {
    const f = clienteFalso({ listar: async () => ({ disponible: false, fijados: [] }) });
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    expect(montado.container.textContent).toContain("Los fijados todavía no están disponibles en tu cuenta.");
    expect(f.resultado).not.toHaveBeenCalled();
  });

  it("un rol sin acceso al Copiloto (403) no ve nada: ni la seccion ni un error", async () => {
    const f = clienteFalso({ listar: async () => { throw new FijadosErrorCliente("sin_acceso"); } });
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    expect(montado.container.textContent).toBe("");
  });

  it("error al listar: estado de error con Reintentar que vuelve a pedir la lista", async () => {
    const listar = vi.fn().mockRejectedValueOnce(new Error("red")).mockResolvedValueOnce({ disponible: true, fijados: [resumen("a")] });
    const f = clienteFalso({ listar });
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    const c = montado.container;
    expect(c.textContent).toContain("No se pudieron cargar tus fijados");
    clic(porTexto(c, "button", /Reintentar/));
    await microtareas();
    await microtareas();
    expect(listar).toHaveBeenCalledTimes(2);
    expect(c.querySelectorAll("[data-testid=fijado]").length).toBe(1);
  });

  it("sin fijados: lo dice y ofrece abrir el Copiloto (solo rutas internas)", async () => {
    const f = clienteFalso({}, []);
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} rutaCopiloto="/hoteles/x/copiloto" />);
    await microtareas();
    const c = montado.container;
    expect(c.textContent).toContain("Aún no fijas nada");
    expect(c.querySelector("a")?.getAttribute("href")).toBe("/hoteles/x/copiloto");
    montado.unmount();
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} rutaCopiloto="https://malo.example" />);
    await microtareas();
    expect(montado.container.querySelector("a")).toBeNull();
  });

  it("un fijado que falla al re-ejecutar muestra su error con Reintentar SOLO para ese; los demas siguen", async () => {
    const resultadoFn = vi.fn(async (id: string) => {
      if (id === "a" && resultadoFn.mock.calls.filter((x) => x[0] === "a").length === 1) throw new Error("boom");
      return resultado(id);
    });
    const f = clienteFalso({ resultado: resultadoFn });
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    await microtareas();
    const c = montado.container;
    expect(c.textContent).toContain("No pude consultar este fijado ahora.");
    expect(c.textContent).toContain("Ventas b");
    clic(porTexto(c, "button", /Reintentar/));
    await microtareas();
    await microtareas();
    expect(c.textContent).toContain("Ventas a");
    expect(resultadoFn.mock.calls.filter((x) => x[0] === "b").length).toBe(1);
  });

  it("re-ejecuta como maximo MAX_FIJADOS_VISIBLES fijados", async () => {
    const muchos = Array.from({ length: MAX_FIJADOS_VISIBLES + 5 }, (_, i) => resumen(`p${i}`));
    const f = clienteFalso({}, muchos);
    montado = montar(<SeccionFijadosCopiloto cliente={f.cliente} />);
    await microtareas();
    await microtareas();
    expect(f.resultado).toHaveBeenCalledTimes(MAX_FIJADOS_VISIBLES);
  });
});
