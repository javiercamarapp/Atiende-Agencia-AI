// @vitest-environment jsdom
//
// ChatDatosShell con un transporte FALSO: portada y clases literales de atiende-restaurantes, compositor
// (Enter / Shift+Enter, limite, contador), "pensando" con fases por tiempo y pasos de herramienta, detener,
// doble envio, timeout, a11y (role=log, aria-label) y que ningun dato se interpreta como HTML.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { CopilotoErrorTransporte } from "../src/components/copiloto/tipos";
import {
  clic,
  envioColgado,
  escribir,
  limpiarDom,
  microtareas,
  montar,
  porEtiqueta,
  porTexto,
  propsBase,
  RESPUESTA_OK,
  tecla,
  transporteFalso,
  type Montado,
} from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  vi.useRealTimers();
});

function entrada(raiz: ParentNode) {
  return raiz.querySelector("textarea") as HTMLTextAreaElement;
}
async function preguntar(raiz: ParentNode, texto: string) {
  escribir(entrada(raiz), texto);
  clic(porEtiqueta(raiz, "Enviar"));
  await microtareas();
}

describe("portada y clases literales de atiende-restaurantes", () => {
  it("la portada sale de las props, con el wordmark animado y el h1 de AR", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { textos: { ...propsBase(t).textos, contexto: "Sucursal: Centro" } })} />);
    const c = montado.container;
    expect(c.querySelector("h1")?.textContent).toBe("Pregunta a tus datos");
    expect(c.querySelector("h1")?.className).toBe("text-2xl font-semibold text-foreground mb-2");
    expect(c.querySelector("svg.atiende-glifo-animado")).not.toBeNull();
    expect(c.textContent).toContain("Tu operación, con la cifra que ya calculó el sistema.");
    expect(c.textContent).toContain("Sucursal: Centro");
    expect(c.textContent).toContain("No inventa números.");
    // el fondo de pixeles va montado y es decorativo
    expect(c.querySelector("canvas[aria-hidden='true']")).not.toBeNull();
  });

  it("contenedor, compositor, Consulta, enviar y chips con las clases literales de AR", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    expect((c.querySelector("[data-testid=copiloto-shell]") as HTMLElement).className).toBe(
      "copiloto relative min-h-[calc(100dvh-8rem)] overflow-hidden px-4 pt-4",
    );
    expect(c.querySelector("form")?.className).toBe("w-full max-w-xl bg-card border border-border rounded-3xl shadow-sm p-3 shrink-0");
    expect(entrada(c).className).toBe("w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground");
    expect(entrada(c).placeholder).toBe("Pregunta sobre tu operación…");
    const consulta = porTexto(c, "button", "Consulta");
    expect(consulta.className).toContain("rounded-full bg-foreground text-background text-xs font-medium pl-3 pr-3.5 py-1.5");
    expect(porEtiqueta(c, "Enviar").className).toContain("rounded-full shrink-0 w-8 h-8");
    expect(porEtiqueta(c, "Enviar").className).toContain("bg-copiloto");
    const chip = porTexto(c, "button", "¿Cuánto vendí esta semana?");
    expect(chip.className).toBe(
      "text-xs rounded-full px-3 py-1 bg-copiloto/10 text-copiloto border border-copiloto/20 hover:bg-copiloto/20 transition-colors",
    );
    expect(chip.parentElement?.className).toBe("flex flex-wrap gap-1.5 justify-center mt-4 max-w-xl");
    expect(c.querySelector("p.text-xs.text-muted-foreground.text-center.mt-8.max-w-lg")).not.toBeNull();
  });

  it("sin historial en el transporte no se muestra el boton Historial", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    expect(montado.container.querySelector("[aria-label='Historial de chats']")).toBeNull();
  });

  it("con historial, el boton lleva las clases de AR, aria-expanded y aria-controls", () => {
    const { t } = transporteFalso({ listar: async () => [] });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const b = porEtiqueta(montado.container, "Historial de chats");
    expect(b.className).toBe(
      "relative flex items-center gap-1.5 text-xs border border-border rounded-full pl-3 pr-2.5 py-1.5 bg-card text-muted-foreground hover:bg-muted transition-colors",
    );
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBeTruthy();
  });

  it("Consulta con el campo vacio alterna las categorias (3 tarjetas, entrada de 250 ms); elegir una pregunta la envia", async () => {
    const { t, enviar } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    expect(c.textContent).not.toContain("Ventas por día");
    clic(porTexto(c, "button", "Consulta"));
    expect(c.querySelectorAll(".copiloto-categorias-entra .rounded-xl").length).toBe(3);
    const grid = c.querySelector(".copiloto-categorias-entra") as HTMLElement;
    // Cuadricula auto-fit de tarjetas de la misma altura (ver copiloto-categorias-grilla.spec.tsx).
    expect(grid.className).toContain("grid w-full items-stretch sm:auto-rows-fr gap-3 mb-5");
    expect(grid.className).toContain("grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] max-w-5xl");
    expect(porTexto(c, "button", "Consulta").getAttribute("aria-expanded")).toBe("true");
    clic(porTexto(c, "button", "Ticket medio"));
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]?.[0].pregunta).toBe("Ticket medio");
    expect(c.querySelector(".copiloto-categorias-entra .rounded-xl")).toBeNull();
  });
});

