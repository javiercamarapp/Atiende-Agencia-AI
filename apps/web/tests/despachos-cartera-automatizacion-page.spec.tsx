// @vitest-environment jsdom
//
// paridad3 D-31 / D-P3-21 -- Cartera: semaforo de documentos por cliente y dialogo de automatizacion (contacto, dia, plantilla, opt-in de la entrega de
// reportes APAGADO por omision, documentos pedidos con «no aplica»/reabrir). Todo contra endpoints reales mockeados por ruta.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarteraPage } from "../src/verticals/despachos/pages/Cartera.tsx";
import type { CarteraRespuesta } from "../src/verticals/despachos/lib/cartera-client.ts";
import type { AutomatizacionCliente, SolicitudDocumentos } from "../src/verticals/despachos/lib/piloto-client.ts";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const FICHA = { propertyId: "p1", rfc: "ABC010101AB1", tipoPersona: "moral", razonSocial: "Abarrotes SA de CV", regimenesFiscales: [{ clave: "601", nombre: "General" }], cpFiscal: "06600", periodicidad: "mensual", responsableId: null, creadoEn: "2026-01-01T00:00:00Z", actualizadoEn: "2026-01-01T00:00:00Z" };
const doc = (semaforo: "verde" | "amarillo" | "rojo" | "sin_solicitud", total: number, pendientes: number, recibidos = 0, enRevision = 0) => ({ semaforo, total, pendientes, enRevision, recibidos, noAplica: 0 });
const LISTA: CarteraRespuesta = {
  estado: "disponible",
  puedeDarDeAlta: true,
  documentosPeriodo: { periodo: "2026-06", disponible: true },
  clientes: [
    { propertyId: "p1", nombre: "Abarrotes del Norte", ficha: FICHA as never, documentos: doc("rojo", 3, 2, 1) },
    { propertyId: "p2", nombre: "Taller Verde", ficha: { ...FICHA, propertyId: "p2" } as never, documentos: doc("verde", 3, 0, 3) },
    { propertyId: "p3", nombre: "Cafe Nuevo", ficha: { ...FICHA, propertyId: "p3" } as never, documentos: doc("sin_solicitud", 0, 0) },
    { propertyId: "p4", nombre: "Sin ficha", ficha: null, documentos: doc("sin_solicitud", 0, 0) },
  ],
};
const AUTO: AutomatizacionCliente = { contactoCorreo: "cliente@abarrotes.mx", envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} };
const SOLICITUD: SolicitudDocumentos = {
  id: "s1", ejercicio: 2026, mes: 6, estado: "abierta", creadaEn: "2026-07-01T00:00:00Z", completadaEn: null, ultimoRecordatorioNivel: 1,
  renglones: [
    { id: "r1", tipo: "estado_cuenta", etiqueta: "Estado de cuenta ****6789", estado: "pendiente", motivoNoAplica: null, documentoId: null, resueltoEn: null },
    { id: "r2", tipo: "xml_emitidos", etiqueta: "CFDI emitidos del mes (XML)", estado: "no_aplica", motivoNoAplica: "No facturó", documentoId: null, resueltoEn: "2026-07-02T00:00:00Z" },
    { id: "r3", tipo: "xml_recibidos", etiqueta: "CFDI recibidos del mes (XML)", estado: "recibido", motivoNoAplica: null, documentoId: "d1", resueltoEn: "2026-07-02T00:00:00Z" },
  ],
};

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;
let disponible = true;

