// @vitest-environment jsdom
//
// Smoke tests reales de <PrivacidadPage /> de restaurantes: gate por rol, estado "no disponible aun"
// (base sin migrar) distinto del vacio, aviso de verificacion de identidad en llamadas, acciones del
// staff y el formulario de configuracion (aviso, retencion, consentimiento de grabacion).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacidadPage } from "../src/verticals/restaurantes/pages/Privacidad.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
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

function ctx(role: string): RestaurantesShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam", staffEmail: "sam@example.com" } as RestaurantesShellContext;
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
  identidadVerificadaPor: "whatsapp_numero",
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

const CONFIG = { responsable: null, avisoUrl: null, avisoVersion: "v1", retencionConversacionesDias: 180, retencionVozDias: 30, exigirConsentimientoGrabacion: true, configurada: false };

function stub(page: { disponible?: boolean; items?: unknown[] }, opts: { onPatch?: (body: unknown) => Response; onPut?: (body: unknown) => Response } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("https://api.test/v1/restaurantes/prop-1/admin/privacidad/solicitudes")) {
      const items = page.items ?? [];
      return jsonResponse({ disponible: page.disponible ?? true, total: items.length, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items });
    }
    if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/admin/privacidad/configuracion") return jsonResponse({ configuracion: CONFIG, porDefecto: CONFIG });
    if (method === "PATCH") return opts.onPatch ? opts.onPatch(JSON.parse(String(init?.body))) : jsonResponse({ id: "x", estado: "en_proceso" });
    if (method === "PUT") return opts.onPut ? opts.onPut(JSON.parse(String(init?.body))) : jsonResponse({ configuracion: { ...CONFIG, configurada: true } });
    throw new Error(`fetch no esperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("PrivacidadPage (restaurantes)", () => {
  it("rol staff: no ve solicitudes ni configuracion y no hace ninguna llamada de red", async () => {
    stub({});
    rendered = renderComponent(<PrivacidadPage {...ctx("staff")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base sin migrar: muestra 'no disponible aun', no un vacio real", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Seguimiento ARCO no disponible aún");
    expect(rendered.container.textContent).not.toContain("Sin solicitudes");
  });

  it("lista vacia real: 'Sin solicitudes'", async () => {
    stub({ items: [] });
    rendered = renderComponent(<PrivacidadPage {...ctx("admin")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Sin solicitudes");
  });

  it("muestra folio, derecho, semaforo de vencimiento y advierte que una llamada debe verificarse por otra via", async () => {
    stub({
      items: [
        ITEM(),
        ITEM({ id: "22222222-2222-2222-2222-222222222222", folio: "22222222", derecho: "cancelacion", plazo: "vencida", canal: "voice", identidadVerificadaPor: "llamada_identificador" }),
        ITEM({ id: "33333333-3333-3333-3333-333333333333", folio: "33333333", plazo: "por_vencer" }),
      ],
    });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("11111111");
    expect(text).toContain("Cancelación");
    expect(text).toContain("Vencida");
    expect(text).toContain("Por vencer");
    // solo la solicitud por llamada lleva la advertencia
    expect(text.match(/Llamada: verifica identidad por otra vía/g)).toHaveLength(1);
  });

  it("rechazar exige motivo; con motivo manda PATCH al endpoint de restaurantes y recarga la lista", async () => {
    const patches: unknown[] = [];
    stub(
      { items: [ITEM()] },
      {
        onPatch: (body) => {
          patches.push(body);
          return jsonResponse({ id: "11111111-1111-1111-1111-111111111111", estado: "rechazada" });
        },
      },
    );
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Rechazar")!);
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!);
    await esperar();
    expect(rendered.container.textContent).toContain("Indica el motivo del rechazo.");
    expect(patches).toHaveLength(0);

    changeValue(rendered.container.querySelector("input[aria-label='Motivo del rechazo']") as HTMLInputElement, "no se verificó la identidad");
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!);
    await esperar();
    expect(patches).toEqual([{ estado: "rechazada", nota: "no se verificó la identidad" }]);
    const patchCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")!;
    expect(patchCall[0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/privacidad/solicitudes/11111111-1111-1111-1111-111111111111/estado");
    const listGets = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "PATCH" && String(c[0]).includes("/solicitudes"));
    expect(listGets.length).toBe(2);
  });

  it("un error del servidor al cambiar estado se muestra junto a la fila", async () => {
    stub({ items: [ITEM()] }, { onPatch: () => jsonResponse({ message: "Esa solicitud no puede pasar a ese estado desde su estado actual." }, false, 409) });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Resolver")!);
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Confirmar"))!);
    await esperar();
    expect(rendered.container.querySelector("[role='alert']")?.textContent).toMatch(/no puede pasar|No se pudo/);
  });
});

describe("configuracion de privacidad (restaurantes)", () => {
  it("sin configuracion guardada muestra los valores por defecto y lo dice", async () => {
    stub({ items: [] });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Todavía no guardas esta configuración");
    const inputs = Array.from(rendered.container.querySelectorAll("input[type='number']")) as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(["180", "30"]);
    expect((rendered.container.querySelector("input[type='checkbox']") as HTMLInputElement).checked).toBe(true);
  });

  it("guardar manda PUT con los dias como numeros y deja de decir 'todavia no guardas'", async () => {
    const puts: unknown[] = [];
    stub(
      { items: [] },
      {
        onPut: (body) => {
          puts.push(body);
          return jsonResponse({ configuracion: { ...(body as object), configurada: true } });
        },
      },
    );
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    const [conv, voz] = Array.from(rendered.container.querySelectorAll("input[type='number']")) as HTMLInputElement[];
    changeValue(conv!, "90");
    changeValue(voz!, "0");
    changeValue(rendered.container.querySelector("input[placeholder^='https://']") as HTMLInputElement, "https://ejemplo.mx/aviso");
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Guardar configuración")!);
    await esperar();
    expect(puts).toEqual([
      { responsable: null, avisoUrl: "https://ejemplo.mx/aviso", avisoVersion: "v1", retencionConversacionesDias: 90, retencionVozDias: 0, exigirConsentimientoGrabacion: true },
    ]);
    expect(rendered.container.textContent).toContain("Configuración guardada.");
    expect(rendered.container.textContent).not.toContain("Todavía no guardas esta configuración");
  });

  it("base sin migrar: el error 503 del servidor se muestra y no se afirma 'guardada'", async () => {
    stub({ items: [] }, { onPut: () => jsonResponse({ message: "La configuración de privacidad todavía no está disponible en este ambiente (migración pendiente)." }, false, 503) });
    rendered = renderComponent(<PrivacidadPage {...ctx("owner")} />);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Guardar configuración")!);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Configuración guardada.");
    expect(rendered.container.querySelector("[role='alert']")?.textContent).toMatch(/migración pendiente|No se pudo/);
  });
});
