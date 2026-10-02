// @vitest-environment jsdom
//
// Avisos por status (los 7 de la spec), fuentes con rutas internas, acciones reales de cada respuesta
// (copiar, PDF por URL, fijar, regenerar) y que cada accion desaparece si el transporte no la ofrece.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { textoAviso } from "../src/components/copiloto/CopilotoMensaje";
import { textoParaCopiar } from "../src/components/copiloto/CopilotoAcciones";
import { rutaInternaSegura } from "../src/components/copiloto/formato";
import type { CopilotoRespuesta } from "../src/components/copiloto/tipos";
import {
  clic,
  escribir,
  limpiarDom,
  microtareas,
  montar,
  pendiente,
  porEtiqueta,
  porTexto,
  propsBase,
  RESPUESTA_OK,
  transporteFalso,
  type Montado,
} from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  vi.unstubAllGlobals();
});

async function preguntarCon(respuesta: CopilotoRespuesta, over: Parameters<typeof transporteFalso>[0] = {}, extra = {}) {
  const enviar = vi.fn(async (_p: Parameters<ReturnType<typeof transporteFalso>["t"]["enviar"]>[0]) => respuesta);
  const fake = { ...transporteFalso({ ...over, enviar }), enviar };
  montado = montar(<ChatDatosShell {...propsBase(fake.t, extra)} />);
  escribir(montado.container.querySelector("textarea") as HTMLTextAreaElement, "pregunta");
  clic(porEtiqueta(montado.container, "Enviar"));
  await microtareas();
  return { c: montado.container, ...fake };
}

describe("avisos por status", () => {
  const CASOS: Array<[CopilotoRespuesta, string]> = [
    [{ text: "x", status: "no_data" }, "No hay datos para ese periodo."],
    [{ text: "x", status: "out_of_catalog" }, "Eso todavía no lo puedo consultar. Prueba con:"],
    [{ text: "x", status: "rate_limited", reintentarEnSeg: 12 }, "Muchas preguntas seguidas; espera 12 s."],
    [{ text: "x", status: "rate_limited", limiteDiario: 100 }, "Llegaste a tus 100 preguntas de hoy."],
    [{ text: "x", status: "budget_exceeded" }, "Se alcanzó el tope de IA de tu organización este mes; lo amplía tu administrador."],
    [{ text: "x", status: "apagado" }, "El Copiloto está en pausa por mantenimiento."],
    [{ text: "x", status: "unavailable" }, "No disponible por ahora."],
    [{ text: "x", status: "forbidden" }, "Tu rol no tiene acceso a estas consultas."],
  ];
  for (const [respuesta, texto] of CASOS) {
    it(`${respuesta.status}${respuesta.limiteDiario ? " (tope diario)" : ""}: «${texto}»`, async () => {
      const { c } = await preguntarCon(respuesta);
      expect(c.textContent).toContain(texto);
      // el texto crudo del servidor no se muestra cuando el estado ya tiene un aviso propio
      expect(porTexto(c, "span", texto)).toBeTruthy();
      expect(textoAviso(respuesta)).toBe(texto);
    });
  }

  it("ok y clarify no llevan aviso: se muestra el texto de la respuesta", () => {
    expect(textoAviso({ status: "ok" })).toBeNull();
    expect(textoAviso({ status: "clarify" })).toBeNull();
    expect(textoAviso({ status: undefined })).toBeNull();
  });

  it("out_of_catalog ofrece 3 chips (los del servidor, o las sugerencias de la vertical) que envian la pregunta", async () => {
    const { c, enviar } = await preguntarCon({ text: "x", status: "out_of_catalog", sugerencias: ["a", "b", "c", "d"] });
    const chips = Array.from(c.querySelectorAll("button")).filter((b) => b.className.includes("bg-copiloto/10"));
    expect(chips.map((b) => b.textContent)).toEqual(["a", "b", "c"]);
    clic(chips[1] as HTMLElement);
    await microtareas();
    expect(enviar.mock.calls[1]?.[0].pregunta).toBe("b");
  });

  it("out_of_catalog sin sugerencias del servidor usa las de la vertical", async () => {
    const { c } = await preguntarCon({ text: "x", status: "out_of_catalog" });
    const chips = Array.from(c.querySelectorAll("button")).filter((b) => b.className.includes("bg-copiloto/10"));
    expect(chips.map((b) => b.textContent)).toEqual(["¿Cuánto vendí esta semana?", "¿Cuál es mi ticket medio?"]);
  });

  it("los avisos de error usan role=alert y los informativos no", async () => {
    const e = await preguntarCon({ text: "x", status: "unavailable" });
    expect(e.c.querySelector("p[role=alert]")).not.toBeNull();
    montado?.unmount();
    limpiarDom();
    const n = await preguntarCon({ text: "x", status: "no_data" });
    expect(n.c.querySelector("p[role=alert]")).toBeNull();
  });

  it("un estado con aviso no muestra bloques ni acciones de copiar", async () => {
    const { c } = await preguntarCon({ ...RESPUESTA_OK, status: "no_data" });
    expect(c.textContent).not.toContain("$1,500.50");
    expect(c.querySelector("[aria-label='Copiar respuesta']")).toBeNull();
  });
});

