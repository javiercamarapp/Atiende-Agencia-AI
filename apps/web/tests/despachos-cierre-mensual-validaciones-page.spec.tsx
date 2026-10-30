// @vitest-environment jsdom
//
// paridad3 D-P3-15 -- el detalle del periodo muestra las validaciones que calcula el SERVIDOR; si fallan el admin solo puede cerrar FORZANDO con un motivo
// (y escribiendo el periodo), un no-admin no ve el boton, y al cerrar se muestran los pasos del pos-cierre y los entregables descargables.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CierreMensualDetallePage } from "../src/verticals/despachos/pages/CierreMensualDetalle.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });
const PERIODO = { id: "per-1", organizationId: "org-1", propertyId: "prop-1", year: 2026, month: 8, status: "open" as const, openedAt: "2026-09-01T00:00:00.000Z", closedAt: null, closedBy: null };
const ESTADO = { totalTasks: 0, done: 0, skipped: 0, pending: 0, inProgress: 0, progressPercent: 0, blocked: [], overdue: [] };
const ITEM = (clave: string, titulo: string, ok: boolean, mensaje: string, detalle: Record<string, unknown> = {}) => ({ clave, titulo, ok, bloqueante: true, mensaje, detalle });
const FALLAN = {
  disponible: true,
  puedeCerrar: false,
  items: [
    ITEM("balanza", "Balanza cuadrada", true, "La balanza del libro cuadra."),
    ITEM("cfdi_sin_poliza", "CFDI contabilizados", false, "2 de 10 CFDI de ingreso o egreso del periodo no tienen póliza."),
    ITEM("solicitud_documentos", "Documentos del cliente completos", false, "Faltan 3 documento(s) del cliente por recibir o revisar.", { estado: "abierta", pendientes: 3 }),
  ],
};
const SANO = { disponible: true, puedeCerrar: true, items: [ITEM("balanza", "Balanza cuadrada", true, "La balanza del libro cuadra.")] };

function res(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, blob: async () => new Blob(["<xml/>"]), headers: new Headers() } as unknown as Response;
}
function stubFetch(detalle: unknown, cerrar: () => Response = () => res({ ...PERIODO, status: "closed", posCierre: { papelPagos: "generado", contabilidadElectronica: "generada", entrega: "enviada" } })) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/cierre-mensual/periodos/per-1")) return res(detalle);
    if (method === "POST" && url.endsWith("/cierre-mensual/periodos/per-1/cerrar")) return cerrar();
    if (url.includes("/2fa/") || url.includes("two-factor") || url.includes("/auth/")) return res({ available: false });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function montar(role = "admin") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/despachos/demo/cierre-mensual/per-1"]}>
      <Routes>
        <Route path="/despachos/:orgSlug/cierre-mensual/:periodoId" element={<CierreMensualDetallePage {...CTX(role)} />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const posts = () => fetchMock.mock.calls.filter(([url, init]) => (init as RequestInit | undefined)?.method === "POST" && String(url).endsWith("/cerrar"));

describe("CierreMensualDetalle -- validaciones del servidor", () => {
  it("lista las validaciones con su resultado, el conteo de las que faltan y el enlace a Cartera para los documentos", async () => {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: FALLAN, artefactos: [], entrega: null });
    await montar();
    expect(texto()).toContain("Validaciones del cierre");
    expect(texto()).toContain("2 sin cumplir");
    expect(texto()).toContain("2 de 10 CFDI de ingreso o egreso del periodo no tienen póliza.");
    expect(rendered!.container.querySelector('a[href="/despachos/demo/cartera"]')).not.toBeNull();
    expect(texto()).toContain("Faltan 3");
  });

  it("todo cumple: 'Listo para cerrar' y el boton normal (sin excepciones)", async () => {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: SANO });
    await montar();
    expect(texto()).toContain("Listo para cerrar");
    expect(boton("Cerrar período")).toBeDefined();
    expect(boton("Cerrar con excepciones")).toBeUndefined();
  });

  it("base sin la 027: aviso honesto 'no disponible aun' y el cierre se rige solo por las tareas", async () => {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: { disponible: false, items: [], puedeCerrar: true } });
    await montar();
    expect(texto()).toContain("No disponible aún");
    expect(texto()).toContain("migración 027");
    expect(boton("Cerrar período")).toBeDefined();
  });

  it("un contador ve las validaciones pero NO el boton de cerrar (solo admin)", async () => {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: FALLAN });
    await montar("contador");
    expect(texto()).toContain("Validaciones del cierre");
    expect(boton("Cerrar período")).toBeUndefined();
    expect(boton("Cerrar con excepciones")).toBeUndefined();
  });
});