describe("compositor", () => {
  it("Enter envia y Shift+Enter no; el envio no manda el id de conversacion la primera vez", async () => {
    const { t, enviar } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "hola");
    const shift = tecla(entrada(c), "Enter", { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    expect(enviar).not.toHaveBeenCalled();
    const enter = tecla(entrada(c), "Enter");
    expect(enter.defaultPrevented).toBe(true);
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]?.[0].pregunta).toBe("hola");
    expect(enviar.mock.calls[0]?.[0].conversacionId).toBeUndefined();
    expect(entrada(c).value).toBe("");
  });

  it("no envia un campo vacio y el boton Enviar queda deshabilitado", () => {
    const { t, enviar } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    expect((porEtiqueta(c, "Enviar") as HTMLButtonElement).disabled).toBe(true);
    escribir(entrada(c), "   ");
    tecla(entrada(c), "Enter");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("limita a maxCaracteres y muestra el contador desde el 80 %", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { maxCaracteres: 10 })} />);
    const c = montado.container;
    expect(entrada(c).maxLength).toBe(10);
    expect(c.textContent).not.toContain("/10");
    escribir(entrada(c), "12345678");
    expect(c.textContent).toContain("8/10");
  });

  it("el textarea y todos los controles tienen nombre accesible", () => {
    const { t } = transporteFalso({ listar: async () => [] });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    const id = entrada(c).id;
    expect(c.querySelector(`label[for="${id}"]`)?.textContent).toBe("Tu pregunta");
    for (const b of Array.from(c.querySelectorAll("button"))) {
      const nombre = b.getAttribute("aria-label") ?? b.textContent?.trim();
      expect(nombre, b.outerHTML).toBeTruthy();
    }
  });
});

