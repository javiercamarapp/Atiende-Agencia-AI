// @vitest-environment jsdom
//
// H-12 -- <ListaEsperaPanel /> y su integracion en <ReservasPage />: `fetch` global mockeado por ruta real contra
// apps/api/.../hoteles/lista-espera.ts. Cubre carga/vacio/error/base sin migrar, agregar (cuerpo real), ofrecer, aceptar con la
// cotizacion vigente (confirmacion + Idempotency-Key), cancelar con confirmacion (Volver nunca ejecuta), gating por rol, y en Reservas
// la pestana "Lista de espera" y el boton "Cambiar fechas".
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListaEsperaPanel } from "../src/verticals/hoteles/components/ListaEsperaPanel.tsx";
import { ReservasPage } from "../src/verticals/hoteles/pages/Reservas.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const entrada = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  tipoHabitacionId: "rt-1",
  entrada: "2026-12-03",
  salida: "2026-12-05",
  huespedes: 2,
  nombre: "Carla Mena",
  telefono: "5599998888",
  email: null,
  notas: null,
  estado: "activa",
  ofrecidaEn: null,
  ofertaVenceEn: null,
  reservaId: null,
  creadaEn: "2026-11-20T18:00:00.000Z",
  cotizacionVigente: null,
  ...over,
});