describe("fuentes", () => {
  it("con ruta interna en rutasFuente la fuente es un enlace; sin ella, un chip de texto", async () => {
    const { c } = await preguntarCon(RESPUESTA_OK, {}, { rutasFuente: { ventas_por_dia: "/restaurantes/demo/pedidos" } });
    const enlace = c.querySelector("a[href='/restaurantes/demo/pedidos']") as HTMLAnchorElement;
    expect(enlace.textContent).toContain("Pedidos · Últimos 7 días · Todas tus sucursales");
    expect(enlace.className).toContain("text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground");
    expect(enlace.querySelector("svg")).not.toBeNull();
  });

  it("sin ruta no hay enlace", async () => {
    const { c } = await preguntarCon(RESPUESTA_OK);
    expect(c.querySelector("a[href]")).toBeNull();
    expect(c.textContent).toContain("Fuentes:");
  });

  it("solo se aceptan rutas internas (lista blanca): nada de URLs externas ni protocolos", async () => {
    expect(rutaInternaSegura("/a/b")).toBe("/a/b");
    for (const mala of ["https://x.com", "//x.com", "javascript:alert(1)", "relativa", "/\\x.com", ""]) {
      expect(rutaInternaSegura(mala)).toBeUndefined();
    }
    const { c } = await preguntarCon(RESPUESTA_OK, {}, { rutasFuente: { ventas_por_dia: "javascript:alert(1)" } });
    expect(c.querySelector("a[href]")).toBeNull();
  });
});

