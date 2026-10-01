// @vitest-environment jsdom
//
// Panel de historial del Copiloto con transporte falso: entrada de 480 ms, Esc, foco atrapado y devuelto,
// geometria de AR y movil fixed inset-0, grupos por fecha en la zona de la organizacion, buscar, renombrar,
// borrar con confirmacion, estados cargando/error/tope/vacio, abrir una conversacion y movimiento reducido.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { agruparConversaciones, grupoDeConversacion } from "../src/components/copiloto/formato";
import type { ConversacionResumen } from "../src/components/copiloto/tipos";
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
  vi.unstubAllGlobals();
});

const AHORA = new Date("2026-10-01T18:00:00Z"); // 12:00 en Ciudad de Mexico
const ZONA = "America/Mexico_City";

const CONVS: ConversacionResumen[] = [
  { id: "c1", titulo: "Ventas de hoy", actualizadaEn: "2026-10-01T16:00:00Z" },
  { id: "c2", titulo: "Ticket de ayer", actualizadaEn: "2026-09-30T20:00:00Z" },
  { id: "c3", titulo: "Semana pasada", actualizadaEn: "2026-09-26T20:00:00Z" },
  { id: "c4", titulo: "Un mes atrás", actualizadaEn: "2026-08-01T20:00:00Z" },
  { id: "c5", titulo: "Importante", actualizadaEn: "2026-08-02T20:00:00Z", fijada: true },
];

function props(over: Parameters<typeof transporteFalso>[0] = {}) {
  const fake = transporteFalso({ listar: vi.fn(async () => CONVS), ...over });
  return { ...fake, props: propsBase(fake.t, { zonaHoraria: ZONA, ahora: () => AHORA }) };
}
const botonHistorial = (c: ParentNode) => c.querySelector("button[aria-controls]") as HTMLButtonElement;
const panel = (c: ParentNode) => c.querySelector("[role=dialog][aria-label='Historial de chats']") as HTMLElement | null;

async function abrir(c: ParentNode) {
  clic(botonHistorial(c));
  await microtareas();
}

describe("agrupacion por fecha en la zona de la organizacion", () => {
  it("un instante cerca de la medianoche cae en el dia de la zona, no en el UTC", () => {
    // 02:00Z del 2-oct es el 1-oct 20:00 en Ciudad de Mexico: sigue siendo "hoy" para quien consulta el 1-oct a las 12:00.
    const c: ConversacionResumen = { id: "x", titulo: "t", actualizadaEn: "2026-10-02T02:00:00Z" };
    expect(grupoDeConversacion(c, AHORA, ZONA)).toBe("hoy");
    // En UTC ese mismo instante ya es el dia siguiente al de "ahora".
    expect(grupoDeConversacion({ ...c, actualizadaEn: "2026-09-30T23:30:00Z" }, AHORA, ZONA)).toBe("ayer");
    expect(grupoDeConversacion({ ...c, actualizadaEn: "2026-10-01T05:30:00Z" }, AHORA, ZONA)).toBe("ayer"); // 23:30 del 30-sep local
  });
  it("fijadas primero, luego hoy, ayer, ultimos 7 dias y anteriores; omite grupos vacios", () => {
    const g = agruparConversaciones(CONVS, AHORA, ZONA);
    expect(g.map((x) => x.grupo)).toEqual(["fijadas", "hoy", "ayer", "semana", "anteriores"]);
    expect(agruparConversaciones([CONVS[0] as ConversacionResumen], AHORA, ZONA).map((x) => x.grupo)).toEqual(["hoy"]);
    expect(grupoDeConversacion({ id: "z", titulo: "t", actualizadaEn: "no-es-fecha" }, AHORA, ZONA)).toBe("anteriores");
  });
});