describe("CierreMensualDetalle -- cierre forzado de un admin", () => {
  async function abrirForzar() {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: FALLAN });
    await montar();
    await act(async () => {
      click(boton("Cerrar con excepciones")!);
      await flushMicrotasks();
    });
  }

  it("con validaciones fallidas el boton dice 'Cerrar con excepciones', lista lo que se salta y NO llama al servidor al abrir", async () => {
    await abrirForzar();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("CFDI contabilizados");
    expect(dialogo()!.textContent).toContain("Documentos del cliente completos");
    expect(posts()).toHaveLength(0);
  });

  it("exige motivo de 10 a 500 caracteres Y el periodo exacto antes de habilitar el cierre", async () => {
    await abrirForzar();
    const cerrar = () => boton("Cerrar de todos modos")!;
    expect(cerrar().disabled).toBe(true);
    changeValue(document.getElementById("motivo-forzado") as HTMLTextAreaElement, "corto");
    changeValue(document.getElementById("texto-forzado") as HTMLInputElement, "2026-08");
    expect(cerrar().disabled).toBe(true);
    changeValue(document.getElementById("motivo-forzado") as HTMLTextAreaElement, "El cliente entregó tarde; cierro con la diferencia conocida");
    changeValue(document.getElementById("texto-forzado") as HTMLInputElement, "2026-07");
    expect(cerrar().disabled).toBe(true);
    changeValue(document.getElementById("texto-forzado") as HTMLInputElement, "2026-08");
    expect(cerrar().disabled).toBe(false);
  });

  it("confirmar manda POST .../cerrar con forzar y el motivo, y muestra los pasos del pos-cierre", async () => {
    await abrirForzar();
    changeValue(document.getElementById("motivo-forzado") as HTMLTextAreaElement, "El cliente entregó tarde; cierro con la diferencia conocida");
    changeValue(document.getElementById("texto-forzado") as HTMLInputElement, "2026-08");
    await act(async () => {
      click(boton("Cerrar de todos modos")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ confirmacion: "2026-08", forzar: true, motivo: "El cliente entregó tarde; cierro con la diferencia conocida" });
    expect(texto()).toContain("borrador del papel de pagos provisionales");
    expect(texto()).toContain("portal del cliente");
  });

  it("si el servidor bloquea el cierre muestra su mensaje y el dialogo sigue abierto", async () => {
    stubFetch({ periodo: PERIODO, tareas: [], estado: ESTADO, validaciones: FALLAN }, () => res({ code: "cierre_bloqueado", message: "No se puede cerrar 2026-08: 2 validación(es) sin cumplir." }, 409));
    await montar();
    await act(async () => {
      click(boton("Cerrar con excepciones")!);
      await flushMicrotasks();
    });
    changeValue(document.getElementById("motivo-forzado") as HTMLTextAreaElement, "El cliente entregó tarde; cierro con la diferencia conocida");
    changeValue(document.getElementById("texto-forzado") as HTMLInputElement, "2026-08");
    await act(async () => {
      click(boton("Cerrar de todos modos")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.querySelector('[role="alert"]')?.textContent).toContain("2 validación(es) sin cumplir");
  });
});

describe("CierreMensualDetalle -- entregables del periodo cerrado", () => {
  const CERRADO = { ...PERIODO, status: "closed" as const, closedAt: "2026-09-05T00:00:00.000Z", closedBy: "u1" };

  it("lista los XML pre-generados (no presentados) con descarga solo para quien puede escribir, y el estado de la entrega al cliente", async () => {
    const detalle = {
      periodo: CERRADO, tareas: [], estado: ESTADO, validaciones: { disponible: true, puedeCerrar: true, items: [] },
      artefactos: [{ id: "a1", tipo: "contabilidad_balanza_xml", nombreArchivo: "balanza-2026-08.xml", tamanoBytes: 900, creadoEn: "2026-09-05T00:00:00Z" }],
      entrega: { id: "e1", creadaEn: "2026-09-05T00:00:00Z", correoEncoladoEn: "2026-09-05T00:00:01Z", archivos: [{ id: "f1", tipo: "diot", nombreArchivo: "diot.pdf", tamanoBytes: 5 }] },
    };
    stubFetch(detalle);
    await montar("contador");
    expect(texto()).toContain("Entregables del cierre");
    expect(texto()).toContain("Balanza de comprobación (XML)");
    expect(texto()).toContain("no presentado");
    expect(boton("Descargar")).toBeDefined();
    expect(texto()).toContain("1 PDF publicado(s) en su portal");
    expect(texto()).toContain("aviso por correo enviado");
    rendered!.unmount();
    stubFetch(detalle);
    await montar("auditor");
    expect(boton("Descargar")).toBeUndefined();
  });
});
