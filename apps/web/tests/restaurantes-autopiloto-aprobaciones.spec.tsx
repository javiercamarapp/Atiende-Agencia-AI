// @vitest-environment jsdom
//
// Autopiloto (migracion 050) en el panel: pestana "Por aprobar" de Pedidos con aprobacion de un clic, motivo de lista cerrada, compensaciones,
// estados honestos (base sin migrar, vacio, error), reglas por sucursal (solo owner/admin) y "Agotado hasta manana" en Productos. Cada boton llama al
// endpoint REAL: aqui se afirma la peticion exacta y el efecto en pantalla, no solo que el boton exista.
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { notify } from "@atiende/ui";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

function ctx(role = "owner"): RestaurantesShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam Demo", staffEmail: "sam@example.com" };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const GRANDE = {
  id: "11111111-1111-4111-8111-111111111111", propertyId: "prop-1", tipo: "pedido_grande", estado: "pendiente", orderId: "ord-1", detalle: { total: 4500 }, decision: null,
  motivoResolucion: null, codigoDescuento: null, solicitadaAt: new Date(Date.now() - 12 * 60_000).toISOString(), escaladaAt: null, resueltaAt: null,
  pedido: { numero: 88, total: 4500, status: "por_aprobar", clienteNombre: "Ana López", canal: "domicilio", renglones: [{ indice: 0, nombre: "Tacos al pastor", cantidad: 100 }] },
  decisionesPosibles: ["aprobar", "rechazar"],
};
const CANCELACION = { ...GRANDE, id: "22222222-2222-4222-8222-222222222222", tipo: "cancelacion", detalle: { origen: "cliente" }, decisionesPosibles: ["cancelar", "mantener"], pedido: { ...GRANDE.pedido, total: 150, status: "preparando", clienteNombre: "Luis Mena" } };
const COMPENSACION = {
  ...GRANDE, id: "33333333-3333-4333-8333-333333333333", tipo: "compensacion", detalle: { subtipo: "faltante" }, decisionesPosibles: ["sin_compensacion", "reponer_producto", "descuento_proximo"],
  pedido: { ...GRANDE.pedido, total: 200, status: "entregado", clienteNombre: "Rosa Díaz", renglones: [{ indice: 0, nombre: "Tacos", cantidad: 2 }, { indice: 1, nombre: "Agua", cantidad: 1 }] },
};

interface Estado {
  solicitudes: unknown[];
  disponible: boolean;
  fallaResolver?: string;
  config?: Record<string, unknown>;
  saturado?: boolean;
  historialDisponible?: boolean;
  pedidosPendientes?: unknown[];
  /** Campos que la API devuelve al resolver (sobre `aplicado: true`): para simular `aplicado: false`, un cierre como "mantener", etc. */
  respuestaResolver?: Record<string, unknown>;
}

