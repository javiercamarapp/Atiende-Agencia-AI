// @vitest-environment jsdom
//
// Smoke tests reales de <PrivacidadPage /> (citas) y del panel de @atiende/ui:
// gate por rol, estado "no disponible aún" (base sin migrar) distinto del vacío,
// semáforo de plazos, y acciones del staff (rechazar exige motivo).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacidadPage } from "../src/verticals/citas/pages/Privacidad.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { accionesDisponibles } from "@atiende/ui";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function ctx(role: string): CitasShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role, staffFullName: "Sam", staffEmail: "sam@example.com" } as CitasShellContext;
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const ITEM = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  folio: "11111111",
  telefono: "+5219981234567",
  derecho: "acceso",
  canal: "whatsapp",
  estado: "recibida",
  detalle: null,
  solicitadaEn: "2026-09-30T15:00:00.000Z",
  confirmadaEn: "2026-09-30T15:05:00.000Z",
  respuestaVenceEn: "2026-10-20T15:05:00.000Z",
  ejecucionVenceEn: "2026-11-04T15:05:00.000Z",
  resueltaEn: null,
  notaResolucion: null,
  atendidaPor: null,
  plazo: "en_plazo",
  ...over,
});

function stub(page: { disponible?: boolean; items?: unknown[] }, onPatch?: (body: unknown) => Response) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.startsWith("https://api.test/v1/citas/properties/prop-1/admin/privacidad/solicitudes")) {
      const items = page.items ?? [];
      return jsonResponse({ disponible: page.disponible ?? true, total: items.length, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items });
    }
    if (init?.method === "PATCH") return onPatch ? onPatch(JSON.parse(String(init.body))) : jsonResponse({ id: "x", estado: "en_proceso" });
    throw new Error(`fetch no esperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("PrivacidadPage (citas)", () => {
  it("rol staff: no ve solicitudes y no hace ninguna llamada de red", async () => {
    stub({});
    rendered = renderComponent(<PrivacidadPage {...ctx("staff")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base sin migrar: muestra 'no disponible aún', no un vacío real", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Seguimiento ARCO no disponible aún");
    expect(rendered.container.textContent).not.toContain("Sin solicitudes");
  });

  it("lista vacía real: 'Sin solicitudes'", async () => {
    stub({ items: [] });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Sin solicitudes");
  });

  it("muestra folio, derecho, estado y el semáforo de vencimiento; cuenta abiertas/por vencer/vencidas", async () => {
    stub({ items: [ITEM(), ITEM({ id: "22222222-2222-2222-2222-222222222222", folio: "22222222", derecho: "cancelacion", plazo: "vencida" }), ITEM({ id: "33333333-3333-3333-3333-333333333333", folio: "33333333", plazo: "por_vencer" })] });
    rendered = renderComponent(<PrivacidadPage {...ctx("admin")} />);
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("11111111");
    expect(text).toContain("Cancelación");
    expect(text).toContain("Vencida");
    expect(text).toContain("Por vencer");
    expect(text).toContain("Abiertas");
  });

  it("rechazar exige motivo; con motivo manda PATCH y recarga la lista", async () => {
    const patches: unknown[] = [];
    stub({ items: [ITEM()] }, (body) => {
      patches.push(body);
      return jsonResponse({ id: "11111111-1111-1111-1111-111111111111", estado: "rechazada" });
    });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    const rechazar = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Rechazar")!;
    click(rechazar);
    const confirmar = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!;
    click(confirmar);
    await esperar();
    expect(rendered.container.textContent).toContain("Indica el motivo del rechazo.");
    expect(patches).toHaveLength(0);

    changeValue(rendered.container.querySelector("input[aria-label='Motivo del rechazo']") as HTMLInputElement, "no se verificó la identidad");
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!);
    await esperar();
    expect(patches).toEqual([{ estado: "rechazada", nota: "no se verificó la identidad" }]);
    // la lista se volvió a pedir tras el cambio (1 carga inicial + 1 recarga)
    const gets = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "PATCH");
    expect(gets.length).toBe(2);
  });

  it("un error del servidor al cambiar estado se muestra junto a la fila", async () => {
    stub({ items: [ITEM()] }, () => jsonResponse({ message: "Esa solicitud no puede pasar a ese estado desde su estado actual." }, false, 409));
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Resolver")!);
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!);
    await esperar();
    expect(rendered.container.querySelector("[role='alert']")?.textContent).toMatch(/no puede pasar|No se pudo/);
  });
});

describe("accionesDisponibles (espeja la función SQL)", () => {
  it("'bloquear datos' solo para cancelación", () => {
    expect(accionesDisponibles("recibida", "acceso")).not.toContain("bloqueada");
    expect(accionesDisponibles("recibida", "cancelacion")).toContain("bloqueada");
    expect(accionesDisponibles("en_proceso", "cancelacion")).toContain("bloqueada");
  });
  it("estados cerrados o sin confirmar no tienen acciones", () => {
    for (const e of ["pendiente_confirmacion", "resuelta", "rechazada", "cancelada_titular", "expirada"] as const) {
      expect(accionesDisponibles(e, "acceso")).toEqual([]);
    }
  });
});
