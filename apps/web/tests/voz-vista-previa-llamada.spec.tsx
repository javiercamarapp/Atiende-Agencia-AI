// @vitest-environment jsdom
//
// VistaPreviaLlamada: layout desacoplado del proveedor. Se prueba contra un
// controlador falso (contrato neutro VoiceSessionController).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTADO_SESION_INICIAL, VistaPreviaLlamada } from "@atiende/ui";
import type { VoiceSessionController, VoiceSessionState } from "@atiende/ui";
import { click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); // jsdom no implementa canvas; CampoPixeles ya tolera ctx nulo
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

function controlador(estado: Partial<VoiceSessionState> = {}, silenciado = false) {
  const c = {
    estado: { ...ESTADO_SESION_INICIAL, ...estado },
    silenciado,
    iniciar: vi.fn(async () => undefined),
    terminar: vi.fn(async () => undefined),
    silenciar: vi.fn(),
  } satisfies VoiceSessionController;
  return c;
}

function pintar(c: VoiceSessionController, extra: Record<string, unknown> = {}) {
  const onCerrar = vi.fn();
  rendered = renderComponent(<VistaPreviaLlamada controller={c} nombreAgente="Agente Los Taquitos" nombreSucursal="Sucursal Centro" onCerrar={onCerrar} {...extra} />);
  return { onCerrar };
}

const q = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(texto) || b.getAttribute("aria-label")?.includes(texto));

describe("<VistaPreviaLlamada />", () => {
  it("en reposo muestra el estado vacío, el chip 'Vista previa' y arranca la llamada con el botón", () => {
    const c = controlador();
    const { onCerrar } = pintar(c);
    const t = rendered!.container.textContent!;
    expect(t).toContain("Agente Los Taquitos");
    expect(t).toContain("Sucursal Centro");
    expect(t).toContain("Aún no hay una llamada activa");
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')?.textContent).toBe("Vista previa");
    click(q("Iniciar llamada de prueba")!);
    expect(c.iniciar).toHaveBeenCalledTimes(1);
    click(q("Atrás")!);
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it("tocar el orbe también inicia la llamada", () => {
    const c = controlador();
    pintar(c);
    click(rendered!.container.querySelector('button[title="Iniciar llamada"]')!);
    expect(c.iniciar).toHaveBeenCalledTimes(1);
  });

  it("conectando deshabilita el botón y no reintenta", () => {
    const c = controlador({ modo: "conectando" });
    pintar(c);
    const boton = q("Conectando…") as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    click(boton);
    expect(c.iniciar).not.toHaveBeenCalled();
    expect(c.terminar).not.toHaveBeenCalled();
  });

  it("con la llamada activa el chip refleja el modo, el orbe lo recibe y el botón termina la llamada", () => {
    for (const [modo, chip] of [
      ["escuchando", "● Escuchando"],
      ["pensando", "● Pensando"],
      ["hablando", "● Hablando"],
    ] as const) {
      const c = controlador({ modo });
      pintar(c);
      expect(rendered!.container.querySelector('[data-testid="chip-estado"]')?.textContent).toBe(chip);
      expect(rendered!.container.querySelector(".voz-orbe")?.getAttribute("data-modo")).toBe(modo);
      click(q("Terminar llamada")!);
      expect(c.terminar).toHaveBeenCalledTimes(1);
      rendered!.unmount();
      rendered = undefined;
    }
  });

  it("el botón de silenciar solo aparece con la llamada activa y alterna el estado", () => {
    const inactiva = controlador();
    pintar(inactiva);
    expect(q("Silenciar micrófono")).toBeUndefined();
    rendered!.unmount();

    const c = controlador({ modo: "escuchando" });
    pintar(c);
    click(q("Silenciar micrófono")!);
    expect(c.silenciar).toHaveBeenCalledWith(true);
    rendered!.unmount();

    const muted = controlador({ modo: "escuchando" }, true);
    pintar(muted);
    click(q("Activar micrófono")!);
    expect(muted.silenciar).toHaveBeenCalledWith(false);
  });

  it("muestra la transcripción recibida", () => {
    const c = controlador({ modo: "escuchando", transcripcion: [{ id: "1", rol: "usuario", texto: "Hola, una orden de tacos", parcial: false, ts: 0 }] });
    pintar(c);
    expect(rendered!.container.textContent).toContain("Hola, una orden de tacos");
    expect(rendered!.container.textContent).not.toContain("Aún no hay una llamada activa");
  });

  it("en error muestra el mensaje, el aviso de reintento si es recuperable y deja reintentar", () => {
    const c = controlador({ modo: "error", error: { codigo: "mic", mensaje: "No se pudo acceder al micrófono.", recuperable: true } });
    pintar(c);
    const alerta = rendered!.container.querySelector('[role="alert"]')!;
    expect(alerta.textContent).toContain("No se pudo acceder al micrófono.");
    expect(alerta.textContent).toContain("Puedes volver a intentarlo.");
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')?.textContent).toBe("Error");
    click(q("Reintentar llamada")!);
    expect(c.iniciar).toHaveBeenCalledTimes(1);
  });

  it("un error no recuperable no promete reintento", () => {
    const c = controlador({ modo: "error", error: { codigo: "config", mensaje: "El agente no está configurado.", recuperable: false } });
    pintar(c);
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).not.toContain("Puedes volver a intentarlo.");
  });

  it("si el servicio no está disponible muestra el motivo y no deja iniciar", () => {
    const c = controlador();
    pintar(c, { motivoNoDisponible: "La voz en vivo todavía no está disponible." });
    expect(rendered!.container.querySelector('[role="status"]')?.textContent).toContain("todavía no está disponible");
    const boton = q("Iniciar llamada de prueba") as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    click(boton);
    expect(c.iniciar).not.toHaveBeenCalled();
  });

  it("etiquetasChip reemplaza solo el texto del chip por modo (el modo real queda en data-modo) y videoSiempre mantiene el video del orbe en la llamada", () => {
    const etiquetasChip = { escuchando: "● Llamada en curso" } as const;
    pintar(controlador({ modo: "escuchando" }), { etiquetasChip, videoSrc: "/media/orbe.mp4", videoSiempre: true });
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')?.textContent).toBe("● Llamada en curso");
    expect(rendered!.container.querySelector('[role="dialog"]')?.getAttribute("data-modo")).toBe("escuchando");
    expect(rendered!.container.querySelector(".voz-orbe")?.getAttribute("data-video")).toBe("visible");
    rendered!.unmount();
    pintar(controlador({ modo: "hablando" }), { etiquetasChip });
    expect(rendered!.container.querySelector('[data-testid="chip-estado"]')?.textContent).toBe("● Hablando");
    expect(rendered!.container.querySelector(".voz-orbe")?.getAttribute("data-video")).toBe("oculto");
  });

  it("en móvil (matchMedia < 768 px) se monta por portal en <body> como pantalla fija completa y reacciona al cambio de tamaño", () => {
    let escritorio = false;
    const oyentes = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return escritorio;
      },
      addEventListener: (_: string, f: () => void) => oyentes.add(f),
      removeEventListener: (_: string, f: () => void) => oyentes.delete(f),
    }));
    const marco = document.createElement("div");
    document.body.appendChild(marco);
    pintar(controlador(), { portalEn: marco });
    const dialogo = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialogo().parentElement).toBe(document.body);
    expect(dialogo().className).toContain("fixed inset-0 z-50");
    act(() => {
      escritorio = true;
      oyentes.forEach((f) => f());
    });
    expect(dialogo().parentElement).toBe(marco);
    expect(dialogo().className).toContain("absolute inset-0 z-30");
    rendered!.unmount();
    rendered = undefined;
    marco.remove();
    vi.unstubAllGlobals();
  });

  it("etiqueta visible de simulación cuando se le pasa", () => {
    pintar(controlador(), { etiquetaSimulacion: "Simulación" });
    expect(rendered!.container.textContent).toContain("Simulación");
  });
});