function stub(estado: Estado) {
  const solicitudes = { current: estado.solicitudes };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith(`${BASE}/autopiloto/solicitudes`)) return json({ disponible: estado.disponible, solicitudes: solicitudes.current });
    if (method === "POST" && /\/autopiloto\/solicitudes\/[^/]+\/resolver$/.test(url)) {
      if (estado.fallaResolver) return json({ code: "validation_error", message: estado.fallaResolver }, 400);
      const id = url.split("/").slice(-2)[0];
      solicitudes.current = solicitudes.current.filter((s) => (s as { id: string }).id !== id);
      const body = JSON.parse(String(init?.body));
      return json({ aplicado: true, tipo: "pedido_grande", decision: body.decision, estadoPedido: "pending", codigoDescuento: body.decision === "descuento_proximo" ? "GRACIAS-AB12CD34" : null, reposicionOrderId: null, efectos: [], ...(estado.respuestaResolver ?? {}) });
    }
    if (method === "GET" && url === `${BASE}/autopiloto/config`) {
      return json({
        disponible: true,
        config: { cancelacionAuto: false, aceptacionAuto: false, aprobacionMinutos: 10, handoffRegresoMinutos: 15, noRecogidoMinutos: 60, completadoHoras: 6, compensacionTopePct: 20, saturacionUmbral1: null, saturacionUmbral2: null, saturacionExtraMinutos: 15, configurada: false, ...estado.config },
        plantillas: [{ nombre: "pedido_aprobado", aprobada: false }],
        posReal: false,
      });
    }
    if (method === "PUT" && url === `${BASE}/autopiloto/config`) return json({ ok: true, config: {} });
    if (method === "GET" && url.includes("/autopiloto/pedidos/") && url.endsWith("/historial")) {
      return json({
        disponible: estado.historialDisponible ?? true,
        eventos: [
          { desde: null, hacia: "pending", actor: "agente", motivo: null, at: "2026-10-04T12:00:00.000Z" },
          { desde: "pending", hacia: "cancelado", actor: "staff:abc", motivo: "sin_producto", at: "2026-10-04T12:05:00.000Z" },
        ],
      });
    }
    if (method === "GET" && url.startsWith(`${BASE}/autopiloto/tiempo`)) {
      return json({ tiempo: url.endsWith("domicilio") ? { origen: "aprendido", rango: { minimo: 40, maximo: 50 }, texto: "de 40 a 50 minutos", saturacion: estado.saturado ? "alargado" : "normal", muestras: 24 } : { origen: "texto_fijo", rango: null, texto: "Recoger 15-25 minutos", saturacion: "normal", muestras: 3 } });
    }
    if (url.includes("/admin/staff/repartidores")) return json({ repartidores: [] });
    if (method === "GET" && url.includes("/admin/orders")) {
      const status = new URL(url).searchParams.get("status");
      return json({ orders: status === "pending" ? (estado.pedidosPendientes ?? []) : [], nextCursor: null });
    }
    if (method === "GET" && url.includes("/admin/scheduled-orders")) return json({ disponible: true, orders: [], promovidos: [], serverNow: new Date().toISOString() });
    if (url.includes("/admin/avisos")) return json({ avisos: [] });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const botones = () => [...document.body.querySelectorAll("button")];
const boton = (texto: string) => botones().find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const posts = () => fetchMock.mock.calls.filter(([url, init]) => /\/resolver$/.test(String(url)) && (init as RequestInit | undefined)?.method === "POST");
const cuerpo = (i = 0) => JSON.parse(String((posts()[i]![1] as RequestInit).body));