describe("hilo, burbujas y accesibilidad", () => {
  it("el hilo es role=log con aria-live=polite y aria-label; la burbuja y la respuesta usan las clases de AR", async () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    await preguntar(c, "¿Cuánto vendí?");
    const log = c.querySelector("[role=log]") as HTMLElement;
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-label")).toBe("Conversación con el Copiloto");
    expect(log.className).toBe("w-full max-w-2xl space-y-5 mb-6");
    const burbuja = log.querySelector("div.bg-card.rounded-2xl") as HTMLElement;
    expect(burbuja.textContent).toBe("¿Cuánto vendí?");
    expect(burbuja.className).toBe("max-w-[80%] bg-card border border-border rounded-2xl px-4 py-2 text-sm text-foreground shadow-sm whitespace-pre-wrap break-words");
    const respuesta = Array.from(log.querySelectorAll("p")).find((p) => p.textContent?.includes("Vendiste")) as HTMLElement;
    expect(respuesta.className).toBe("text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words");
    // la portada desaparece con la conversacion y los mensajes entran con la animacion de 250 ms
    expect(c.querySelector("h1")).toBeNull();
    expect(log.querySelector(".copiloto-categorias-entra")).not.toBeNull();
  });

  it("las cifras salen de los bloques del servidor con formato MXN y la fuente cita periodo y alcance", async () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    await preguntar(c, "ventas");
    expect(c.textContent).toContain("$1,500.50");
    expect(c.textContent).toContain("$980.25");
    expect(c.textContent).toContain("Pedidos · Últimos 7 días · Todas tus sucursales");
    const lista = c.querySelector("ul[aria-label='Ventas por día']") as HTMLElement;
    expect(lista.className).toBe("space-y-2 text-sm");
    expect(lista.querySelector("li")?.className).toBe("flex justify-between border-b border-dashed border-border last:border-0 pb-2");
  });

  it("un bloque con mas de dos columnas es una tabla accesible y recorta a 10 filas", async () => {
    const filas = Array.from({ length: 12 }, (_, i) => ({ d: `día ${i + 1}`, v: i, p: i }));
    const { t } = transporteFalso({
      enviar: async () => ({
        text: "Listo",
        status: "ok",
        blocks: [
          {
            tool: "x",
            title: "Detalle",
            columns: [
              { key: "d", label: "Día", kind: "text" },
              { key: "v", label: "Ventas", kind: "integer" },
              { key: "p", label: "Pedidos", kind: "integer" },
            ],
            rows: filas,
            truncated: true,
          },
        ],
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    await preguntar(c, "detalle");
    expect(c.querySelectorAll("table[aria-label='Detalle'] tbody tr").length).toBe(10);
    expect(c.querySelectorAll("th[scope=col]").length).toBe(3);
    expect(c.textContent).toContain("Se muestran las primeras 10 filas; hay más en el sistema.");
  });

  it("el texto del servidor no se interpreta como HTML", async () => {
    const malo = '<img src=x onerror="window.__xss=1"><b>negrita</b>';
    const { t } = transporteFalso({ enviar: async () => ({ text: malo, status: "ok" }) });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await preguntar(montado.container, malo);
    expect(montado.container.querySelector("img")).toBeNull();
    expect(montado.container.querySelector("b")).toBeNull();
    expect(montado.container.textContent).toContain("<b>negrita</b>");
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("al responder, la siguiente pregunta manda el conversacionId que dio el servidor", async () => {
    const cambia = vi.fn();
    const { t } = transporteFalso({
      enviar: vi.fn(async (p) => {
        p.onEvento({ t: "fin", respuesta: RESPUESTA_OK, conversacionId: "conv-1" });
        return RESPUESTA_OK;
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(t, { onConversacionCambia: cambia })} />);
    const c = montado.container;
    await preguntar(c, "uno");
    expect(cambia).toHaveBeenCalledWith("conv-1");
    await preguntar(c, "dos");
    const llamadas = vi.mocked(t.enviar).mock.calls;
    expect(llamadas[1]?.[0].conversacionId).toBe("conv-1");
  });
});

describe("pensando: fases por tiempo, pasos y detener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("muestra la fase de 0/3/9/17/30 s con el logo que respira y las lineas que corren", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "ventas");
    clic(porEtiqueta(c, "Enviar"));
    const fase = () => c.querySelector("[data-testid=copiloto-fase]")?.textContent;
    const adelantar = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    expect(fase()).toBe("Leyendo tus pedidos…");
    const pensando = c.querySelector("[data-testid=copiloto-pensando]") as HTMLElement;
    expect(pensando.className).toBe("flex items-start gap-2 text-sm text-muted-foreground");
    expect(pensando.getAttribute("role")).toBe("status");
    expect(pensando.querySelector("svg.atiende-respira.atiende-glifo-animado")).not.toBeNull();
    await adelantar(2800);
    expect(fase()).toBe("Leyendo tus pedidos…");
    await adelantar(700); // 3.5 s
    expect(fase()).toBe("Calculando cifras…");
    await adelantar(5600); // 9.1 s
    expect(fase()).toBe("Cruzando cifras…");
    await adelantar(8400); // 17.5 s
    expect(fase()).toBe("Preparando la respuesta…");
    await adelantar(13300); // 30.8 s
    expect(fase()).toBe("Esto está tardando más de lo normal…");
    clic(porEtiqueta(c, "Detener"));
    await adelantar(0);
  });

  it("los pasos de herramienta aparecen en curso (punto) y terminan con palomita; sin etiqueta usa el nombre tecnico", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "ventas");
    clic(porEtiqueta(c, "Enviar"));
    act(() => envio.emitir({ t: "paso", fase: "inicio", herramienta: "ventas_por_dia" }));
    let li = c.querySelector("[data-testid=copiloto-pensando] li") as HTMLElement;
    expect(li.textContent).toBe("Leyendo ventas por día…");
    expect(li.className).toBe("text-pill text-foreground flex items-center gap-1.5");
    expect(li.querySelector(".ds-skeleton.rounded-full")).not.toBeNull();
    act(() => envio.emitir({ t: "paso", fase: "fin", herramienta: "ventas_por_dia" }));
    li = c.querySelector("[data-testid=copiloto-pensando] li") as HTMLElement;
    expect(li.className).toBe("text-pill text-faint flex items-center gap-1.5");
    expect(li.textContent).toBe("Leyendo ventas por día");
    expect(li.querySelector("svg")).not.toBeNull();
    act(() => envio.emitir({ t: "paso", fase: "inicio", herramienta: "herramienta_sin_etiqueta" }));
    expect(c.textContent).toContain("herramienta_sin_etiqueta…");
    clic(porEtiqueta(c, "Detener"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("Detener aborta el turno, deja 'Cancelado.' en text-faint y devuelve el boton Enviar", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "ventas");
    clic(porEtiqueta(c, "Enviar"));
    const detener = porEtiqueta(c, "Detener");
    expect(detener.querySelector("svg.fill-current")).not.toBeNull();
    clic(detener);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(envio.senal()?.aborted).toBe(true);
    expect(c.querySelector("[data-testid=copiloto-pensando]")).toBeNull();
    const cancelado = porTexto(c, "p", "Cancelado.");
    expect(cancelado.className).toContain("text-faint");
    expect(c.querySelector("[aria-label='Enviar']")).not.toBeNull();
    // un turno cancelado no ofrece acciones de respuesta
    expect(c.querySelector("[aria-label='Copiar respuesta']")).toBeNull();
  });

  it("el doble envio mientras hay un turno en curso no llama dos veces al transporte", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "uno");
    clic(porEtiqueta(c, "Enviar"));
    escribir(entrada(c), "dos");
    tecla(entrada(c), "Enter");
    expect(envio.enviar).toHaveBeenCalledTimes(1);
    clic(porEtiqueta(c, "Detener"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("a los 75 s el cliente aborta y avisa 'No disponible por ahora.'", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    escribir(entrada(c), "ventas");
    clic(porEtiqueta(c, "Enviar"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(envio.senal()?.aborted).toBe(true);
    expect(c.textContent).toContain("No disponible por ahora.");
    expect(c.querySelector("[data-testid=copiloto-pensando]")).toBeNull();
  });

  it("al desmontar con un turno en curso se aborta la peticion", async () => {
    const envio = envioColgado();
    const { t } = transporteFalso({ enviar: envio.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    escribir(entrada(montado.container), "ventas");
    clic(porEtiqueta(montado.container, "Enviar"));
    montado.unmount();
    montado = undefined;
    expect(envio.senal()?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});

describe("errores del transporte", () => {
  it("un error con status del transporte se muestra con su aviso", async () => {
    const { t } = transporteFalso({
      enviar: async () => {
        throw new CopilotoErrorTransporte("forbidden");
      },
    });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await preguntar(montado.container, "ventas");
    expect(montado.container.textContent).toContain("Tu rol no tiene acceso a estas consultas.");
  });

  it("un fallo cualquiera cae a 'No disponible por ahora.' y permite reintentar", async () => {
    const envio = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(RESPUESTA_OK);
    const { t } = transporteFalso({ enviar: envio });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const c = montado.container;
    await preguntar(c, "ventas");
    expect(c.textContent).toContain("No disponible por ahora.");
    clic(porTexto(c, "button", "Reintentar"));
    await microtareas();
    expect(envio).toHaveBeenCalledTimes(2);
    expect(envio.mock.calls[1]?.[0].pregunta).toBe("ventas");
    expect(c.textContent).toContain("Vendiste $2,480.75 MXN.");
    expect(c.textContent).not.toContain("No disponible por ahora.");
  });
});
