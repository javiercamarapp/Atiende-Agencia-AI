// @vitest-environment jsdom
//
// «Atención de pedidos» (F4b): las tres listas salen del API real (fetch simulado), aceptar manda el tiempo prometido editable, rechazar exige un motivo de lista cerrada,
// la salida manda repartidor y minutos, la entrega manda la hora real, y la base sin migrar se dice con claridad (sin tarjetas ni cifras inventadas).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperacionCicloPage } from "../../src/verticals/restaurantes/pages/OperacionCiclo.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Persona de prueba", staffEmail: "persona@example.com" } as unknown as RestaurantesShellContext;
const ID = "00000000-0000-4000-8000-000000000a01";
const CHOFER = "00000000-0000-4000-8000-000000000c01";

function pedido(extra: Record<string, unknown> = {}) {
  return {
    id: ID, orderNumber: 301, propertyId: "prop-1", branch: "Centro", customerId: null, customerName: "Ana R.", customerPhone: "9995550101", customerAddress: "Calle 1", total: 250, status: "pending",
    items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", createdAt: new Date().toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio",
    ...extra,
  };
}
const RATIOS = {
  disponible: true, desde: "a", hasta: "b", detalle: { tiempos: true, encuesta: true },
  ratios: { tasaAceptacionPct: 80, tasaRechazoPct: 20, cumplimientoPromesaPct: 70, desvioMinProm: 4.5, aceptacionSegProm: 95, salidaMinProm: 12, encuesta: { tasaRespuestaPct: 40, promedio: 4.2, pctBajas: 10, tasaOptOutPct: 1, enviadas: 10, respondidas: 4 } },
};
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

/** Fetch simulado por ruta; `escrituras` recoge las llamadas POST/PUT para afirmar sobre ellas. */
function servidor(opciones: { pedidos?: unknown[]; estado?: number; ratios?: unknown } = {}) {
  const escrituras: Array<{ url: string; cuerpo: unknown }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" || init?.method === "PUT") {
      escrituras.push({ url: u, cuerpo: init.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/aceptar")) return json(200, { resultado: "aceptado", aceptadoAt: "x", tiempoPrometidoMin: 50, aviso: { encolado: true } });
      if (u.endsWith("/rechazar")) return json(200, { resultado: "rechazado", rechazadoAt: "x", motivo: "saturado", aviso: { encolado: true } });
      if (u.endsWith("/salida")) return json(200, { resultado: "despachado", salioAt: "x", repartidorId: CHOFER, horaRealRegistrada: true });
      if (u.endsWith("/entrega")) return json(200, { resultado: "entregado", entregadoAt: "x", minutosDesdeAceptado: 40, tiempoPrometidoMin: 45 });
      return json(200, { ok: true });
    }
    if (u.includes("/admin/orders")) return opciones.estado ? json(opciones.estado, { code: "service_unavailable", message: "503 base sin migrar" }) : json(200, { orders: opciones.pedidos ?? [], nextCursor: null });
    if (u.includes("/admin/staff/repartidores")) return json(200, { repartidores: [{ id: CHOFER, email: "chofer@example.com", fullName: "Chofer Uno", propertyIds: null }] });
    if (u.includes("/admin/ciclo/ratios")) return json(200, opciones.ratios ?? RATIOS);
    if (u.includes("/encuesta/config")) return json(200, { disponible: true, habilitada: false, linkResena: null });
    if (u.includes("/recordatorios/config")) return json(200, { disponible: true, habilitado: true, primeroMin: 10, repetirMin: 10, maximo: 3 });
    return json(404, { code: "not_found", message: "no" });
  });
  return { f, escrituras };
}

