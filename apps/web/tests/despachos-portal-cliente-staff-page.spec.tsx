// @vitest-environment jsdom
//
// UNI-C despachos (.1/.2) -- pagina del staff "Portal del cliente": un solo h1, el alta de enlace es un FormDialog con labels
// y las acciones irreversibles (revocar enlace, rechazar documento) piden confirmacion: Cancelar nunca llama a la API.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClientePage } from "../src/verticals/despachos/pages/PortalCliente.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { dialogoConfirm, pulsarEnDialogo } from "./test-utils/confirm.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role: "contador", staffFullName: "Contadora", staffEmail: "c@example.com" };
const ENLACE = { id: "e1", etiqueta: "Administración", creadoEn: "2026-09-01T10:00:00.000Z", expiraEn: "2999-01-01T00:00:00.000Z", revocadoEn: null, ultimoUsoEn: null, usos: 0 };
const DOC = { id: "d1", tipo: "pdf", nombreArchivo: "constancia.pdf", tamanoBytes: 2048, estado: "recibido", motivo: null, resumen: {}, invoiceId: null, creadoEn: "2026-09-02T10:00:00.000Z" };

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as unknown as Response;
}
function stubFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/portal-cliente/enlaces")) return json({ disponible: true, enlaces: [ENLACE] });
    if (method === "GET" && url.endsWith("/portal-cliente/documentos")) return json({ disponible: true, documentos: [DOC] });
    if (method === "GET" && url.endsWith("/portal-cliente/mensajes")) return json({ disponible: true, mensajes: [] });
    if (method === "POST" && url.endsWith("/enlaces/e1/revocar")) return json({ revocado: true });
    if (method === "POST" && url.endsWith("/documentos/d1/rechazar")) return json({ estado: "rechazado" });
    if (method === "POST" && url.endsWith("/portal-cliente/enlaces")) return json({ id: "e2", etiqueta: "Nuevo", expiraEn: "2999-01-01T00:00:00.000Z", url: "https://portal.test/#t=secreto" });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function montar(ctx: DespachosShellContext = CTX) {
  rendered = renderComponent(<PortalClientePage {...ctx} />);
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const escrituras = (sufijo: string) => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith(sufijo));
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
async function pulsar(texto: string) {
  await act(async () => {
    click(boton(texto));
    await flushMicrotasks();
  });
}

describe("PortalClientePage (staff) -- estructura y confirmaciones", () => {
  it("un solo h1 y ningun <input> sin label asociado en la pagina", async () => {
    stubFetch();
    await montar();
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered!.container.querySelector("h1")!.textContent).toBe("Portal del cliente");
    for (const c of rendered!.container.querySelectorAll("textarea,select,input:not([readonly])")) {
      const id = c.getAttribute("id");
      expect(c.getAttribute("aria-label") !== null || (id !== null && rendered!.container.querySelector(`label[for="${id}"]`) !== null)).toBe(true);
    }
  });

  it("revocar enlace: Cancelar no llama a la API; confirmar si", async () => {
    stubFetch();
    await montar();
    await pulsar("Revocar");
    expect(dialogoConfirm()).not.toBeNull();
    await pulsarEnDialogo("Cancelar");
    expect(escrituras("/enlaces/e1/revocar")).toHaveLength(0);
    await pulsar("Revocar");
    await pulsarEnDialogo("Revocar");
    expect(escrituras("/enlaces/e1/revocar")).toHaveLength(1);
  });

  it("rechazar documento: Cancelar no llama a la API; confirmar manda el motivo tecleado", async () => {
    stubFetch();
    await montar();
    await pulsar("Rechazar");
    expect(dialogoConfirm()!.textContent).toContain("constancia.pdf");
    await pulsarEnDialogo("Cancelar");
    expect(escrituras("/documentos/d1/rechazar")).toHaveLength(0);
    await pulsar("Rechazar");
    await act(async () => {
      changeValue(dialogoConfirm()!.querySelector("textarea")!, "Ilegible");
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Rechazar");
    const llamadas = escrituras("/documentos/d1/rechazar");
    expect(llamadas).toHaveLength(1);
    expect(JSON.parse(String((llamadas[0]![1] as RequestInit).body))).toEqual({ motivo: "Ilegible" });
  });

  it("crear enlace abre un FormDialog con labels y muestra el enlace una sola vez", async () => {
    stubFetch();
    await montar();
    await pulsar("Crear enlace");
    const dlg = document.body.querySelector('[role="dialog"]')!;
    const campo = dlg.querySelector("#portal-etiqueta") as HTMLInputElement;
    expect(dlg.querySelector(`label[for="${campo.id}"]`)).not.toBeNull();
    await act(async () => {
      changeValue(campo, "Nuevo");
      await flushMicrotasks();
    });
    await act(async () => {
      click([...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Crear enlace")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(escrituras("/portal-cliente/enlaces")).toHaveLength(1);
    expect((rendered!.container.querySelector('input[aria-label="Enlace del portal"]') as HTMLInputElement).value).toBe("https://portal.test/#t=secreto");
  });

  it("un rol de solo lectura no ve acciones de escritura", async () => {
    stubFetch();
    await montar({ ...CTX, role: "auditor" });
    expect(boton("Crear enlace")).toBeUndefined();
    expect(boton("Revocar")).toBeUndefined();
    expect(boton("Rechazar")).toBeUndefined();
  });
});
