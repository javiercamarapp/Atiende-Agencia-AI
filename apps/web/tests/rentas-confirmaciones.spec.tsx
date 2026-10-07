// @vitest-environment jsdom
//
// PR-7 de diseno-ux (rentas): las acciones destructivas pasan al <ConfirmDialog> de @atiende/ui. Se afirma, para cada una,
// la leccion de PR-5/6/8: DESCARTAR un dialogo (Cancelar, "No, mantenerla", Escape) NUNCA ejecuta la accion; solo el boton de
// confirmar llama al servidor, y si el servidor falla el dialogo queda abierto.
//   - Aprobaciones: rechazar un borrador (motivo obligatorio, POST .../rechazar).
//   - Calendario: cancelar una reserva (POST .../reservas/:id/cancelar).
//   - Sincronizacion iCal: desconectar un canal (DELETE .../canales/:canal/ical-sync), confirmacion NUEVA en este PR.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AprobacionesPage } from "../src/verticals/rentas/pages/Aprobaciones.tsx";
import { CalendarioPage } from "../src/verticals/rentas/pages/Calendario.tsx";
import { IcalSyncPage } from "../src/verticals/rentas/pages/IcalSync.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: RentasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  setPropertyId: () => {},
  properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
  orgSlug: "demo",
  session: { token: "tok-123", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol: "admin_gestora" }] },
};

const res = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;
const UNIDAD = { id: "u1", name: "Depa 101", nombre: "Depa 101" };

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const mutaciones = () => fetchMock.mock.calls.filter(([, init]) => ["POST", "DELETE", "PATCH"].includes((init as RequestInit | undefined)?.method ?? "GET"));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const botonPagina = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;