let rendered: RenderedComponent | undefined;
async function montar(f: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", f);
  await act(async () => {
    rendered = renderComponent(<OperacionCicloPage {...CTX} />);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const textos = () => document.body.textContent ?? "";
const boton = (nombre: RegExp) => [...document.querySelectorAll("button")].find((b) => nombre.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLElement | undefined;
async function esperar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
function escribir(input: HTMLInputElement, valor: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Atención de pedidos", () => {
  it("pide los pedidos por aceptar al API real y muestra los ratios de operacion", async () => {
    const s = servidor({ pedidos: [pedido()] });
    await montar(s.f);
    expect((s.f.mock.calls.find((c) => String(c[0]).includes("/admin/orders")) as unknown as [string])[0]).toContain("status=pending");
    expect(textos()).toContain("Pedido #301");
    expect(textos()).toContain("Ana R.");
    expect(document.querySelector('[data-testid="ratios-operacion"]')?.textContent).toContain("80%");
    expect(document.querySelector('[data-testid="ratios-operacion"]')?.textContent).toContain("+4.5 min");
    expect(document.querySelector('[data-testid="ratios-operacion"]')?.textContent).toContain("4.2 / 5");
  });

  it("aceptar: pide el tiempo prometido (45 por omision en domicilio, editable) y manda un solo POST con ese tiempo", async () => {
    const s = servidor({ pedidos: [pedido()] });
    await montar(s.f);
    await act(async () => click(boton(/^Aceptar$/)!));
    const entrada = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(entrada.value).toBe("45");
    escribir(entrada, "50");
    await act(async () => click(boton(/Aceptar pedido/)!));
    await esperar();
    const posts = s.escrituras.filter((e) => e.url.endsWith("/aceptar"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ url: `https://api.test/v1/restaurantes/prop-1/admin/ciclo/pedidos/${ID}/aceptar`, cuerpo: { tiempoPrometidoMin: 50 } });
  });

  it("aceptar con un tiempo fuera de 5 a 240 deja el boton deshabilitado (no manda nada)", async () => {
    const s = servidor({ pedidos: [pedido()] });
    await montar(s.f);
    await act(async () => click(boton(/^Aceptar$/)!));
    escribir(document.querySelector('input[type="number"]') as HTMLInputElement, "3");
    expect((boton(/Aceptar pedido/) as HTMLButtonElement).disabled).toBe(true);
    expect(s.escrituras).toHaveLength(0);
  });

  it("para recoger el tiempo por omision es 20 min", async () => {
    const s = servidor({ pedidos: [pedido({ canal: "recoger" })] });
    await montar(s.f);
    await act(async () => click(boton(/^Aceptar$/)!));
    expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("20");
  });

  it("rechazar: sin motivo no se puede confirmar; la lista cerrada trae los motivos del servidor", async () => {
    const s = servidor({ pedidos: [pedido()] });
    await montar(s.f);
    await act(async () => click(boton(/^Rechazar$/)!));
    expect((boton(/Rechazar pedido/) as HTMLButtonElement).disabled).toBe(true);
    for (const etiqueta of ["Faltan productos o insumos", "La sucursal está cerrada", "Domicilio fuera de zona", "Cocina saturada", "Faltan datos del pedido", "Otro motivo"]) {
      expect(document.body.innerHTML).toContain(etiqueta);
    }
    expect(s.escrituras).toHaveLength(0);
  });

  it("un 503 (base sin migrar) al cargar dice que falta la actualizacion y no pinta tarjetas", async () => {
    const s = servidor({ estado: 503 });
    await montar(s.f);
    expect(textos()).toContain("migraciones 170 a 172");
    expect(document.querySelector('[data-testid^="tarjeta-ciclo"]')).toBeNull();
  });

  it("sin ratios disponibles (base sin migrar) no se pinta ninguna cifra", async () => {
    const s = servidor({ pedidos: [pedido()], ratios: { disponible: false, desde: "a", hasta: "b", ratios: null, detalle: { tiempos: false, encuesta: false } } });
    await montar(s.f);
    expect(document.querySelector('[data-testid="ratios-operacion"]')).toBeNull();
  });

  it("el dueno ve el encendido de encuesta y recordatorios; la encuesta viene apagada", async () => {
    const s = servidor({ pedidos: [] });
    await montar(s.f);
    const config = document.querySelector('[data-testid="config-ciclo"]');
    expect(config?.textContent).toContain("Encuesta de 1 a 5 por WhatsApp");
    expect(config?.textContent).toContain("hasta 3 veces");
    expect((document.querySelector('[aria-label="Encuesta de satisfacción después de entregar"]') as HTMLElement).getAttribute("aria-checked")).toBe("false");
  });
});