describe("apertura, cierre, foco y animacion", () => {
  it("abre con la geometria de AR, la entrada de 480 ms y el foco en Nuevo chat", async () => {
    const { props: p } = props();
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    expect(panel(c)).toBeNull();
    await abrir(c);
    const el = panel(c) as HTMLElement;
    expect(el.className).toContain("copiloto-panel-entra");
    expect(el.className).toContain("absolute right-3 inset-y-3 z-20 w-72 max-w-[85vw] bg-card border border-border rounded-2xl shadow-xl flex flex-col overflow-hidden");
    expect(el.className).toContain("max-lg:fixed max-lg:inset-0 max-lg:w-full max-lg:max-w-none max-lg:rounded-none max-lg:z-40");
    expect(el.id).toBe(botonHistorial(c).getAttribute("aria-controls"));
    expect(botonHistorial(c).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(porEtiqueta(el, "Nuevo chat"));
    // la entrada es de 480 ms con la curva de Likida y cae en la regla global de movimiento reducido
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");
    expect(css).toMatch(/\.copiloto-panel-entra\s*\{\s*animation:\s*copiloto-panel-entra 480ms var\(--ease-out\) both;/);
    expect(css).toMatch(/\.copiloto-categorias-entra\s*\{\s*animation:\s*copiloto-categorias-entra 250ms ease-out both;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.copiloto-panel-entra,\s*\.copiloto-panel-sale,\s*\.copiloto-categorias-entra \{ animation: none; \}/);
    expect(css).toMatch(/\.copiloto\s*\{\s*--copiloto-acento: 224 76% 48%;/);
    expect(css).toMatch(/\.dark \.copiloto\s*\{\s*--copiloto-acento: 213 82% 62%;/);
  });

  it("Esc cierra tras la salida de 480 ms y devuelve el foco al boton Historial", async () => {
    vi.useFakeTimers();
    const { props: p } = props();
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    tecla(porEtiqueta(c, "Buscar chats"), "Escape");
    expect(panel(c)?.className).toContain("copiloto-panel-sale");
    expect(document.activeElement).toBe(botonHistorial(c));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(480);
    });
    expect(panel(c)).toBeNull();
    expect(botonHistorial(c).getAttribute("aria-expanded")).toBe("false");
  });

  it("con movimiento reducido el panel se cierra al instante", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const { props: p } = props();
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    clic(porEtiqueta(c, "Cerrar historial"));
    expect(panel(c)).toBeNull();
  });

  it("el foco queda atrapado: Tab desde el ultimo control vuelve al primero y Shift+Tab al reves", async () => {
    const { props: p } = props();
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    const el = panel(c) as HTMLElement;
    const foco = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled]), input, [href]"));
    const primero = foco[0] as HTMLElement;
    const ultimo = foco[foco.length - 1] as HTMLElement;
    ultimo.focus();
    expect(tecla(ultimo, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(primero);
    expect(tecla(primero, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ultimo);
  });

  it("todos los controles del panel tienen nombre accesible", async () => {
    const { props: p } = props();
    montado = montar(<ChatDatosShell {...p} />);
    await abrir(montado.container);
    for (const b of Array.from((panel(montado.container) as HTMLElement).querySelectorAll("button, input"))) {
      const nombre = b.getAttribute("aria-label") ?? b.textContent?.trim();
      expect(nombre, b.outerHTML).toBeTruthy();
    }
  });
});

describe("contenido del historial", () => {
  it("lista por grupos con las etiquetas de AR, marca la conversacion activa y muestra el contador", async () => {
    const { props: p } = props({ abrir: async (id) => ({ id, titulo: "x", mensajes: [{ id: "m", role: "user", text: "hola" }] }) });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    const el = panel(c) as HTMLElement;
    const titulos = Array.from(el.querySelectorAll("h2")).map((h) => h.textContent);
    expect(titulos).toEqual(["Fijadas", "Hoy", "Ayer", "Últimos 7 días", "Anteriores"]);
    expect((el.querySelector("h2") as HTMLElement).className).toContain("font-mono text-2xs uppercase tracking-[0.08em]");
    expect(botonHistorial(c).textContent).toContain("5");
    clic(porTexto(el, "button", "Ventas de hoy"));
    await microtareas();
    await abrir(c);
    const activo = porTexto(panel(c) as HTMLElement, "button", "Ventas de hoy");
    expect(activo.getAttribute("aria-current")).toBe("true");
    expect(activo.className).toContain("bg-muted font-medium");
  });

  it("estado de carga con skeletons y, si falla, el aviso de Likida con reintento que vuelve a pedir la lista", async () => {
    const listar = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(CONVS);
    const { props: p } = props({ listar });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    clic(botonHistorial(c));
    expect(panel(c)?.querySelectorAll(".ds-skeleton").length).toBe(3);
    await microtareas();
    expect(panel(c)?.textContent).toContain("No se pudo leer el historial ahora mismo — tus conversaciones siguen guardadas; reintenta en un momento.");
    clic(porTexto(panel(c) as HTMLElement, "button", "Reintentar"));
    await microtareas();
    expect(listar).toHaveBeenCalledTimes(2);
    expect(panel(c)?.textContent).toContain("Ventas de hoy");
  });

  it("vacio y sin resultados", async () => {
    const { props: p } = props({ listar: async () => [CONVS[0] as ConversacionResumen] });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    escribir(porEtiqueta(c, "Buscar chats"), "zzz");
    expect(panel(c)?.textContent).toContain("Sin resultados.");
    escribir(porEtiqueta(c, "Buscar chats"), "VENTAS");
    expect(panel(c)?.textContent).toContain("Ventas de hoy");
    expect(panel(c)?.textContent).not.toContain("Sin resultados.");
  });

  it("sin conversaciones dice 'Sin chats recientes.'", async () => {
    const { props: p } = props({ listar: async () => [] });
    montado = montar(<ChatDatosShell {...p} />);
    await abrir(montado.container);
    expect(panel(montado.container)?.textContent).toContain("Sin chats recientes.");
  });

  it("con 100 conversaciones avisa el tope y el boton muestra 100+", async () => {
    const cien = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, titulo: `Chat ${i}`, actualizadaEn: "2026-10-01T16:00:00Z" }));
    const { props: p } = props({ listar: async () => cien });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    expect(panel(c)?.textContent).toContain("Las 100 más recientes — las anteriores siguen guardadas.");
    expect(botonHistorial(c).textContent).toContain("100+");
  });
});