describe("<VistaPreviaLlamada /> como dialogo (QA-restaurantes-R1-botones-09)", () => {
  it("es un dialogo modal con nombre, el foco entra al panel al abrirse y Escape la cierra", () => {
    const c = controlador();
    const { onCerrar } = pintar(c);
    const dialogo = rendered!.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialogo.getAttribute("aria-modal")).toBe("true");
    expect(dialogo.getAttribute("aria-label")).toContain("Agente Los Taquitos");
    expect(document.activeElement).toBe(dialogo);
    keydown(document.body, "Escape");
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it("Tab no sale del panel (da la vuelta del ultimo al primero y con Shift del primero al ultimo)", () => {
    pintar(controlador());
    const dialogo = rendered!.container.querySelector<HTMLElement>('[role="dialog"]')!;
    const items = Array.from(dialogo.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const primero = items[0]!;
    const ultimo = items[items.length - 1]!;
    ultimo.focus();
    act(() => {
      ultimo.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(primero);
    act(() => {
      primero.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(ultimo);
  });

  it("al cerrarse devuelve el foco al control que la abrio", () => {
    const abre = document.createElement("button");
    document.body.appendChild(abre);
    abre.focus();
    pintar(controlador());
    expect(document.activeElement).not.toBe(abre);
    rendered!.unmount();
    rendered = undefined;
    expect(document.activeElement).toBe(abre);
    abre.remove();
  });
});
