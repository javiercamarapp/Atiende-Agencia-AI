// @vitest-environment jsdom
//
// PR-5 de diseno-ux (restaurantes): las dos confirmaciones destructivas que seguian en
// `window.confirm` (baja de staff en Staff.tsx, quitar zona en Configuracion.tsx) pasan al
// <ConfirmDialog> de @atiende/ui via `useConfirm`. UNI-C suma "cancelar pedido" (Pedidos.tsx) y "reportar
// incidencia" (Repartidor.tsx, con `pedirTexto`), que eran un AlertDialog local. Se afirma que:
//   - `window.confirm` NUNCA se llama;
//   - Cancelar/cerrar NO ejecuta el DELETE;
//   - Confirmar si lo ejecuta, con el nombre del objeto en el titulo del dialogo.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StaffPage } from "../src/verticals/restaurantes/pages/Staff.tsx";
import { ConfiguracionPage } from "../src/verticals/restaurantes/pages/Configuracion.tsx";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import { RepartidorPedidosView } from "../src/verticals/restaurantes/pages/Repartidor.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function ctx(role = "owner"): RestaurantesShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam Demo", staffEmail: "sam@example.com" };
}

const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

function stubFetch(extra: (method: string, url: string) => Response | null) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const propia = extra(method, url);
    if (propia) return propia;
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

function dialogo(): HTMLElement | null {
  return document.body.querySelector('[role="alertdialog"]');
}