describe("acciones sobre el historial", () => {
  it("Nuevo chat limpia el hilo, cierra el panel y avisa que no hay conversacion", async () => {
    const cambia = vi.fn();
    const { t } = transporteFalso({ listar: async () => CONVS });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA, onConversacionCambia: cambia })} />);
    const c = montado.container;
    escribir(c.querySelector("textarea") as HTMLTextAreaElement, "ventas");
    clic(porEtiqueta(c, "Enviar"));
    await microtareas();
    expect(c.querySelector("[role=log]")).not.toBeNull();
    await abrir(c);
    clic(porEtiqueta(c, "Nuevo chat"));
    await microtareas();
    expect(c.querySelector("[role=log]")).toBeNull();
    expect(c.querySelector("h1")).not.toBeNull();
    expect(cambia).toHaveBeenLastCalledWith(undefined);
  });

  it("abrir una conversacion carga sus mensajes desde el transporte y avisa su id; un fallo muestra el aviso", async () => {
    const cambia = vi.fn();
    const abrirFn = vi
      .fn()
      .mockResolvedValueOnce({
        id: "c2",
        titulo: "Ticket de ayer",
        mensajes: [
          { id: "m1", role: "user", text: "¿ticket?" },
          { id: "m2", role: "assistant", text: "Tu ticket medio es $200.", status: "ok", seq: 2 },
        ],
      })
      .mockRejectedValueOnce(new Error("x"));
    const { t } = transporteFalso({ listar: async () => CONVS, abrir: abrirFn });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA, onConversacionCambia: cambia })} />);
    const c = montado.container;
    await abrir(c);
    clic(porTexto(panel(c) as HTMLElement, "button", "Ticket de ayer"));
    await microtareas();
    expect(c.textContent).toContain("Tu ticket medio es $200.");
    expect(cambia).toHaveBeenCalledWith("c2");
    await abrir(c);
    clic(porTexto(panel(c) as HTMLElement, "button", "Ventas de hoy"));
    await microtareas();
    expect(c.textContent).toContain("No se pudo abrir esa conversación");
  });

  it("conversacionInicial (?c=<id>) abre esa conversacion al montar", async () => {
    const abrirFn = vi.fn(async (id: string) => ({ id, titulo: "t", mensajes: [{ id: "m1", role: "user" as const, text: "pregunta guardada" }] }));
    const { t } = transporteFalso({ abrir: abrirFn });
    montado = montar(<ChatDatosShell {...propsBase(t, { conversacionInicial: "abc" })} />);
    await microtareas();
    expect(abrirFn).toHaveBeenCalledWith("abc", expect.any(AbortSignal));
    expect(montado.container.textContent).toContain("pregunta guardada");
  });

  it("una apertura vieja no pisa a una mas reciente", async () => {
    const lenta = pendiente<{ id: string; titulo: string; mensajes: [{ id: string; role: "user"; text: string }] }>();
    const abrirFn = vi
      .fn()
      .mockReturnValueOnce(lenta.promesa)
      .mockResolvedValueOnce({ id: "c2", titulo: "t", mensajes: [{ id: "m", role: "user", text: "la segunda" }] });
    const { t } = transporteFalso({ listar: async () => CONVS, abrir: abrirFn });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA })} />);
    const c = montado.container;
    await abrir(c);
    clic(porTexto(panel(c) as HTMLElement, "button", "Ventas de hoy"));
    await abrir(c);
    clic(porTexto(panel(c) as HTMLElement, "button", "Ticket de ayer"));
    await microtareas();
    lenta.resolver({ id: "c1", titulo: "t", mensajes: [{ id: "m", role: "user", text: "la primera" }] });
    await microtareas();
    expect(c.textContent).toContain("la segunda");
    expect(c.textContent).not.toContain("la primera");
  });

  it("renombrar: lapiz, Enter guarda en el transporte y actualiza el titulo; Esc cancela", async () => {
    const renombrar = vi.fn(async () => {});
    const { props: p } = props({ renombrar });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    clic(porEtiqueta(c, "Renombrar Ventas de hoy"));
    let campo = porEtiqueta<HTMLInputElement>(c, "Nuevo nombre del chat");
    expect(campo.value).toBe("Ventas de hoy");
    escribir(campo, "Ventas octubre");
    tecla(campo, "Enter");
    await microtareas();
    expect(renombrar).toHaveBeenCalledWith("c1", "Ventas octubre");
    expect(panel(c)?.textContent).toContain("Ventas octubre");
    clic(porEtiqueta(c, "Renombrar Ventas octubre"));
    campo = porEtiqueta<HTMLInputElement>(c, "Nuevo nombre del chat");
    escribir(campo, "otro");
    tecla(campo, "Escape");
    await microtareas();
    expect(renombrar).toHaveBeenCalledTimes(1);
    expect(panel(c)).not.toBeNull(); // Esc cancela el renombre, no cierra el panel
    expect(panel(c)?.textContent).toContain("Ventas octubre");
  });

  it("si renombrar falla, avisa y conserva el titulo", async () => {
    const { props: p } = props({ renombrar: async () => Promise.reject(new Error("x")) });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    clic(porEtiqueta(c, "Renombrar Ventas de hoy"));
    const campo = porEtiqueta<HTMLInputElement>(c, "Nuevo nombre del chat");
    escribir(campo, "Nuevo");
    tecla(campo, "Enter");
    await microtareas();
    expect(panel(c)?.textContent).toContain("No se pudo renombrar el chat");
    expect(panel(c)?.textContent).toContain("Ventas de hoy");
  });

  it("borrar pide confirmacion ('Se borra para siempre. Las cifras no cambian.'); cancelar no borra y confirmar si", async () => {
    const borrar = vi.fn(async () => {});
    const { props: p } = props({ borrar });
    montado = montar(<ChatDatosShell {...p} />);
    const c = montado.container;
    await abrir(c);
    clic(porEtiqueta(c, "Borrar Ventas de hoy"));
    await microtareas();
    const dialogo = document.querySelector("[role=alertdialog]") as HTMLElement;
    expect(dialogo.textContent).toContain("Se borra para siempre. Las cifras no cambian.");
    clic(porTexto(dialogo, "button", "Cancelar"));
    await microtareas();
    expect(borrar).not.toHaveBeenCalled();
    clic(porEtiqueta(c, "Borrar Ventas de hoy"));
    await microtareas();
    clic(porTexto(document.querySelector("[role=alertdialog]") as HTMLElement, "button", "Borrar"));
    await microtareas();
    await microtareas();
    expect(borrar).toHaveBeenCalledWith("c1");
    expect(panel(c)?.textContent).not.toContain("Ventas de hoy");
  });

  it("borrar la conversacion abierta deja la portada limpia", async () => {
    const borrar = vi.fn(async () => {});
    const abrirFn = vi.fn(async () => ({ id: "c1", titulo: "t", mensajes: [{ id: "m", role: "user" as const, text: "contenido viejo" }] }));
    const { t } = transporteFalso({ listar: async () => CONVS, abrir: abrirFn, borrar });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA })} />);
    const c = montado.container;
    await abrir(c);
    clic(porTexto(panel(c) as HTMLElement, "button", "Ventas de hoy"));
    await microtareas();
    await abrir(c);
    clic(porEtiqueta(c, "Borrar Ventas de hoy"));
    await microtareas();
    clic(porTexto(document.querySelector("[role=alertdialog]") as HTMLElement, "button", "Borrar"));
    await microtareas();
    await microtareas();
    expect(c.textContent).not.toContain("contenido viejo");
    expect(c.querySelector("h1")).not.toBeNull();
  });

  it("sin renombrar/borrar en el transporte no se ofrecen esos controles", async () => {
    const { t } = transporteFalso({ listar: async () => CONVS });
    montado = montar(<ChatDatosShell {...propsBase(t, { zonaHoraria: ZONA, ahora: () => AHORA })} />);
    await abrir(montado.container);
    expect(panel(montado.container)?.querySelector("[aria-label^='Renombrar']")).toBeNull();
    expect(panel(montado.container)?.querySelector("[aria-label^='Borrar']")).toBeNull();
  });
});