describe("Aprobaciones — rechazar un borrador", () => {
  const BORRADOR = {
    id: "b1", conversacionId: "c1", mensajeEntranteId: null, canal: "airbnb", texto: "Hola, la clave es 1234", estado: "pendiente_aprobacion", generadoPor: "agente_llm", redactado: true,
    aprobadoPor: null, aprobadoEn: null, rechazadoPor: null, rechazadoEn: null, motivoRechazo: null, mensajeEnviadoId: null, creadoEn: "2026-10-01T10:00:00Z", actualizadoEn: "2026-10-01T10:00:00Z",
  };
  const CONVERSACION = { id: "c1", organizationId: "org-1", propertyId: "prop-1", unidadId: "u1", canal: "airbnb", ocupacionId: null, huespedMinimoId: null, propiedadNombre: "Depa Marina", huespedNombre: "Ana", fechaCheckIn: null, fechaCheckOut: null, reservaConfirmada: false, creadoEn: "2026-10-01T09:00:00Z" };

  function stub(rechazar: () => Response) {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/borradores/b1/rechazar")) return rechazar();
      if (url.endsWith("/mensajeria/politicas")) return res({ politicas: [] });
      if (url.endsWith("/unidades")) return res({ unidades: [UNIDAD] });
      if (url.endsWith("/unidades/u1/conversaciones")) return res({ conversaciones: [CONVERSACION] });
      if (url.endsWith("/conversaciones/c1/borradores")) return res({ borradores: [BORRADOR] });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  async function abrir(): Promise<RenderedComponent> {
    const r = renderComponent(
      <MemoryRouter>
        <AprobacionesPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    click(botonPagina(r, "Rechazar"));
    await esperar();
    return r;
  }

  it("el primer clic solo abre el dialogo y el motivo es obligatorio", async () => {
    stub(() => res({}));
    rendered = await abrir();
    expect(dialogo()).not.toBeNull();
    expect(mutaciones()).toHaveLength(0);
    expect(botonDialogo("Confirmar rechazo").disabled).toBe(true);
  });

  it("Cancelar no rechaza nada", async () => {
    stub(() => res({}));
    rendered = await abrir();
    changeValue(dialogo()!.querySelector("textarea")!, "No aplica");
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("confirmar manda POST .../rechazar con el motivo", async () => {
    stub(() => res({ ...BORRADOR, estado: "rechazado" }));
    rendered = await abrir();
    changeValue(dialogo()!.querySelector("textarea")!, "El dato es incorrecto");
    await act(async () => {
      click(botonDialogo("Confirmar rechazo"));
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    const [url, init] = mutaciones()[0]!;
    expect(String(url)).toContain("/rentas/prop-1/borradores/b1/rechazar");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ motivo: "El dato es incorrecto" });
  });

  it("si el servidor rechaza, el dialogo sigue abierto con el motivo escrito", async () => {
    stub(() => res({ error: "Borrador ya decidido" }, false));
    rendered = await abrir();
    changeValue(dialogo()!.querySelector("textarea")!, "Motivo escrito");
    await act(async () => {
      click(botonDialogo("Confirmar rechazo"));
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
    expect((dialogo()!.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Motivo escrito");
  });
});

describe("Calendario — cancelar una reserva", () => {
  const RESERVA = { id: "o1", unidadId: "u1", capa: "reserva", rango: { inicio: "2026-11-01", fin: "2026-11-05" }, razon: "RESERVA_DIRECTA", estado: "confirmado", canalCodigo: null, huespedNombre: "Ana", huespedContacto: null, createdAt: "2026-10-01T10:00:00Z" };

  function stub() {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/reservas/o1/cancelar")) return res({ id: "o1", estado: "cancelado", estadoAnterior: "confirmado" });
      if (url.endsWith("/unidades")) return res({ unidades: [UNIDAD] });
      if (url.includes("/calendario?")) return res({ zona_horaria: "America/Cancun", hoy: "2026-11-01", total: 0, truncado: false, ocupaciones: [] });
      if (url.includes("/tareas?")) return res({ tareas: [] });
      if (url.includes("/conflictos?")) return res({ zona_horaria: "America/Cancun", conflictos: [], total_abiertos: 0 });
      if (url.endsWith("/unidades/u1/ocupaciones")) return res({ ocupaciones: [RESERVA] });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  async function abrir(): Promise<RenderedComponent> {
    stub();
    const r = renderComponent(<CalendarioPage {...CTX} />);
    await esperar();
    // Rn-06: la página abre en el calendario visual; la gestión (cancelar) vive en la pestaña "Lista".
    click(botonPagina(r, "Lista"));
    await esperar();
    click(botonPagina(r, "Cancelar reserva"));
    await esperar();
    return r;
  }

  it("el primer clic solo abre el dialogo, que nombra la unidad y las fechas", async () => {
    rendered = await abrir();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Depa 101");
    expect(dialogo()!.textContent).toContain("2026-11-01 → 2026-11-05");
    expect(mutaciones()).toHaveLength(0);
  });

  it('"No, mantenerla" no cancela nada', async () => {
    rendered = await abrir();
    await act(async () => {
      click(botonDialogo("No, mantenerla"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("confirmar manda POST .../reservas/:id/cancelar", async () => {
    rendered = await abrir();
    await act(async () => {
      click(botonDialogo("Sí, cancelar reserva"));
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    expect(String(mutaciones()[0]![0])).toContain("/rentas/prop-1/unidades/u1/reservas/o1/cancelar");
  });
});

describe("Sincronizacion iCal — desconectar un canal", () => {
  const FEED = {
    id: "f1", canal: "airbnb", url_importacion: "https://www.airbnb.com/calendar/ical/1.ics", activo: true, ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: null,
    intentos_fallidos_consecutivos: 0, motivo_cuarentena: null, drift_ultima_reconciliacion_completa: 0, ultimo_resumen: null,
  };

  function stub(desconectar: () => Response) {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE" && url.endsWith("/canales/airbnb/ical-sync")) return desconectar();
      if (url.endsWith("/unidades")) return res({ unidades: [UNIDAD] });
      if (url.endsWith("/unidades/u1/ical-sync")) return res({ feeds: [FEED] });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  async function abrir(): Promise<RenderedComponent> {
    const r = renderComponent(<IcalSyncPage {...CTX} />);
    await esperar();
    click(botonPagina(r, "Desconectar"));
    await esperar();
    return r;
  }

  it("el primer clic solo abre el dialogo con el nombre del canal", async () => {
    stub(() => res({}));
    rendered = await abrir();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Airbnb");
    expect(mutaciones()).toHaveLength(0);
  });

  it("Cancelar no desconecta nada", async () => {
    stub(() => res({}));
    rendered = await abrir();
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(dialogo()).toBeNull();
  });

  it("confirmar manda DELETE .../canales/airbnb/ical-sync", async () => {
    stub(() => res({ desconectado: true }));
    rendered = await abrir();
    await act(async () => {
      click(botonDialogo("Sí, desconectar"));
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    expect(String(mutaciones()[0]![0])).toContain("/rentas/prop-1/unidades/u1/canales/airbnb/ical-sync");
  });
});
