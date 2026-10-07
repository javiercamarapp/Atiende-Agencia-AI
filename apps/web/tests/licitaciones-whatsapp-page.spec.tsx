// @vitest-environment jsdom
//
// L-05 -- pantalla de configuracion de WhatsApp de licitaciones. `fetch` global mockeado por ruta
// real: se verifica lo que se ve (estado del consentimiento, honestidad con la base sin migrar o sin
// numero remitente), que cada accion dispare metodo/ruta/cuerpo reales y que el rol oculte lo que el
// servidor rechazaria.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsappPage } from "../src/verticals/licitaciones/pages/Whatsapp.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "analyst", staffFullName: "Ana", staffEmail: "ana@example.com" };
const ROLE = (role: string): LicitacionesShellContext => ({ ...CTX, role });

type Handler = (init?: RequestInit) => { ok?: boolean; status?: number; body: unknown };

function stubFetch(routes: Record<string, Handler>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.test/licitaciones/prop-1", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), headers: new Headers(), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;

function mount(ctx: LicitacionesShellContext) {
  rendered = renderComponent(<WhatsappPage {...ctx} />);
}

const text = () => rendered!.container.textContent ?? "";
const buttonByText = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
const field = (label: string) => rendered!.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
const calls = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).replace("https://api.test/licitaciones/prop-1", "")}` === `${method} ${path}`);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const CONTACT = (status: string, over: Record<string, unknown> = {}) => ({ phoneE164: "+5215512345678", status, notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true, ...over });
const SETTINGS = (over: Record<string, unknown> = {}) => ({ available: true, configured: true, contact: null, events: [], ...over });
const TENDERS = { tenders: [{ id: "t1", title: "Suministro de papeleria", submissionDeadline: null }] };

describe("pantalla de WhatsApp de licitaciones", () => {
  it("base sin migrar: lo dice y no ofrece formulario", async () => {
    stubFetch({ "GET /whatsapp/settings": () => ({ body: SETTINGS({ available: false }) }), "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }) });
    mount(CTX);
    await settle();
    expect(text()).toContain("Aún no disponible");
    expect(field("Teléfono de WhatsApp")).toBeNull();
  });

  it("sin numero remitente configurado: avisa que no llegaran mensajes", async () => {
    stubFetch({ "GET /whatsapp/settings": () => ({ body: SETTINGS({ configured: false }) }), "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }) });
    mount(CTX);
    await settle();
    expect(text()).toContain("Número de WhatsApp sin configurar");
  });

  it("guarda el telefono con los temas elegidos y pide contestar SI (nunca marca activo por su cuenta)", async () => {
    stubFetch({
      "GET /whatsapp/settings": () => ({ body: SETTINGS() }),
      "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }),
      "PUT /whatsapp/settings": () => ({ body: { configured: true, contact: CONTACT("pendiente") } }),
    });
    mount(CTX);
    await settle();
    await act(async () => {
      changeValue(field("Teléfono de WhatsApp") as HTMLInputElement, "+52 1 55 1234 5678");
    });
    const form = field("Teléfono de WhatsApp").closest("form")!;
    await act(async () => {
      await submitForm(form);
    });
    await settle();
    const [put] = calls("PUT", "/whatsapp/settings");
    expect(bodyOf(put!)).toEqual({ phone: "+52 1 55 1234 5678", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: true });
    expect(text()).toContain("Pendiente de confirmar");
    expect(text()).toContain("contesta SI");
  });

  it("con WhatsApp activo ofrece salir; el boton llama a opt-out y recarga", async () => {
    let status = "activo";
    stubFetch({
      "GET /whatsapp/settings": () => ({ body: SETTINGS({ contact: CONTACT(status) }) }),
      "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }),
      "POST /whatsapp/opt-out": () => {
        status = "baja";
        return { body: { ok: true, changed: true } };
      },
    });
    mount(CTX);
    await settle();
    expect(text()).toContain("Activo");
    await act(async () => {
      click(buttonByText("Dejar de recibir avisos")!);
    });
    await settle();
    // Salir es destructivo: primero pide confirmación y no llama al servidor.
    expect(dialogo()).not.toBeNull();
    expect(calls("POST", "/whatsapp/opt-out")).toHaveLength(0);
    await act(async () => {
      click(botonDialogo("Dejar de recibir avisos"));
    });
    await settle();
    expect(calls("POST", "/whatsapp/opt-out")).toHaveLength(1);
    expect(text()).toContain("Dado de baja");
    expect(buttonByText("Dejar de recibir avisos")).toBeUndefined();
  });

  it("Cancelar el diálogo de salida NUNCA llama a opt-out", async () => {
    stubFetch({
      "GET /whatsapp/settings": () => ({ body: SETTINGS({ contact: CONTACT("activo") }) }),
      "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }),
      "POST /whatsapp/opt-out": () => ({ body: { ok: true, changed: true } }),
    });
    mount(CTX);
    await settle();
    await act(async () => {
      click(buttonByText("Dejar de recibir avisos")!);
    });
    await settle();
    expect(dialogo()).not.toBeNull();
    await act(async () => {
      click(botonDialogo("Cancelar"));
    });
    await settle();
    expect(dialogo()).toBeNull();
    expect(calls("POST", "/whatsapp/opt-out")).toHaveLength(0);
    expect(text()).toContain("Activo");
  });

  it("quien puede decidir pide la decision de una convocatoria y ve el resultado", async () => {
    stubFetch({
      "GET /whatsapp/settings": () => ({ body: SETTINGS({ contact: CONTACT("activo") }) }),
      "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }),
      "POST /tenders/t1/whatsapp/request-decision": () => ({ body: { requested: 2, alreadyPending: 0, eligible: 2 } }),
    });
    mount(CTX);
    await settle();
    await act(async () => {
      changeValue(field("Convocatoria") as HTMLSelectElement, "t1");
    });
    await act(async () => {
      await submitForm(field("Convocatoria").closest("form")!);
    });
    await settle();
    expect(calls("POST", "/tenders/t1/whatsapp/request-decision")).toHaveLength(1);
    expect(text()).toContain("Solicitud enviada a 2 persona(s).");
  });

  it("un viewer no ve la tarjeta de decisiones ni el tema de decisiones (y no consulta convocatorias)", async () => {
    stubFetch({ "GET /whatsapp/settings": () => ({ body: SETTINGS({ contact: CONTACT("activo") }) }) });
    mount(ROLE("viewer"));
    await settle();
    expect(text()).not.toContain("Pedir una decisión por WhatsApp");
    expect(text()).not.toContain("Solicitudes de decisión go / no-go");
    expect(calls("GET", "/tenders?limit=200&open=true")).toHaveLength(0);
  });

  it("un error del servidor al guardar se muestra, no se traga", async () => {
    stubFetch({
      "GET /whatsapp/settings": () => ({ body: SETTINGS() }),
      "GET /tenders?limit=200&open=true": () => ({ body: TENDERS }),
      "PUT /whatsapp/settings": () => ({ ok: false, status: 400, body: { message: "telefono: se esperaba formato internacional" } }),
    });
    mount(CTX);
    await settle();
    await act(async () => {
      changeValue(field("Teléfono de WhatsApp") as HTMLInputElement, "5512345678");
    });
    await act(async () => {
      await submitForm(field("Teléfono de WhatsApp").closest("form")!);
    });
    await settle();
    expect(text()).toContain("formato internacional");
  });
});
