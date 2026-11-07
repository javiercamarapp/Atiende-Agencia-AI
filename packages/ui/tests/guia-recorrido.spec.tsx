// @vitest-environment jsdom
//
// ds3 «Guía» en el DOM: el boton «Guía» de la cabecera (evento) abre el menu; recorrido corto/completo, retomar, saltar a una pantalla,
// Esc devuelve el foco a quien abrio la guia, el progreso se guarda en el navegador y en el servidor, y «Primeros pasos» pinta el avance
// honesto («n de m que puedes hacer ahora»), el recomendado y la celebracion de un hito nuevo.
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GuiaRecorrido, GUIA_ABRIR_EVENTO_RECORRIDO, iniciarRecorridoGuia } from "../src/components/guia/GuiaRecorrido";
import { vaciarGuardadoGuia } from "../src/components/guia/eventos";
import { PrimerosPasos, hitosNuevos, resumirPrimerosPasos, type PrimerPaso } from "../src/components/guia/PrimerosPasos";
import type { SeccionMenu } from "../src/components/guia/motor";
import type { ProgresoLocal, ServidorProgreso } from "../src/components/guia/estado";
import { clic, limpiarDom, microtareas, montar, tecla, type Montado } from "./copiloto-utils";

const BASE = "/restaurantes/taqueria";
const MENU: SeccionMenu[] = [
  { title: "Resumen", items: [{ to: BASE, label: "Resumen" }] },
  { title: "Operación", items: [{ to: `${BASE}/pedidos`, label: "Pedidos" }, { to: `${BASE}/historial`, label: "Historial" }] },
  { title: "Catálogo", items: [{ to: `${BASE}/productos`, label: "Productos" }] },
  { title: "Clientes", items: [{ to: `${BASE}/clientes`, label: "Clientes" }, { to: `${BASE}/sucursales`, label: "Sucursales" }] },
];

let montado: Montado | undefined;

