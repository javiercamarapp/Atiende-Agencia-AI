// @vitest-environment jsdom
//
// «Mis entregas» del chofer (PLAN-PANEL-OPERADOR paquete C1), con `fetch` por ruta real. Cada caso afirma el EFECTO: que NUNCA se pinta el telefono,
// que «Entregado» pide confirmacion y dispara UNA sola peticion con su llave de idempotencia, que «Deshacer» aparece 60 s, que sin red la entrega
// se guarda con la misma llave, que lo entregado se retira a los 2 min y que un 501 cae a la vista anterior.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MisEntregas } from "../src/verticals/restaurantes/components/chofer/MisEntregas.tsx";
import { claveCola, encolarEntrega, leerPendientes, purgarColas } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";
import type { AlmacenLocal } from "../src/verticals/restaurantes/lib/cola-entrega-offline.ts";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  purgarColas(null, null);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-21T20:00:00.000Z"));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const API = "https://api.test";
const BASE = `${API}/v1/restaurantes/prop-1/repartidor`;
const ID = "00000000-0000-4000-8000-000000000145";
const TELEFONO = "+529991234567";

const ENTREGA = {
  id: ID,
  numero: 145,
  estado: "en_camino",
  clienteNombre: "Ana R.",
  direccion: { texto: "Calle 60 #320", colonia: "Centro" },
  indicaciones: "Portón negro",
  total: 708,
  pago: { forma: "efectivo", pagaCon: 1000 },
  resumenItems: "4 taquitos al pastor",
  totalPiezas: 4,
  salioAt: "2026-10-21T19:38:00.000Z",
  etaAt: null,
  minutos: 22,
  semaforo: "verde",
};

const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status });
function memoria(): AlmacenLocal {
  const d = new Map<string, string>();
  return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => void d.set(k, v), removeItem: (k) => void d.delete(k), key: (i) => [...d.keys()][i] ?? null, get length() { return d.size; } };
}
const IDENTIDAD = "ana@example.test";
const CLAVE = claveCola("prop-1", IDENTIDAD);

type Manejador = (url: string, init?: RequestInit) => Response | Promise<Response>;
function montar(manejador: Manejador, extra: Partial<React.ComponentProps<typeof MisEntregas>> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => manejador(String(url), init));
  rendered = renderComponent(<MisEntregas apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={fetchMock as unknown as typeof fetch} identidad={IDENTIDAD} almacen={memoria()} {...extra} />);
  return fetchMock;
}
const llamadas = (f: ReturnType<typeof vi.fn>, fin: string) => f.mock.calls.filter(([u, i]) => String(u).endsWith(fin) && (i as RequestInit | undefined)?.method === "POST");

async function esperar(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
const botones = () => [...document.querySelectorAll("button")];
const boton = (texto: string | RegExp) => botones().find((b) => (typeof texto === "string" ? b.textContent?.trim() === texto : texto.test(b.textContent ?? "")));
const dialogo = () => document.querySelector('[role="alertdialog"], [role="dialog"]');

function servidorBasico(extra: Manejador = () => json(404, { code: "not_found", message: "?" })): Manejador {
  return (url, init) => {
    if (url === `${BASE}/entregas`) return json(200, { entregas: [ENTREGA], actualizadoEn: "2026-10-21T20:00:00.000Z" });
    return extra(url, init);
  };
}

describe("lista de entregas", () => {
  it("muestra nombre, direccion, total, pago, cambio e indicaciones y NUNCA el telefono", async () => {
    montar(servidorBasico());
    await esperar();
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("#145 · Ana R.");
    expect(texto).toContain("Calle 60 #320, Centro");
    expect(texto).toContain("Total $708.00");
    expect(texto).toContain("Paga con $1,000.00");
    expect(texto).toContain("cambio $292.00");
    expect(texto).toContain("Portón negro");
    expect(texto).toContain("22 min");
    expect(texto).not.toMatch(/\+?\d{10,}/);
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="https://www.google.com/maps/search"]')).not.toBeNull();
  });

  it("los botones principales miden 56 dp (h-14), incluidos «No pude entregar» y Actualizar", async () => {
    montar(servidorBasico());
    await esperar();
    for (const nombre of [/^Entregado$/, /^Llamar$/, /^No pude entregar$/, /Actualizar/]) {
      expect(boton(nombre)!.className).toContain("h-14");
    }
  });

  it("sin entregas: estado vacio honesto; con error de carga: mensaje y Reintentar", async () => {
    montar(() => json(200, { entregas: [], actualizadoEn: "2026-10-21T20:00:00.000Z" }));
    await esperar();
    expect(document.body.textContent).toContain("Sin entregas en camino");
    rendered!.unmount();
    document.body.innerHTML = "";
    montar(() => json(500, { code: "internal", message: "Falla del servidor" }));
    await esperar();
    expect(document.body.textContent).toContain("Falla del servidor");
    expect(boton("Reintentar")).toBeDefined();
  });

  it("sondea cada 15 s", async () => {
    const f = montar(servidorBasico());
    await esperar();
    const antes = f.mock.calls.filter(([u]) => String(u).endsWith("/entregas")).length;
    await esperar(15_000);
    expect(f.mock.calls.filter(([u]) => String(u).endsWith("/entregas")).length).toBe(antes + 1);
  });

  it("un 501 avisa para caer a la vista anterior y no pinta error", async () => {
    const onNoDisponible = vi.fn();
    montar(() => json(501, { code: "no_implementado", message: "No disponible aún" }), { onNoDisponible });
    await esperar();
    expect(onNoDisponible).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("No disponible aún");
  });
});