describe("acciones de la respuesta", () => {
  it("Copiar deja respuesta, tabla en TSV y fuentes en el portapapeles y avisa 'Copiado'", async () => {
    const escribirPortapapeles = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText: escribirPortapapeles } });
    const { c } = await preguntarCon(RESPUESTA_OK);
    clic(porEtiqueta(c, "Copiar respuesta"));
    await microtareas();
    expect(escribirPortapapeles).toHaveBeenCalledTimes(1);
    const copiado = (escribirPortapapeles.mock.calls[0] as unknown as [string])[0];
    expect(copiado).toContain("Vendiste $2,480.75 MXN.");
    expect(copiado).toContain("Día\tVentas\n2026-09-28\t$1,500.50\n2026-09-29\t$980.25");
    expect(copiado).toContain("Fuentes: Pedidos · Últimos 7 días · Todas tus sucursales");
    expect(c.textContent).toContain("Copiado");
    expect(textoParaCopiar({ id: "x", role: "assistant", text: "solo texto" })).toBe("solo texto");
  });

  it("el PDF es un enlace de descarga a la URL del servidor, solo si hay conversacion guardada y el transporte lo ofrece", async () => {
    const urlPdf = vi.fn((conv: string, seq: number) => `/api/chat/${conv}/mensajes/${seq}/pdf`);
    const fake = transporteFalso({
      urlPdf,
      enviar: vi.fn(async (p) => {
        p.onEvento({ t: "fin", respuesta: RESPUESTA_OK, conversacionId: "conv-9" });
        return RESPUESTA_OK;
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(fake.t)} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    const a = porEtiqueta<HTMLAnchorElement>(c, "Descargar PDF");
    expect(a.getAttribute("href")).toBe("/api/chat/conv-9/mensajes/2/pdf");
    expect(a.hasAttribute("download")).toBe(true);
    expect(urlPdf).toHaveBeenCalledWith("conv-9", 2);
  });

  it("Descargar PDF con descargarPdf: llama al transporte con conversacion y seq, muestra 'Generando PDF…' y vuelve a quedar libre", async () => {
    const espera = pendiente<void>();
    const descargarPdf = vi.fn(() => espera.promesa);
    const fake = transporteFalso({
      descargarPdf,
      enviar: vi.fn(async (p) => {
        p.onEvento({ t: "fin", respuesta: RESPUESTA_OK, conversacionId: "conv-9" });
        return RESPUESTA_OK;
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(fake.t)} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    const boton = porEtiqueta<HTMLButtonElement>(c, "Descargar PDF");
    expect(boton.tagName).toBe("BUTTON");
    clic(boton);
    await microtareas();
    expect(descargarPdf).toHaveBeenCalledWith("conv-9", 2);
    expect(boton.textContent).toContain("Generando PDF");
    expect(boton.disabled).toBe(true);
    espera.resolver();
    await microtareas();
    expect(boton.textContent).toContain("Descargar PDF");
    expect(boton.disabled).toBe(false);
    expect(c.querySelector("[role=alert]")).toBeNull();
  });

  it("si descargarPdf falla muestra el mensaje legible del error; sin conversacion guardada el boton no aparece", async () => {
    const descargarPdf = vi.fn().mockRejectedValue(new Error("Pediste muchos reportes en poco tiempo."));
    const fake = transporteFalso({
      descargarPdf,
      enviar: vi.fn(async (p) => {
        p.onEvento({ t: "fin", respuesta: RESPUESTA_OK, conversacionId: "conv-9" });
        return RESPUESTA_OK;
      }),
    });
    montado = montar(<ChatDatosShell {...propsBase(fake.t)} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    clic(porEtiqueta(c, "Descargar PDF"));
    await microtareas();
    expect(c.querySelector("[role=alert]")?.textContent).toBe("Pediste muchos reportes en poco tiempo.");

    const sinGuardar = transporteFalso({ descargarPdf: vi.fn() });
    montado.unmount();
    montado = montar(<ChatDatosShell {...propsBase(sinGuardar.t)} />);
    escribir(montado.container.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(montado.container, "Enviar"));
    await microtareas();
    expect(montado.container.querySelector("[aria-label='Descargar PDF']")).toBeNull();
  });

  it("sin urlPdf, sin conversacion guardada o sin fijar en el transporte, esas acciones no aparecen", async () => {
    const { c } = await preguntarCon(RESPUESTA_OK);
    expect(c.querySelector("[aria-label='Descargar PDF']")).toBeNull();
    expect(c.querySelector("[aria-label='Fijar en el tablero']")).toBeNull();
    expect(c.querySelector("[aria-label='Copiar respuesta']")).not.toBeNull();
  });

  it("Fijar llama al transporte con conversacion, seq y bloque 0; si falla avisa", async () => {
    const fijar = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("x"));
    const enviar = vi.fn(async (p: { onEvento: (e: never) => void }) => {
      p.onEvento({ t: "fin", respuesta: RESPUESTA_OK, conversacionId: "conv-1" } as never);
      return RESPUESTA_OK;
    });
    const fake = transporteFalso({ fijar, enviar: enviar as never });
    montado = montar(<ChatDatosShell {...propsBase(fake.t)} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    clic(porEtiqueta(c, "Fijar en el tablero"));
    await microtareas();
    expect(fijar).toHaveBeenCalledWith("conv-1", 2, 0);
    expect(c.textContent).toContain("Fijado");
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "q2");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    const botones = c.querySelectorAll("[aria-label='Fijar en el tablero']");
    clic(botones[botones.length - 1] as Element);
    await microtareas();
    expect(c.querySelector("[role=alert]")?.textContent).toBe("No se pudo fijar; intenta de nuevo.");
  });

  it("Regenerar solo esta en la ultima respuesta y vuelve a enviar la misma pregunta reemplazando la respuesta", async () => {
    const { c, enviar } = await preguntarCon(RESPUESTA_OK);
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "segunda");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    expect(c.querySelectorAll("[aria-label='Regenerar respuesta']").length).toBe(1);
    clic(porEtiqueta(c, "Regenerar respuesta"));
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(enviar.mock.calls[2]?.[0].pregunta).toBe("segunda");
    const usuario = Array.from(c.querySelectorAll("div.bg-card.rounded-2xl")).map((d) => d.textContent);
    expect(usuario).toEqual(["pregunta", "segunda"]);
  });
});

describe("indicador de uso", () => {
  it("muestra la etiqueta y el porcentaje que manda el servidor como progressbar accesible", async () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { uso: { pct: 42.4, etiqueta: "Análisis con IA · hoy" } })} />);
    const barra = porEtiqueta(montado.container, "Análisis con IA · hoy");
    expect(barra.getAttribute("role")).toBe("progressbar");
    expect(barra.getAttribute("aria-valuenow")).toBe("42");
    expect(montado.container.textContent).toContain("42%");
  });
});