async function abrirPorAprobar(role = "owner") {
  rendered = renderComponent(<PedidosPage {...ctx(role)} />);
  await esperar();
  const pestana = botones().find((b) => b.textContent?.includes("Por aprobar"))!;
  // Radix Tabs activa con mousedown (no con click), igual que la pestana Programados.
  await act(async () => {
    pestana.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await esperar();
}

describe("Pedidos: pestana Por aprobar", () => {
  it("la pestana lleva la insignia con las aprobaciones pendientes y la lista muestra pedido, total, espera y botones del tipo", async () => {
    stub({ solicitudes: [GRANDE, CANCELACION, COMPENSACION], disponible: true });
    await abrirPorAprobar();
    expect(document.body.querySelector('[data-testid="insignia-por-aprobar"]')?.textContent).toBe("3");
    const lista = document.body.querySelector('[data-testid="aprobaciones-lista"]')!;
    expect(lista.textContent).toContain("Ana López");
    expect(lista.textContent).toContain("100× Tacos al pastor");
    expect(lista.textContent).toContain("Espera hace 12 min");
    for (const t of ["Aprobar", "Rechazar", "Cancelar el pedido", "Mantener el pedido", "Sin compensación", "Reponer producto", "Descuento en el próximo pedido"]) expect(boton(t), t).toBeDefined();
    expect(lista.textContent).toContain("no se ejecuta desde aquí");
  });

  it("R2-seguridad-03: si el servidor no ofrece reponer ni descontar (rol staff) la tarjeta no muestra esos botones y lo dice", async () => {
    stub({ solicitudes: [{ ...COMPENSACION, decisionesPosibles: ["sin_compensacion"] }], disponible: true });
    await abrirPorAprobar("staff");
    expect(boton("Sin compensación")).toBeDefined();
    expect(boton("Reponer producto")).toBeUndefined();
    expect(boton("Descuento en el próximo pedido")).toBeUndefined();
    expect(document.body.querySelector('[data-testid="aprobaciones-lista"]')!.textContent).toContain("lo decide un dueño o administrador");
  });

  it("Aprobar manda POST .../resolver {decision:'aprobar'} UNA vez, recarga y la tarjeta desaparece", async () => {
    stub({ solicitudes: [GRANDE], disponible: true });
    await abrirPorAprobar();
    click(boton("Aprobar")!);
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0]![0])).toBe(`${BASE}/autopiloto/solicitudes/${GRANDE.id}/resolver`);
    expect(cuerpo()).toEqual({ decision: "aprobar" });
    expect(document.body.querySelector(`[data-testid="solicitud-${GRANDE.id}"]`)).toBeNull();
    expect(document.body.textContent).toContain("No hay nada por aprobar");
  });

  it("Rechazar exige elegir un motivo de la lista: sin motivo no escribe; con motivo manda {decision:'rechazar', motivo}", async () => {
    stub({ solicitudes: [GRANDE], disponible: true });
    await abrirPorAprobar();
    click(boton("Rechazar")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialogo.textContent).toContain("Rechazar el pedido grande");
    const confirmar = [...dialogo.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rechazar pedido") as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
    elegirValor(dialogo.querySelector("[role='combobox']") as HTMLElement, "fuera_de_zona");
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Rechazar pedido")!);
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(cuerpo()).toEqual({ decision: "rechazar", motivo: "fuera_de_zona" });
  });

  it("Cancelacion: Mantener el pedido manda mantener sin pedir motivo", async () => {
    stub({ solicitudes: [CANCELACION], disponible: true });
    await abrirPorAprobar();
    click(boton("Mantener el pedido")!);
    await esperar();
    expect(cuerpo()).toEqual({ decision: "mantener" });
  });

  // QA R2 caos-09: el panel dice lo que REALMENTE paso, no un "ya estaba resuelta" unico y enganoso.
  it("Cancelar un pedido que ya salio: la solicitud se cierra como mantener y el panel avisa que NO se pudo cancelar (no 'ya estaba resuelta')", async () => {
    const aviso = vi.spyOn(notify, "warning").mockImplementation(() => "t");
    const info = vi.spyOn(notify, "info").mockImplementation(() => "t");
    stub({ solicitudes: [CANCELACION], disponible: true, respuestaResolver: { aplicado: true, tipo: "cancelacion", decision: "mantener", estadoPedido: "en_camino", motivo: "no_cancelable_en_camino" } });
    await abrirPorAprobar();
    click(boton("Cancelar el pedido")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    elegirValor(dialogo.querySelector("[role='combobox']") as HTMLElement, "cliente_desistio");
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => /^Cancelar pedido$/.test(b.textContent?.trim() ?? ""))!);
    await esperar();
    expect(cuerpo()).toEqual({ decision: "cancelar", motivo: "cliente_desistio" });
    expect(aviso).toHaveBeenCalledWith(expect.stringMatching(/No se pudo cancelar: el pedido ya salió.*En camino/));
    expect(info).not.toHaveBeenCalled();
    aviso.mockRestore();
    info.mockRestore();
  });

  it("Aprobar un pedido grande que ya no estaba por aprobar explica el motivo en vez de 'ya estaba resuelta'", async () => {
    const aviso = vi.spyOn(notify, "warning").mockImplementation(() => "t");
    stub({ solicitudes: [GRANDE], disponible: true, respuestaResolver: { aplicado: false, estadoPedido: "cancelado", motivo: "pedido_ya_no_estaba_por_aprobar" } });
    await abrirPorAprobar();
    click(boton("Aprobar")!);
    await esperar();
    expect(aviso).toHaveBeenCalledWith(expect.stringMatching(/ya no estaba por aprobar.*Cancelado/));
    aviso.mockRestore();
  });

  it("Compensacion: Sin compensacion, Reponer producto (renglones elegidos) y Descuento (con el tope de la sucursal)", async () => {
    stub({ solicitudes: [COMPENSACION], disponible: true, config: { compensacionTopePct: 15 } });
    await abrirPorAprobar();
    click(boton("Reponer producto")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const reponer = [...dialogo.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reponer sin costo") as HTMLButtonElement;
    expect(reponer.disabled).toBe(true);
    const caja = [...dialogo.querySelectorAll("input[type=checkbox]")].find((i) => i.closest("label")?.textContent?.includes("Agua")) as HTMLInputElement;
    click(caja);
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Reponer sin costo")!);
    await esperar();
    expect(cuerpo()).toEqual({ decision: "reponer_producto", indices: [1] });
  });

  it("Descuento: las opciones respetan el tope y se manda el porcentaje elegido", async () => {
    stub({ solicitudes: [COMPENSACION], disponible: true, config: { compensacionTopePct: 15 } });
    await abrirPorAprobar();
    click(boton("Descuento en el próximo pedido")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const opciones = [...dialogo.querySelectorAll("option")].map((o) => o.value);
    expect(opciones).toEqual(["5", "10", "15"]);
    elegirValor(dialogo.querySelector("[role='combobox']") as HTMLElement, "15");
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Enviar código")!);
    await esperar();
    expect(cuerpo()).toEqual({ decision: "descuento_proximo", valor: 15 });
  });

  it("un error del servidor se muestra y la tarjeta sigue ahi (no se pierde la decision)", async () => {
    stub({ solicitudes: [GRANDE], disponible: true, fallaResolver: "Ya no esta por aprobar" });
    await abrirPorAprobar();
    click(boton("Aprobar")!);
    await esperar();
    expect(document.body.textContent).toContain("Ya no esta por aprobar");
    expect(document.body.querySelector(`[data-testid="solicitud-${GRANDE.id}"]`)).not.toBeNull();
  });

  it("base SIN migrar: estado honesto, sin botones", async () => {
    stub({ solicitudes: [], disponible: false });
    await abrirPorAprobar();
    expect(document.body.textContent).toContain("todavía no están disponibles en esta cuenta");
    expect(boton("Aprobar")).toBeUndefined();
  });

  it("sin nada pendiente: estado vacio que explica que llega ahi", async () => {
    stub({ solicitudes: [], disponible: true });
    await abrirPorAprobar();
    expect(document.body.textContent).toContain("No hay nada por aprobar");
    expect(document.body.querySelector('[data-testid="insignia-por-aprobar"]')).toBeNull();
  });
});

describe("Tiempo prometido hoy", () => {
  it("muestra el tiempo por canal (aprendido o fijo del dueno) y avisa la alta carga", async () => {
    stub({ solicitudes: [], disponible: true, saturado: true });
    rendered = renderComponent(<PedidosPage {...ctx("owner")} />);
    await esperar();
    const linea = document.body.querySelector('[data-testid="tiempo-prometido"]')!.textContent!;
    expect(linea).toContain("domicilio de 40 a 50 minutos");
    expect(linea).toContain("recoger Recoger 15-25 minutos");
    expect(linea).toContain("nunca menos que el tiempo que fijó el dueño");
    expect(linea).toContain("alta carga");
  });
});

describe("Historial del pedido", () => {
  const PEDIDO = { id: "ord-9", propertyId: "prop-1", branch: "Centro", customerId: null, customerName: "Juan Pérez", customerPhone: "5511112222", customerAddress: null, total: 120, status: "pending", canal: "recoger", items: [{ id: "i", name: "Tacos", price: 40, quantity: 3 }], source: "web", notes: null, paymentMethod: "efectivo", createdAt: "2026-10-04T12:00:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null };

  it("muestra quien movio el pedido, de que estado a cual, cuando y el motivo de la lista cerrada", async () => {
    stub({ solicitudes: [], disponible: true, pedidosPendientes: [PEDIDO] });
    rendered = renderComponent(<PedidosPage {...ctx("owner")} />);
    await esperar();
    click(boton("Historial")!);
    await esperar();
    const lista = document.body.querySelector('[data-testid="historial-pedido"]')!;
    expect(lista.textContent).toContain("Creado como Recibido");
    expect(lista.textContent).toContain("Agente");
    expect(lista.textContent).toContain("Recibido → Cancelado");
    expect(lista.textContent).toContain("Equipo");
    expect(lista.textContent).toContain("Sin producto");
  });

  it("base sin migrar: estado honesto", async () => {
    stub({ solicitudes: [], disponible: true, pedidosPendientes: [PEDIDO], historialDisponible: false });
    rendered = renderComponent(<PedidosPage {...ctx("owner")} />);
    await esperar();
    click(boton("Historial")!);
    await esperar();
    expect(document.body.textContent).toContain("El historial todavía no está disponible en esta cuenta");
  });
});

describe("Reglas del autopiloto", () => {
  it("solo owner/admin ven el boton; el staff de piso no", async () => {
    stub({ solicitudes: [], disponible: true });
    rendered = renderComponent(<PedidosPage {...ctx("staff")} />);
    await esperar();
    expect(boton("Reglas del autopiloto")).toBeUndefined();
    rendered.unmount();
    stub({ solicitudes: [], disponible: true });
    rendered = renderComponent(<PedidosPage {...ctx("admin")} />);
    await esperar();
    expect(boton("Reglas del autopiloto")).toBeDefined();
  });

  it("muestra los valores seguros por omision (cancelacion y aceptacion automaticas apagadas) y el estado honesto de plantillas y POS", async () => {
    stub({ solicitudes: [], disponible: true });
    rendered = renderComponent(<PedidosPage {...ctx("owner")} />);
    await esperar();
    click(boton("Reglas del autopiloto")!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const cajas = [...dialogo.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    expect(cajas).toHaveLength(3);
    expect(cajas.every((c) => !c.checked)).toBe(true);
    expect(dialogo.textContent).toContain("Plantillas de WhatsApp sin aprobar en Meta: pedido_aprobado");
    expect(dialogo.textContent).toContain("requiere la API de SoftRestaurant");
    expect(dialogo.textContent).toContain("Los pedidos grandes de WhatsApp y de voz llegan a «Por aprobar»");
  });

  it("valida rangos antes de llamar y guarda con PUT .../autopiloto/config", async () => {
    stub({ solicitudes: [], disponible: true });
    rendered = renderComponent(<PedidosPage {...ctx("owner")} />);
    await esperar();
    click(boton("Reglas del autopiloto")!);
    await esperar();
    const entradas = () => [...(document.body.querySelector('[role="dialog"]') as HTMLElement).querySelectorAll("input:not([type=checkbox])")] as HTMLInputElement[];
    changeValue(entradas()[0]!, "0");
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Guardar reglas"))!);
    await esperar();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
    expect((document.body.querySelector('[role="dialog"]') as HTMLElement).textContent).toContain("De 1 a 240 minutos.");
    changeValue(entradas()[0]!, "12");
    const cajas = [...(document.body.querySelector('[role="dialog"]') as HTMLElement).querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    click(cajas[1]!); // cancelacion automatica de la sucursal (la 0 es la regla de organizacion)
    await esperar();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Guardar reglas"))!);
    await esperar();
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toMatchObject({ cancelacionAgente: false, cancelacionAuto: true, aceptacionAuto: false, aprobacionMinutos: 12, handoffRegresoMinutos: 15 });
  });
});

describe("Productos: Agotado hasta manana", () => {
  const PRODUCTO = { id: "44444444-4444-4444-8444-444444444444", categoryId: null, categoryName: null, name: "Horchata", description: null, price: 30, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 1, searchKeywords: [], branch: { propertyId: "prop-1", productId: "44444444-4444-4444-8444-444444444444", price: 30, isAvailable: true } };

  it("el boton llama POST .../autopiloto/agotado con el producto y recarga el catalogo", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/admin/categories")) return json({ categories: [] });
      if (method === "GET" && url.includes("/admin/products")) return json({ products: [PRODUCTO] });
      if (url.includes("/no-domicilio")) return json({ productIds: [], categoryIds: [] });
      if (method === "POST" && url === `${BASE}/autopiloto/agotado`) return json({ ok: true, agotadoHasta: "2026-10-05", zonaHoraria: "America/Merida" });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ProductosPage {...ctx()} />);
    await esperar();
    click(boton("Agotado hasta mañana")!);
    await esperar();
    const llamada = fetchMock.mock.calls.find(([url]) => String(url) === `${BASE}/autopiloto/agotado`)!;
    expect(JSON.parse(String((llamada[1] as RequestInit).body))).toEqual({ productId: PRODUCTO.id });
  });
});