describe("Entregado y Deshacer", () => {
  const respuestaEntregar = () => json(200, { resultado: "entregado", entregadoAt: "2026-10-21T20:00:00.000Z", puedeDeshacerHasta: "2026-10-21T20:01:00.000Z" });

  async function abrirConfirmacion() {
    const f = montar(servidorBasico((url) => (url.endsWith("/entregar") ? respuestaEntregar() : url.endsWith("/deshacer-entrega") ? json(200, { resultado: "deshecho", estado: "en_camino", avisoYaEnviado: false }) : json(404, { code: "x", message: "?" }))));
    await esperar();
    click(boton(/^Entregado$/)!);
    await esperar();
    return f;
  }

  it("los botones de la confirmacion miden 56 dp", async () => {
    await abrirConfirmacion();
    for (const t of ["Volver", "Sí, entregado"]) expect(botones().find((b) => b.textContent?.includes(t))!.className, t).toContain("h-14");
  });

  it("pide confirmacion antes de llamar al servidor; Volver no escribe", async () => {
    const f = await abrirConfirmacion();
    expect(dialogo()?.textContent).toContain("¿Entregaste el pedido #145?");
    expect(llamadas(f, "/entregar")).toHaveLength(0);
    click(botones().find((b) => b.textContent?.trim() === "Volver")!);
    await esperar();
    expect(llamadas(f, "/entregar")).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("confirmar envia UNA peticion con llave de idempotencia y cobrado, y la tarjeta pasa a Entregado con Deshacer", async () => {
    const f = await abrirConfirmacion();
    const si = botones().find((b) => b.textContent?.includes("Sí, entregado"))!;
    click(si);
    click(si); // segundo toque inmediato: no debe duplicar
    await esperar();
    const envios = llamadas(f, "/entregar");
    expect(envios).toHaveLength(1);
    const init = envios[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ desdeEstado: "en_camino", cobradoMonto: 708 });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.body.textContent).toContain("Entregado");
    expect(boton(/^Deshacer \(60 s\)$/)).toBeDefined();
    expect(boton(/^Entregado$/)).toBeUndefined();
  });

  it("sin cobro: vaciar el monto manda cobradoMonto null; uno corregido manda ese monto", async () => {
    const f = await abrirConfirmacion();
    const campo = dialogo()!.querySelector("input") as HTMLInputElement;
    expect(campo.value).toBe("708");
    changeValue(campo, "");
    await esperar();
    click(botones().find((b) => b.textContent?.includes("Sí, entregado"))!);
    await esperar();
    expect(JSON.parse((llamadas(f, "/entregar")[0]![1] as RequestInit).body as string).cobradoMonto).toBeNull();
  });

  it("Deshacer vuelve la tarjeta a en camino; la cuenta regresiva baja y a los 60 s ya no se ofrece", async () => {
    const f = await abrirConfirmacion();
    click(botones().find((b) => b.textContent?.includes("Sí, entregado"))!);
    await esperar();
    await esperar(20_000);
    expect(boton(/^Deshacer \(4\d s\)$/)).toBeDefined();
    click(boton(/^Deshacer/)!);
    await esperar();
    expect(llamadas(f, "/deshacer-entrega")).toHaveLength(1);
    expect(boton(/^Entregado$/)).toBeDefined();
  });

  it("lo entregado se retira de la lista a los 2 min", async () => {
    await abrirConfirmacion();
    click(botones().find((b) => b.textContent?.includes("Sí, entregado"))!);
    await esperar();
    expect(document.body.textContent).toContain("#145");
    await esperar(121_000);
    expect(document.body.textContent).not.toContain("#145 · Ana R.");
  });

  it("sin senal: la entrega se guarda con su llave y se reenvia sola al volver la red", async () => {
    const almacen = memoria();
    let hayRed = false;
    const f = montar(
      (url) => {
        if (url.endsWith("/entregar")) {
          if (!hayRed) throw new TypeError("Failed to fetch");
          return respuestaEntregar();
        }
        if (url.endsWith("/entregas")) return json(200, { entregas: hayRed ? [] : [ENTREGA], actualizadoEn: "2026-10-21T20:00:00.000Z" });
        return json(404, { code: "x", message: "?" });
      },
      { almacen },
    );
    await esperar();
    click(boton(/^Entregado$/)!);
    await esperar();
    click(botones().find((b) => b.textContent?.includes("Sí, entregado"))!);
    await esperar();
    const guardadas = leerPendientes(almacen, CLAVE, Date.now());
    expect(guardadas).toHaveLength(1);
    expect(document.body.textContent).toContain("guardada en tu celular");
    const llaveOriginal = guardadas[0]!.llave;

    hayRed = true;
    await esperar(15_000);
    const envios = llamadas(f, "/entregar");
    expect(envios.length).toBeGreaterThanOrEqual(2);
    expect(((envios.at(-1)![1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]).toBe(llaveOriginal);
    expect(leerPendientes(almacen, CLAVE, Date.now())).toHaveLength(0);
  });
});

describe("sin almacenamiento y celular compartido", () => {
  function servidorSinRed(hayRed: () => boolean): Manejador {
    return (url) => {
      if (url.endsWith("/entregar")) {
        if (!hayRed()) throw new TypeError("Failed to fetch");
        return json(200, { resultado: "entregado", entregadoAt: "2026-10-21T20:00:00.000Z", puedeDeshacerHasta: "2026-10-21T20:01:00.000Z" });
      }
      if (url.endsWith("/entregas")) return json(200, { entregas: hayRed() ? [] : [ENTREGA], actualizadoEn: "2026-10-21T20:00:00.000Z" });
      return json(404, { code: "x", message: "?" });
    };
  }

  it("sin localStorage: avisa que NO se guardo en el celular, no pierde la entrega y la reenvia al volver la red", async () => {
    let red = false;
    const f = montar(servidorSinRed(() => red), { almacen: null });
    await esperar();
    click(boton(/^Entregado$/)!);
    await esperar();
    click(botones().find((b) => b.textContent?.includes("Sí, entregado"))!);
    await esperar();
    expect(document.body.textContent).toContain("NO se pudo guardar en el celular");
    expect(document.body.textContent).toContain("no cierres ni recargues");
    red = true;
    await esperar(15_000);
    expect(llamadas(f, "/entregar").length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).not.toContain("NO se pudo guardar");
  });

  it("lo pendiente de otro chofer en el mismo celular no se reenvia desde esta sesion", async () => {
    const almacen = memoria();
    encolarEntrega(almacen, claveCola("prop-1", "luis@example.test"), { orderId: ID, llave: "llave-de-luis", cobradoMonto: 708, en: Date.now() });
    const f = montar(servidorBasico(), { almacen });
    await esperar(15_000);
    expect(llamadas(f, "/entregar")).toHaveLength(0);
  });
});

describe("Llamar y No pude entregar", () => {
  it("Llamar pide el numero al servidor y abre tel:, sin dejarlo en pantalla", async () => {
    const abrirTelefono = vi.fn();
    const f = montar(servidorBasico((url) => (url.endsWith("/llamar") ? json(200, { telefono: TELEFONO }) : json(404, { code: "x", message: "?" }))), { abrirTelefono });
    await esperar();
    click(boton(/^Llamar$/)!);
    await esperar();
    expect(llamadas(f, "/llamar")).toHaveLength(1);
    expect(abrirTelefono).toHaveBeenCalledWith("tel:+529991234567");
    expect(document.body.textContent).not.toContain("9991234567");
  });

  it("No pude entregar: motivo cerrado; Reportar manda el motivo y la tarjeta queda como problema", async () => {
    const f = montar(servidorBasico((url) => (url.endsWith("/problema") ? json(200, { resultado: "problema", estado: "problema" }) : json(404, { code: "x", message: "?" }))));
    await esperar();
    click(boton(/^No pude entregar$/)!);
    await esperar();
    const d = dialogo()!;
    expect(d.textContent).toContain("No encontré la dirección");
    expect(d.textContent).toContain("El cliente no contesta");
    click([...d.querySelectorAll("input[type=radio]")].find((r) => (r as HTMLInputElement).value === "direccion")!);
    await esperar();
    click([...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reportar problema")!);
    await esperar();
    const envios = llamadas(f, "/problema");
    expect(envios).toHaveLength(1);
    expect(JSON.parse((envios[0]![1] as RequestInit).body as string)).toEqual({ motivo: "direccion" });
    expect(document.body.textContent).toContain("Problema reportado");
  });

  it("«Otro motivo» exige una nota: sin ella el boton queda deshabilitado y no escribe", async () => {
    const f = montar(servidorBasico());
    await esperar();
    click(boton(/^No pude entregar$/)!);
    await esperar();
    const d = dialogo()!;
    click([...d.querySelectorAll("input[type=radio]")].find((r) => (r as HTMLInputElement).value === "otro")!);
    await esperar();
    const reportar = [...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reportar problema") as HTMLButtonElement;
    expect(reportar.disabled).toBe(true);
    expect(llamadas(f, "/problema")).toHaveLength(0);
  });
});