beforeAll(() => {
  const p = Element.prototype as unknown as Record<string, unknown>;
  p["scrollIntoView"] ??= () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  window.localStorage.clear();
  // La hoja real de la guia con la bandera ds3 encendida deja la raiz en `display: contents` (sin ella la guia no se activa).
  const hoja = document.createElement("style");
  hoja.textContent = ".guia-raiz { display: contents; }";
  document.head.appendChild(hoja);
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => setTimeout(() => f(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function servidorFalso(inicial: ProgresoLocal | null = null): ServidorProgreso & { guardados: ProgresoLocal[] } {
  const guardados: ProgresoLocal[] = [];
  return { guardados, leer: vi.fn(async () => inicial), guardar: vi.fn(async (p: ProgresoLocal) => { guardados.push(p); }) };
}

async function esperar(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function guia(servidor?: ServidorProgreso, ruta = BASE) {
  montado = montar(
    <GuiaRecorrido
      sections={MENU}
      base={BASE}
      pista="restaurantes.owner"
      persona="u-1"
      organizacion="taqueria"
      organizacionNombre="Taquería"
      rolEtiqueta="Dueño"
      esenciales={["", "pedidos", "productos", "clientes", "sucursales"]}
      contenido={{ "": { ilu: "barras", que: { es: "Tu día en cifras.", en: "Your day in numbers." }, clave: { titulo: { es: "Cifras", en: "Numbers" }, cuerpo: { es: "Lo que vendiste.", en: "What you sold." } } } }}
      primerosPasosHref={`${BASE}/primeros-pasos`}
      servidor={servidor ?? null}
    />,
    ruta,
  );
  return montado;
}

const abrirMenu = () => act(() => { window.dispatchEvent(new CustomEvent(GUIA_ABRIR_EVENTO_RECORRIDO)); });

describe("GuiaRecorrido", () => {
  it("sin la hoja de la guia o con la bandera apagada: no pinta, no lee el servidor y no escucha el boton", async () => {
    document.head.innerHTML = "<style>.guia-raiz { display: none; }</style>";
    const servidor = servidorFalso();
    guia(servidor);
    await esperar();
    abrirMenu();
    expect(document.querySelector(".guia-invitacion, #guia-menu")).toBeNull();
    expect(servidor.leer).not.toHaveBeenCalled();
    document.head.innerHTML = "";
  });

  it("primer ingreso: invitacion con corto y completo, sin bloquear la pantalla", async () => {
    guia();
    await esperar();
    const inv = document.querySelector(".guia-invitacion");
    expect(inv?.textContent).toContain("Conoce Atiende");
    expect(inv?.querySelector('[data-guia-modo="corto"]')?.textContent).toBe("Recorrido corto (7 pasos)");
    expect(inv?.querySelector('[data-guia-modo="completo"]')?.textContent).toMatch(/Recorrido completo \(\d+ pasos\)/);
    expect(document.querySelector(".guia-capa")).toBeNull();
  });

  it("el boton «Guía» (evento de la cabecera) abre el menu con rol, recorridos, saltar a una pantalla y primeros pasos; Esc lo cierra y devuelve el foco", async () => {
    guia();
    await esperar();
    const boton = document.createElement("button");
    boton.textContent = "Guía";
    document.body.appendChild(boton);
    boton.focus();
    abrirMenu();
    const menu = document.querySelector("#guia-menu")!;
    expect(menu.querySelector(".guia-menu-ctx")?.textContent).toBe("Taquería · Dueño");
    expect([...menu.querySelectorAll(".guia-menu-pantallas button")].map((b) => b.textContent)).toEqual(["Resumen", "Pedidos", "Historial", "Productos", "Clientes", "Sucursales"]);
    expect(menu.textContent).toContain("Ver la lista de primeros pasos");
    expect(document.activeElement).toBe(menu.querySelector("button"));
    tecla(menu, "Escape");
    expect(document.querySelector("#guia-menu")).toBeNull();
    expect(document.activeElement).toBe(boton);
  });

  it("recorrido corto: tarjeta (dialogo no modal) con contador, avance y ruta; → avanza, ← retrocede, Esc cierra conservando el paso", async () => {
    const servidor = servidorFalso();
    guia(servidor);
    await esperar();
    clic(document.querySelector('.guia-invitacion [data-guia-modo="corto"]')!);
    await esperar();
    const tarjeta = () => document.querySelector(".guia-tarjeta")!;
    expect(tarjeta().getAttribute("role")).toBe("dialog");
    expect(tarjeta().getAttribute("aria-modal")).toBe("false");
    expect(tarjeta().querySelector("h2")?.textContent).toBe("Resumen");
    expect(tarjeta().querySelector(".guia-contador")?.textContent).toBe("Paso 1 de 7");
    expect(tarjeta().querySelector('.guia-ruta [aria-current="step"]')?.textContent).toBe("Resumen");
    expect(document.querySelector(".guia-capa")?.getAttribute("aria-hidden")).toBe("true");
    tecla(document.body, "ArrowRight");
    await esperar();
    expect(tarjeta().querySelector("h2")?.textContent).toBe("Cifras");
    tecla(document.body, "ArrowLeft");
    await esperar();
    expect(tarjeta().querySelector("h2")?.textContent).toBe("Resumen");
    tecla(document.body, "Escape");
    await esperar(450);
    expect(document.querySelector(".guia-tarjeta")).toBeNull();
    const guardado = JSON.parse(Object.values({ ...window.localStorage }).find((v) => String(v).includes("resumen.que")) as string);
    expect(guardado).toMatchObject({ paso: "resumen.que", activo: false, visto: true, modo: "corto" });
    expect(servidor.guardar).toHaveBeenCalled();
    expect(servidor.guardados.at(-1)).toMatchObject({ paso: "resumen.que", activo: false });
    // «Retomar donde lo dejé» aparece en el menu.
    abrirMenu();
    expect(document.querySelector("[data-guia-retomar]")).not.toBeNull();
  });

  it("paso «ir» fuera de la pantalla: «Vamos a …» con «Haz clic o espera» y cuenta de 3 s; «Quedarme aquí» la cancela", async () => {
    guia();
    await esperar();
    const enlace = document.createElement("a");
    enlace.href = `${BASE}/pedidos`;
    enlace.textContent = "Pedidos";
    const aside = document.createElement("aside");
    aside.appendChild(enlace);
    document.body.appendChild(aside);
    enlace.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    clic(document.querySelector('.guia-invitacion [data-guia-modo="corto"]')!);
    await esperar();
    tecla(document.body, "ArrowRight");
    await esperar();
    tecla(document.body, "ArrowRight");
    await esperar(60);
    const tarjeta = document.querySelector(".guia-tarjeta")!;
    expect(tarjeta.querySelector("h2")?.textContent).toBe("Vamos a Pedidos");
    expect(tarjeta.querySelector("[data-guia-cuenta]")?.textContent).toContain("Te llevo a Pedidos en 3 s.");
    expect(document.querySelector(".guia-etiqueta")?.textContent).toBe("Haz clic aquí: Pedidos");
    clic(tarjeta.querySelector("[data-guia-quedarme]")!);
    await esperar();
    expect(document.querySelector("[data-guia-cuenta]")).toBeNull();
    expect(document.querySelector("[data-guia-manual]")?.textContent).toBe("Ir a Pedidos");
  });

  it("retoma lo del servidor si es mas nuevo y reabre en el mismo paso SIN viaje automatico", async () => {
    const servidor = servidorFalso({ visto: true, omitido: false, descartado: false, paso: "productos.que", activo: true, modo: "corto", terminado: false, actualizado: Date.now() + 1000 });
    guia(servidor, `${BASE}/productos`);
    await esperar(60);
    expect(document.querySelector(".guia-tarjeta h2")?.textContent).toBe("Productos");
    expect(document.querySelector("[data-guia-cuenta]")).toBeNull();
  });

  it("descartado («no volver a mostrar»): sin invitacion; el menu ofrece volver a mostrarla", async () => {
    guia();
    await esperar();
    abrirMenu();
    clic([...document.querySelectorAll("#guia-menu button")].find((b) => b.textContent === "Omitir y no volver a mostrar")!);
    await esperar();
    expect(document.querySelector(".guia-invitacion")).toBeNull();
    abrirMenu();
    expect(document.querySelector("#guia-menu")?.textContent).toContain("Volver a mostrar la invitación");
  });

  it("lo pendiente se envia al desmontar (cambio de consola) con keepalive: no se pierde el ultimo cambio", async () => {
    const servidor = servidorFalso();
    guia(servidor);
    await esperar();
    clic(document.querySelector('.guia-invitacion [data-guia-modo="corto"]')!);
    tecla(document.body, "Escape");
    const antes = (servidor.guardar as ReturnType<typeof vi.fn>).mock.calls.length;
    montado!.unmount();
    montado = undefined;
    const llamadas = (servidor.guardar as ReturnType<typeof vi.fn>).mock.calls;
    expect(llamadas.length).toBe(antes + 1);
    expect(llamadas.at(-1)).toEqual([expect.objectContaining({ activo: false }), { keepalive: true }]);
  });

  it("vaciarGuardadoGuia (al cerrar sesion) envia lo pendiente ya", async () => {
    const servidor = servidorFalso();
    guia(servidor);
    await esperar();
    clic(document.querySelector('.guia-invitacion [data-guia-modo="corto"]')!);
    act(() => vaciarGuardadoGuia());
    expect((servidor.guardar as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toEqual({ keepalive: true });
  });

  it("iniciarRecorridoGuia (desde «Primeros pasos») empieza directo", async () => {
    guia();
    await esperar();
    act(() => iniciarRecorridoGuia("corto"));
    await esperar();
    expect(document.querySelector(".guia-tarjeta .guia-contador")?.textContent).toBe("Paso 1 de 7");
  });

  it("en ingles con ?lang=en / preferencia guardada", async () => {
    window.localStorage.setItem("atiende-idioma", "en");
    guia();
    await esperar();
    expect(document.querySelector(".guia-invitacion h2")?.textContent).toBe("Meet Atiende");
    clic(document.querySelector('.guia-invitacion [data-guia-modo="corto"]')!);
    await esperar();
    expect(document.querySelector(".guia-tarjeta p#guia-t-cuerpo")?.textContent).toBe("Your day in numbers.");
  });
});

const PASOS: PrimerPaso[] = [
  { id: "sucursal", titulo: "Sucursal con dirección", detalle: "Ubicación en el mapa.", estado: "hecho", obligatorio: true, responsable: "Tú", href: "/x/sucursales" },
  { id: "menu", titulo: "Menú cargado", detalle: "Productos disponibles.", estado: "parcial", obligatorio: true, faltantes: ["Centro"], href: "/x/productos" },
  { id: "whatsapp", titulo: "WhatsApp conectado", detalle: "Número verificado por Meta.", estado: "externo", responsable: "Meta" },
  { id: "horario", titulo: "Horario", detalle: "Horas de servicio.", estado: "pendiente", href: "/x/sucursales" },
  { id: "voz", titulo: "Agente de voz", detalle: "Lo prende Atiende.", estado: "pendiente", puedeHacerlo: false },
];

describe("PrimerosPasos", () => {
  it("avance honesto: solo cuenta lo que este rol puede hacer; lo de terceros va «en espera»; recomendado = primera pendiente propia", () => {
    expect(resumirPrimerosPasos(PASOS)).toEqual({ hechos: 1, total: 3, enEspera: 1, siguiente: "menu", listo: false });
    montado = montar(<PrimerosPasos pasos={PASOS} rolEtiqueta="Dueño" />);
    const raiz = document.querySelector(".guia-pp")!;
    expect(raiz.textContent).toContain("Estás viendo la configuración como Dueño.");
    expect(raiz.textContent).toContain("1 de 3 que puedes hacer ahora");
    expect(raiz.textContent).toContain("1 en espera");
    const menu = raiz.querySelector('[data-guia-paso="menu"]')!;
    expect(menu.hasAttribute("data-siguiente")).toBe(true);
    expect(menu.textContent).toContain("Recomendado ahora");
    expect(menu.textContent).toContain("Falta en: Centro");
    expect(menu.querySelector("a")?.getAttribute("href")).toBe("/x/productos");
    // Hecho, en espera o de otra persona: sin «Ir a hacerlo».
    expect(raiz.querySelector('[data-guia-paso="sucursal"] a')).toBeNull();
    expect(raiz.querySelector('[data-guia-paso="voz"] a')).toBeNull();
    expect(raiz.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("celebra un hito nuevo una sola vez (nunca en la primera visita)", async () => {
    expect(hitosNuevos(null, ["a"])).toEqual([]);
    expect(hitosNuevos('["a"]', ["a", "b"])).toEqual(["b"]);
    expect(hitosNuevos("{roto", ["a"])).toEqual([]);
    montado = montar(<PrimerosPasos pasos={PASOS} rolEtiqueta="Dueño" claveCelebracion="restaurantes:taqueria" />);
    await microtareas();
    expect(document.querySelector("[data-guia-celebra]")).toBeNull();
    montado.unmount();
    const listos = PASOS.map((p) => (p.obligatorio ? { ...p, estado: "hecho" as const } : p));
    montado = montar(<PrimerosPasos pasos={listos} rolEtiqueta="Dueño" claveCelebracion="restaurantes:taqueria" />);
    await microtareas();
    expect(document.querySelector('[data-guia-celebra="listo"]')?.textContent).toContain("Todo listo para operar");
    montado.unmount();
    montado = montar(<PrimerosPasos pasos={listos} rolEtiqueta="Dueño" claveCelebracion="restaurantes:taqueria" />);
    await microtareas();
    expect(document.querySelector("[data-guia-celebra]")).toBeNull();
  });

  it("error sin datos: estado de error con «Reintentar»", () => {
    const reintentar = vi.fn();
    montado = montar(<PrimerosPasos pasos={null} error="x" rolEtiqueta="Dueño" onReintentar={reintentar} />);
    const boton = [...document.querySelectorAll("button")].find((b) => /reintentar/i.test(b.textContent ?? ""));
    expect(boton).toBeDefined();
    clic(boton!);
    expect(reintentar).toHaveBeenCalled();
  });
});