async function pulsarEnDialogo(texto: string): Promise<void> {
  const boton = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  await act(async () => {
    boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");

describe("Staff (restaurantes) — baja con ConfirmDialog", () => {
  const MIEMBRO = { id: "user-1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "staff", propertyIds: null };

  function stubStaff() {
    stubFetch((method, url) => {
      if (method === "GET" && url === `${BASE}/staff/repartidores`) return jsonResponse({ repartidores: [] });
      if (method === "GET" && url === `${BASE}/staff/invitaciones`) return jsonResponse({ invitations: [] });
      if (method === "GET" && url === `${BASE}/staff/miembros`) return jsonResponse({ miembros: [MIEMBRO] });
      if (method === "DELETE" && url === `${BASE}/staff/miembros/user-1`) return jsonResponse({ ok: true });
      return null;
    });
  }

  async function abrirBaja(): Promise<void> {
    stubStaff();
    rendered = renderComponent(
      <MemoryRouter>
        <StaffPage {...ctx()} />
      </MemoryRouter>,
    );
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Dar de baja")!;
    click(boton);
    await esperar();
  }

  it("abre un alertdialog con el nombre del miembro y nunca usa window.confirm", async () => {
    await abrirBaja();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Dar de baja a Ana Pérez");
    expect(dialogo()!.textContent).toContain("Pierde acceso a esta organización de inmediato.");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });

  it("Cancelar no ejecuta el DELETE", async () => {
    await abrirBaja();
    await pulsarEnDialogo("Cancelar");
    expect(deletes()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Ana Pérez");
  });

  it("Confirmar ejecuta DELETE .../staff/miembros/:id y quita al miembro de la lista", async () => {
    await abrirBaja();
    await pulsarEnDialogo("Dar de baja");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]![0]).toBe(`${BASE}/staff/miembros/user-1`);
    expect(rendered!.container.textContent).not.toContain("ana@example.com");
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("Configuracion (restaurantes) — quitar zona con ConfirmDialog", () => {
  const ZONA = { id: "zona-1", name: "Altabrisa", lat: 21.0619, lng: -89.6216 };

  function stubConfig() {
    stubFetch((method, url) => {
      if (method === "GET" && url === `${BASE}/config/whatsapp`) return jsonResponse({ phoneNumberId: "123" });
      if (method === "GET" && url === `${BASE}/config/zonas`) return jsonResponse({ zonas: [ZONA] });
      if (method === "GET" && url === `${BASE}/config/zona-horaria`) return jsonResponse({ zonaHoraria: null });
      if (method === "DELETE" && url === `${BASE}/config/zonas/zona-1`) return jsonResponse({ ok: true });
      // AgenteWhatsappSeccion (hija de esta pagina) hace sus propias lecturas: no son parte de este test.
      if (method === "GET") return jsonResponse({}, false);
      return null;
    });
  }

  async function abrirQuitar(): Promise<void> {
    stubConfig();
    rendered = renderComponent(
      <MemoryRouter>
        <ConfiguracionPage {...ctx()} />
      </MemoryRouter>,
    );
    await esperar();
    click(rendered.container.querySelector('button[aria-label="Quitar zona Altabrisa"]')!);
    await esperar();
  }

  it("el boton de solo icono tiene nombre accesible y abre el dialogo con el nombre de la zona", async () => {
    await abrirQuitar();
    expect(dialogo()!.textContent).toContain('Quitar "Altabrisa" de las zonas conocidas');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });

  it("Cancelar no ejecuta el DELETE", async () => {
    await abrirQuitar();
    await pulsarEnDialogo("Cancelar");
    expect(deletes()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Altabrisa");
  });

  it("Confirmar ejecuta DELETE .../config/zonas/:id y la zona desaparece", async () => {
    await abrirQuitar();
    await pulsarEnDialogo("Quitar zona");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]![0]).toBe(`${BASE}/config/zonas/zona-1`);
    expect(rendered!.container.querySelector('button[aria-label="Quitar zona Altabrisa"]')).toBeNull();
  });
});


describe("Pedidos (restaurantes) — cancelar pedido con motivo de la lista cerrada", () => {
  const PEDIDO = {
    id: "ord-1",
    propertyId: "prop-1",
    branch: "Centro",
    customerId: "cust-1",
    customerName: "Juan Pérez",
    customerPhone: "5511112222",
    customerAddress: "Calle Falsa 123",
    total: 345.5,
    status: "pending",
    canal: "domicilio",
    items: [{ id: "it-1", name: "Tacos al pastor", price: 115, quantity: 3 }],
    source: "web",
    notes: null,
    paymentMethod: "efectivo",
    createdAt: "2026-09-19T10:00:00.000Z",
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
  };

  const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/status") && (init as RequestInit | undefined)?.method === "PATCH");
  /** El motivo se pide en un dialogo de formulario (role=dialog), no en un alertdialog: la cancelacion exige una opcion de la lista cerrada. */
  const dialogoMotivo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;

  async function abrirCancelar(): Promise<void> {
    stubFetch((method, url) => {
      if (url.includes("/admin/staff/repartidores")) return jsonResponse({ repartidores: [] });
      if (method === "GET" && url.includes("/admin/orders")) {
        const estado = new URL(url).searchParams.get("status") ?? "";
        return jsonResponse({ orders: estado === "pending" ? [PEDIDO] : [], nextCursor: null });
      }
      if (method === "PATCH" && url.endsWith("/status")) return jsonResponse({ order: { ...PEDIDO, status: "cancelado" } });
      return null;
    });
    rendered = renderComponent(<PedidosPage {...ctx()} />);
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar Cancelado"))!;
    click(boton);
    await esperar();
  }

  async function pulsar(texto: string): Promise<void> {
    const boton = [...dialogoMotivo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
    await act(async () => {
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
  }

  it("abre el dialogo con el nombre del cliente, sin window.confirm ni escritura", async () => {
    await abrirCancelar();
    expect(dialogoMotivo()).not.toBeNull();
    expect(dialogoMotivo()!.textContent).toContain("¿Cancelar el pedido de Juan Pérez?");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(0);
  });

  it("Volver no llama al API y el pedido sigue en la lista", async () => {
    await abrirCancelar();
    await pulsar("Volver");
    expect(patches()).toHaveLength(0);
    expect(dialogoMotivo()).toBeNull();
    expect(rendered!.container.textContent).toContain("Juan Pérez");
  });

  it("Escape tampoco llama al API", async () => {
    await abrirCancelar();
    await act(async () => {
      keydown(dialogoMotivo()!, "Escape");
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(patches()).toHaveLength(0);
    expect(dialogoMotivo()).toBeNull();
  });

  it("sin elegir motivo el boton de cancelar esta deshabilitado y no escribe", async () => {
    await abrirCancelar();
    const confirmar = [...dialogoMotivo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar el pedido") as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    await pulsar("Cancelar el pedido");
    expect(patches()).toHaveLength(0);
  });

  it("con un motivo de la lista manda PATCH .../status con {status:'cancelado', motivo}", async () => {
    await abrirCancelar();
    elegirValor(dialogoMotivo()!.querySelector("[role='combobox']") as HTMLElement, "sin_producto");
    await esperar();
    await pulsar("Cancelar el pedido");
    expect(patches()).toHaveLength(1);
    expect(JSON.parse((patches()[0]![1] as RequestInit).body as string)).toEqual({ status: "cancelado", motivo: "sin_producto" });
  });
});

describe("Repartidor (restaurantes) — reportar incidencia con useConfirm().pedirTexto", () => {
  const ENTREGA = {
    id: "ord-9",
    propertyId: "prop-1",
    customerName: "Lucía Xool",
    customerPhone: "9991112222",
    customerAddress: "Calle 60 #100",
    total: 210,
    status: "en_camino",
    items: [{ id: "it-1", name: "Cochinita", price: 70, quantity: 3 }],
    createdAt: "2026-09-19T10:00:00.000Z",
    incidentNote: null,
  };

  const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/repartidor/orders/ord-9/status") && (init as RequestInit | undefined)?.method === "PATCH");

  async function abrirIncidencia(): Promise<void> {
    stubFetch((method, url) => {
      if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/repartidor/orders") return jsonResponse({ orders: [ENTREGA] });
      if (method === "PATCH" && url.endsWith("/repartidor/orders/ord-9/status")) return jsonResponse({ order: { ...ENTREGA, status: "problema", incidentNote: "no abrió" } });
      return null;
    });
    rendered = renderComponent(<RepartidorPedidosView apiBaseUrl="https://api.test" token="tok-123" propertyId="prop-1" />);
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reportar incidencia"))!;
    click(boton);
    await esperar();
  }

  it("el dialogo pide una nota obligatoria: sin texto el boton Reportar queda deshabilitado y no hay PATCH", async () => {
    await abrirIncidencia();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Nota para administración");
    const reportar = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reportar incidencia") as HTMLButtonElement;
    expect(reportar.disabled).toBe(true);
    expect(patches()).toHaveLength(0);
  });

  it("Volver no llama al API", async () => {
    await abrirIncidencia();
    await pulsarEnDialogo("Volver");
    expect(patches()).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("Escape no llama al API", async () => {
    await abrirIncidencia();
    await act(async () => {
      keydown(dialogo()!, "Escape");
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(patches()).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("con nota manda PATCH .../repartidor/orders/:id/status con {status:'problema', incidentNote} recortada", async () => {
    await abrirIncidencia();
    const campo = dialogo()!.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      changeValue(campo, "  no abrió y no contesta  ");
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Reportar incidencia");
    expect(patches()).toHaveLength(1);
    expect(JSON.parse((patches()[0]![1] as RequestInit).body as string)).toEqual({ status: "problema", incidentNote: "no abrió y no contesta" });
  });
});