interface Stub {
  lista?: { disponible: boolean; entradas: unknown[] } | (() => { disponible: boolean; entradas: unknown[] });
  listaFalla?: boolean;
  post?: (url: string, body: unknown) => { status: number; body: unknown } | undefined;
  reservas?: unknown[];
}
function stub(s: Stub = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as unknown as Response;
    if (url.includes("/tipos-habitacion")) return json([{ id: "rt-1", nombre: "Doble", capacidadMaxima: 2 }]);
    if (method === "GET" && url.endsWith("/lista-espera")) {
      if (s.listaFalla) return json({ code: "internal", message: "Falla del servidor." }, 500);
      return json(typeof s.lista === "function" ? s.lista() : (s.lista ?? { disponible: true, entradas: [] }));
    }
    if (method === "GET" && /\/reservas$/.test(url)) return json(s.reservas ?? []);
    if (method === "POST" && url.includes("/lista-espera")) {
      const r = s.post?.(url, init?.body ? JSON.parse(init.body as string) : undefined);
      if (r) return json(r.body, r.status);
      return json(entrada());
    }
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const body = () => document.body;
const boton = (texto: string | RegExp) => [...body().querySelectorAll("button")].find((b) => (typeof texto === "string" ? b.textContent?.trim() === texto : texto.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
async function pulsar(b: HTMLButtonElement | undefined) {
  expect(b, "boton no encontrado").toBeDefined();
  await act(async () => {
    click(b!);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const montar = (role = "frontdesk") => {
  rendered = renderComponent(<ListaEsperaPanel apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" role={role} />);
};
const postsA = (fragmento: string) => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[0]).includes(fragmento));

describe("ListaEsperaPanel", () => {
  it("carga la cola con nombre, contacto, tipo, fechas y estado; el estado de carga se ve primero", async () => {
    stub({ lista: { disponible: true, entradas: [entrada()] } });
    montar();
    expect(rendered!.container.textContent).toContain("Cargando lista de espera");
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Carla Mena");
    expect(t).toContain("5599998888");
    expect(t).toContain("Doble");
    expect(t).toContain("En espera");
  });

  it("vacio explicito, error real con reintento y base sin migrar con aviso honesto (sin boton de agregar habilitado)", async () => {
    stub({ lista: { disponible: true, entradas: [] } });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("No hay nadie en la lista de espera.");
    rendered!.unmount();

    stub({ listaFalla: true });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("Falla del servidor.");
    rendered!.unmount();

    stub({ lista: { disponible: false, entradas: [] } });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("migración 041");
    expect(boton("Agregar a la lista")!.disabled).toBe(true);
  });

  it("agregar: arma POST /lista-espera con el cuerpo real y recarga la lista", async () => {
    let entradas: unknown[] = [];
    stub({ lista: () => ({ disponible: true, entradas }), post: () => { entradas = [entrada()]; return { status: 201, body: entrada() }; } });
    montar();
    await esperar();
    await pulsar(boton("Agregar a la lista"));
    changeValue(body().querySelector("#le-tipo") as HTMLSelectElement, "rt-1");
    changeValue(body().querySelector("#le-entrada") as HTMLInputElement, "2026-12-03");
    changeValue(body().querySelector("#le-salida") as HTMLInputElement, "2026-12-05");
    changeValue(body().querySelector("#le-huespedes") as HTMLInputElement, "2");
    changeValue(body().querySelector("#le-nombre") as HTMLInputElement, "Carla Mena");
    changeValue(body().querySelector("#le-telefono") as HTMLInputElement, "5599998888");
    await pulsar(boton("Agregar"));
    const [call] = postsA("/lista-espera");
    expect(JSON.parse(call![1].body as string)).toEqual({ roomTypeId: "rt-1", checkInDate: "2026-12-03", checkOutDate: "2026-12-05", huespedes: 2, nombre: "Carla Mena", telefono: "5599998888" });
    expect(rendered!.container.textContent).toContain("Carla Mena quedó en la lista de espera.");
  });

  it("agregar con un rechazo del servidor muestra el mensaje real dentro del dialogo y no lo cierra", async () => {
    stub({ post: () => ({ status: 400, body: { code: "validation_error", message: "Captura un telefono o un correo de contacto." } }) });
    montar();
    await esperar();
    await pulsar(boton("Agregar a la lista"));
    changeValue(body().querySelector("#le-tipo") as HTMLSelectElement, "rt-1");
    changeValue(body().querySelector("#le-entrada") as HTMLInputElement, "2026-12-03");
    changeValue(body().querySelector("#le-salida") as HTMLInputElement, "2026-12-05");
    changeValue(body().querySelector("#le-nombre") as HTMLInputElement, "Carla Mena");
    await pulsar(boton("Agregar"));
    expect(body().textContent).toContain("Captura un telefono o un correo de contacto.");
    expect(body().querySelector("#form-lista-espera")).not.toBeNull();
  });

  it("ofrecer lugar llama POST .../ofrecer y avisa; una entrada ofrecida muestra Aceptar con su cotizacion vigente", async () => {
    stub({ lista: { disponible: true, entradas: [entrada()] }, post: () => ({ status: 200, body: entrada({ estado: "ofrecida" }) }) });
    montar();
    await esperar();
    await pulsar(boton("Ofrecer lugar"));
    expect(postsA("/e1/ofrecer")).toHaveLength(1);
    expect(rendered!.container.textContent).toContain("Se ofreció lugar a Carla Mena");
    rendered!.unmount();

    stub({ lista: { disponible: true, entradas: [entrada({ estado: "ofrecida", ofertaVenceEn: "2026-11-21T18:00:00.000Z", cotizacionVigente: { total: 2380, noches: 2, moneda: "MXN" } })] } });
    montar();
    await esperar();
    expect(boton(/Aceptar/)!.textContent).toContain("$2,380.00");
    expect(rendered!.container.textContent).toContain("Vence");
  });

  it("aceptar: pide confirmacion (Volver no ejecuta); al confirmar manda totalEsperado e Idempotency-Key y avisa", async () => {
    const o = entrada({ estado: "ofrecida", ofertaVenceEn: "2026-11-21T18:00:00.000Z", cotizacionVigente: { total: 2380, noches: 2, moneda: "MXN" } });
    const onReserva = vi.fn();
    stub({ lista: { disponible: true, entradas: [o] }, post: () => ({ status: 201, body: { entrada: entrada({ estado: "aceptada" }), reserva: { id: "res-9", checkInDate: "2026-12-03", checkOutDate: "2026-12-05" } } }) });
    rendered = renderComponent(<ListaEsperaPanel apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" role="owner" onReservaCreada={onReserva} />);
    await esperar();
    await pulsar(boton(/Aceptar/));
    expect(body().textContent).toContain("$2,380.00");
    await pulsar(boton("Volver"));
    expect(postsA("/aceptar")).toHaveLength(0);
    await pulsar(boton(/Aceptar/));
    await pulsar(boton("Crear reserva"));
    const [call] = postsA("/e1/aceptar");
    expect(JSON.parse(call![1].body as string)).toEqual({ totalEsperado: 2380 });
    expect((call![1].headers as Record<string, string>)["idempotency-key"]).toMatch(/\S{8,}/);
    expect(onReserva).toHaveBeenCalledOnce();
    expect(rendered!.container.textContent).toContain("Reserva creada para Carla Mena.");
  });

  it("aceptar sin cotizacion vigente queda deshabilitado (no se puede enviar un total inventado)", async () => {
    stub({ lista: { disponible: true, entradas: [entrada({ estado: "ofrecida", ofertaVenceEn: "2026-11-21T18:00:00.000Z", cotizacionVigente: null })] } });
    montar();
    await esperar();
    expect(boton("Sin cotización")!.disabled).toBe(true);
  });

  it("cancelar entrada: confirmacion danger; Volver no ejecuta; Sí, cancelar llama POST .../cancelar", async () => {
    stub({ lista: { disponible: true, entradas: [entrada()] }, post: () => ({ status: 200, body: entrada({ estado: "cancelada" }) }) });
    montar();
    await esperar();
    await pulsar(boton("Cancelar"));
    await pulsar(boton("Volver"));
    expect(postsA("/cancelar")).toHaveLength(0);
    await pulsar(boton("Cancelar"));
    await pulsar(boton("Sí, cancelar entrada"));
    expect(postsA("/e1/cancelar")).toHaveLength(1);
    expect(rendered!.container.textContent).toContain("Carla Mena salió de la lista de espera.");
  });

  it("un rechazo del servidor al ofrecer (sin cupo) se muestra tal cual", async () => {
    stub({ lista: { disponible: true, entradas: [entrada()] }, post: () => ({ status: 409, body: { code: "sin_disponibilidad", message: "Aun no hay habitaciones libres en: 2026-12-03." } }) });
    montar();
    await esperar();
    await pulsar(boton("Ofrecer lugar"));
    expect(rendered!.container.textContent).toContain("Aun no hay habitaciones libres en: 2026-12-03.");
  });

  it("housekeeping no tiene acceso y no consulta al servidor", async () => {
    stub();
    montar("housekeeping");
    await esperar();
    expect(rendered!.container.textContent).toContain("Tu rol no tiene acceso a la lista de espera.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ReservasPage: pestana Lista de espera y boton Cambiar fechas", () => {
  const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "frontdesk", staffFullName: "Ana", staffEmail: "ana@example.com" };
  const reserva = (over: Record<string, unknown>) => ({ id: "res-1", propertyId: "prop-1", roomTypeId: "rt-1", guestId: null, checkInDate: "2026-12-03", checkOutDate: "2026-12-05", estado: "confirmada", montoTotal: 2000, penalizacionCancelacion: null, canceladaEn: null, creadaEn: "2026-11-01T10:00:00.000Z", roomId: null, ...over });
  const montarReservas = (ctx: HotelesShellContext = CTX) => {
    rendered = renderComponent(
      <MemoryRouter>
        <ReservasPage {...ctx} />
      </MemoryRouter>,
    );
  };
  function pestana(nombre: string) {
    const t = [...rendered!.container.querySelectorAll('[role="tab"]')].find((x) => x.textContent === nombre)!;
    act(() => {
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      (t as HTMLElement).focus();
    });
  }

  it("Cambiar fechas aparece solo en reservas modificables y abre el dialogo con las fechas reales", async () => {
    stub({ reservas: [reserva({}), reserva({ id: "res-2", estado: "cancelada" }), reserva({ id: "res-3", estado: "check_out" })] });
    montarReservas();
    await esperar();
    const botones = [...rendered!.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Cambiar fechas");
    expect(botones).toHaveLength(1);
    await pulsar(botones[0]);
    expect((body().querySelector("#cf-entrada") as HTMLInputElement).value).toBe("2026-12-03");
    expect((body().querySelector("#cf-salida") as HTMLInputElement).value).toBe("2026-12-05");
  });

  it("housekeeping no ve el boton Cambiar fechas (el servidor igual responde 403)", async () => {
    stub({ reservas: [reserva({})] });
    montarReservas({ ...CTX, role: "housekeeping" });
    await esperar();
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Cambiar fechas")).toBe(false);
  });

  it("la pestana Lista de espera muestra la cola real y 'Reservas' vuelve al listado", async () => {
    stub({ reservas: [reserva({})], lista: { disponible: true, entradas: [entrada()] } });
    montarReservas();
    await esperar();
    pestana("Lista de espera");
    await esperar();
    expect(rendered!.container.textContent).toContain("Carla Mena");
    expect(rendered!.container.textContent).not.toContain("Marcar Check-in");
    pestana("Reservas");
    await esperar();
    expect(rendered!.container.textContent).toContain("Marcar Check-in");
  });
});