function stubFetch() {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/admin/cartera") && method === "GET") return new Response(JSON.stringify(LISTA), { status: 200 });
      if (url.endsWith("/admin/staff/miembros")) return new Response(JSON.stringify({ miembros: [] }), { status: 200 });
      if (url.endsWith("/p1/automatizacion") && method === "GET") return new Response(JSON.stringify(disponible ? { disponible: true, automatizacion: AUTO } : { disponible: false, automatizacion: null }), { status: 200 });
      if (url.endsWith("/p1/automatizacion") && method === "PUT") return new Response(JSON.stringify({ disponible: true, automatizacion: JSON.parse(String(init!.body)) }), { status: 200 });
      if (url.endsWith("/p1/solicitudes-documentos") && method === "GET") return new Response(JSON.stringify({ disponible, solicitudes: disponible ? [SOLICITUD] : [] }), { status: 200 });
      if (url.endsWith("/p1/solicitudes-documentos") && method === "POST") return new Response(JSON.stringify({ id: "s2", creada: true, correo: "enviado" }), { status: 201 });
      if (url.includes("/renglones/") && method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`fetch inesperado: ${method} ${url}`);
    }),
  );
}

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  disponible = true;
});
afterEach(() => {
  vi.useRealTimers();
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });
async function montar(role = "contador") {
  rendered = renderComponent(
    <MemoryRouter>
      <CarteraPage {...CTX(role)} />
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
const botones = () => [...document.body.querySelectorAll("button")];
const boton = (t: string | RegExp) => botones().find((b) => (typeof t === "string" ? b.textContent?.trim() === t : t.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const escrituras = () => llamadas.filter((l) => l.method !== "GET");

describe("Cartera -- semaforo de documentos", () => {
  it("muestra una columna por el periodo con el semaforo y el avance de cada cliente", async () => {
    stubFetch();
    await montar();
    const texto = rendered!.container.textContent ?? "";
    expect(texto).toContain("Documentos 2026-06");
    expect(texto).toContain("Atrasado");
    expect(texto).toContain("Completo");
    expect(texto).toContain("Sin pedir");
    expect(texto).toContain("1 de 3");
  });

  it("base sin la 027: no hay columna ni boton de automatizacion (nada de controles que el servidor rechazaria)", async () => {
    stubFetch();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.endsWith("/admin/cartera")) return new Response(JSON.stringify({ ...LISTA, documentosPeriodo: { periodo: "2026-06", disponible: false }, clientes: LISTA.clientes.map((c) => ({ ...c, documentos: null })) }), { status: 200 });
      return new Response(JSON.stringify({ miembros: [] }), { status: 200 });
    });
    await montar();
    expect(rendered!.container.textContent).not.toContain("Documentos 2026-06");
    expect(boton("Automatización")).toBeUndefined();
  });

  it("solo los clientes con ficha tienen el boton Automatización", async () => {
    stubFetch();
    await montar();
    expect(botones().filter((b) => b.textContent?.trim() === "Automatización")).toHaveLength(3);
  });
});

describe("Cartera -- dialogo de automatizacion", () => {
  async function abrir(role = "contador") {
    stubFetch();
    await montar(role);
    await act(async () => {
      click(boton("Automatización")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
  }

  it("carga la configuracion real: el envio de reportes arranca APAGADO y se ven los documentos pedidos", async () => {
    await abrir();
    expect(dialogo()).not.toBeNull();
    const cb = [...dialogo()!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const envio = cb.find((c) => c.closest("label")?.textContent?.includes("Enviar al cliente sus reportes"))!;
    expect(envio.checked).toBe(false);
    expect((document.getElementById("form-automatizacion-cliente-correo") as HTMLInputElement).value).toBe("cliente@abarrotes.mx");
    expect(dialogo()!.textContent).toContain("Estado de cuenta ****6789");
    expect(dialogo()!.textContent).toContain("1 recibido(s)");
  });

  it("guardar manda PUT con contacto, dia, plantilla y el opt-in; sin correo no deja activar el envio", async () => {
    await abrir();
    changeValue(document.getElementById("form-automatizacion-cliente-correo") as HTMLInputElement, "");
    const envio = ([...dialogo()!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]).find((c) => c.closest("label")?.textContent?.includes("Enviar al cliente sus reportes"))!;
    await act(async () => {
      click(envio);
      await flushMicrotasks();
    });
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);
    expect(dialogo()!.textContent).toContain("captura primero el correo de contacto");
    changeValue(document.getElementById("form-automatizacion-cliente-correo") as HTMLInputElement, "nuevo@cliente.mx");
    changeValue(document.getElementById("form-automatizacion-cliente-dia") as HTMLInputElement, "5");
    await act(async () => {
      click(boton("Guardar")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const put = escrituras().find((l) => l.method === "PUT")!;
    expect(put.body).toMatchObject({ contactoCorreo: "nuevo@cliente.mx", envioReportesCierre: true, solicitudDia: 5, solicitudActiva: true });
  });

  it("«No aplica» pide un motivo y lo manda al servidor; reabrir llama a su ruta", async () => {
    await abrir();
    await act(async () => {
      click(boton("No aplica")!);
      await flushMicrotasks();
    });
    const alerta = document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(alerta).not.toBeNull();
    const confirmar = [...alerta.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar como no aplica")) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    changeValue(alerta.querySelector("textarea")!, "No emitió facturas este mes");
    await act(async () => {
      click(confirmar);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const post = escrituras().find((l) => l.url.endsWith("/renglones/r1/no-aplica"))!;
    expect(post.body).toEqual({ motivo: "No emitió facturas este mes" });
    await flush();
    await act(async () => {
      click(boton("Reabrir")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(escrituras().some((l) => l.url.endsWith("/renglones/r2/reabrir"))).toBe(true);
  });

  it("«Pedir documentos de AAAA-MM» crea la solicitud del mes ANTERIOR y avisa que salio el correo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T18:00:00Z"));
    await abrir();
    const pedir = boton("Pedir documentos de 2026-09")!;
    expect(pedir).toBeDefined();
    expect(pedir.disabled).toBe(false);
    await act(async () => {
      click(pedir);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(escrituras().find((l) => l.url.endsWith("/p1/solicitudes-documentos"))!.body).toEqual({ periodo: "2026-09" });
    expect(dialogo()!.textContent).toContain("Se envió el aviso al cliente");
  });

  it("si el periodo anterior ya esta pedido el boton queda deshabilitado (nunca pide dos veces)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-07T18:00:00Z"));
    await abrir();
    expect(boton("Pedir documentos de 2026-06")!.disabled).toBe(true);
  });

  it("un auditor ve la configuracion pero ningun control de escritura", async () => {
    await abrir("auditor");
    expect(boton("Guardar")).toBeUndefined();
    expect(boton("No aplica")).toBeUndefined();
    expect(botones().some((b) => /^Pedir documentos/.test(b.textContent ?? ""))).toBe(false);
    expect((document.getElementById("form-automatizacion-cliente-correo") as HTMLInputElement).disabled).toBe(true);
  });

  it("base sin la 027: 'No disponible aun: requiere la migracion 027' en vez de controles", async () => {
    disponible = false;
    stubFetch();
    await montar();
    await act(async () => {
      click(boton("Automatización")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(dialogo()!.textContent).toContain("No disponible aún");
    expect(dialogo()!.textContent).toContain("migración 027");
    expect(boton("Guardar")).toBeUndefined();
  });
});
