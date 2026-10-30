// @vitest-environment jsdom
//
// Smoke tests reales de <IdentidadPage /> (H-01): metadatos sin documento, estados honestos
// (base sin migrar / sin llave), revelar con motivo (cancelar el prompt NO llama a la API),
// ocultar, pestaña de purgas solo para owner/gm y mensaje real del doble control.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { IdentidadPage } from "../src/verticals/hoteles/pages/Identidad.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "GM Demo", staffEmail: "gm@example.com" };

const IDENT = {
  id: "ident-1", huespedId: "guest-1", reservaId: "res-1", tipoDocumento: "pasaporte", nacionalidad: "USA", ultimos4: "5678", versionLlave: 1, estado: "activo",
  retencionHasta: "2027-03-01", verificadaEn: null, verificadaPor: null, capturadaPor: "u1", creadaEn: "2026-03-01T00:00:00Z", purgadaEn: null,
};
const PURGA = { id: "purga-1", identidadId: "ident-1", solicitadaPor: "owner-1", motivo: "Cancelacion ARCO del titular", estado: "pendiente", decididaPor: null, decididaEn: null, notaDecision: null, creadaEn: "2026-03-02T00:00:00Z" };

const INFO = {
  avisoLegal: "Esta pantalla es una herramienta de registro y control. NO es asesoria legal ni garantiza el cumplimiento de la LFPDPPP.",
  unAbogadoDebeConfirmar: ["Si los plazos ARCO se cuentan en dias naturales o habiles.", "Plazo y forma de la notificacion de vulneraciones (art. 19)."],
  plazos: { arcoRespuestaDias: 20, arcoEjecucionDias: 15, diasNaturales: true, prorrogaUnicaPorIgualPlazo: true, ventanaBloqueoDias: { minimo: 3, maximo: 30, porDefecto: 7 } },
};
const AVISO = {
  id: "aviso-1", version: "v1", textoSimplificado: "Usamos tus datos para identificarte y facturar.", urlIntegral: "https://hotel.example.com/aviso",
  finalidadesObligatorias: ["identificar al huesped", "facturacion"], finalidadesOpcionales: ["promociones"], vigente: true, publicadoEn: "2026-03-01T00:00:00Z",
};
const IDENT_BLOQUEADA = { ...IDENT, id: "ident-2", estado: "bloqueada", bloqueadaEn: "2026-03-02T00:00:00Z", bloqueadaHasta: "2026-03-09T00:00:00Z", ventanaBloqueoDias: 7, motivoBloqueo: "retencion_vencida", bloqueadaPor: null };
const ARCO = {
  id: "arco-1", folio: "ARCO-20260301-AB12CD", derecho: "cancelacion", huespedId: "guest-1", identidadId: "ident-1", solicitante: "Juan Perez", contacto: null, canal: "correo", descripcion: "Pide borrar sus datos",
  recibidaEn: "2026-03-01", respuestaLimite: "2026-03-21", ejecucionLimite: null, estado: "recibida", notaDecision: null, prorroga: null,
  plazo: { fase: "respuesta", vence: "2026-03-21", diasRestantes: -3, estado: "vencida" }, prorrogaDisponible: { disponible: true, dias: 20 },
};
const ARCO_ACCESO = {
  id: "arco-2", folio: "ARCO-20260320-ZZ99XY", derecho: "acceso", huespedId: null, identidadId: null, solicitante: "Ana Torres", contacto: "ana@example.com", canal: "publico", descripcion: null,
  recibidaEn: "2026-03-20", respuestaLimite: "2026-04-09", ejecucionLimite: "2026-04-24", estado: "procedente", notaDecision: "Identidad verificada", prorroga: null,
  plazo: { fase: "ejecucion", vence: "2026-04-24", diasRestantes: 31, estado: "en_plazo" }, prorrogaDisponible: { disponible: false, dias: 15 },
};
const INCIDENTE = {
  id: "inc-1", folio: "INC-20260301-AB12CD", tipo: "divulgacion", severidad: "alta", titulo: "Correo al huesped equivocado", descripcion: "Se envio una confirmacion a otra persona.", detectadoEn: "2026-03-01T10:00:00Z",
  afectados: 1, riesgoSignificativo: true, estado: "detectada", notificacion: null, motivoNoNotificar: null,
  recordatorio: { requerido: true, vencido: true, horasDesdeDeteccion: 5, mensaje: "Notifica al titular DE INMEDIATO (art. 19 LFPDPPP): van 5 h desde la deteccion. Este sistema NO envia la notificacion; registrala aqui cuando la hagas." },
};
const RETENCION = { id: "hold-1", identidadId: "ident-2", incidenteId: null, folio: "FGR-2026-0042", motivo: "Carpeta de investigacion abierta", autorizacion: "Direccion juridica", estado: "activa", revisarAntesDe: "2027-03-01", revision: "vigente" };
const ACCESO = { id: "acc-1", identidadId: "ident-2", solicitadaPor: "owner-1", motivo: "Requerimiento de autoridad con oficio 123", estado: "pendiente", caducaEn: null };

interface Opts {
  list?: unknown;
  purgas?: unknown;
  decideStatus?: number;
  avisos?: unknown;
  arco?: unknown;
  incidentes?: unknown;
  retenciones?: unknown;
  accesos?: unknown;
  decideAccesoStatus?: number;
  enlace?: { status: number; body: unknown };
}

function stubFetch(opts: Opts = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.test", "");
    if (path.startsWith("/hoteles/prop-1/privacidad/")) {
      const p = path.replace("/hoteles/prop-1/privacidad/", "");
      if (method === "GET" && p === "info") return jsonResponse(INFO);
      if (method === "GET" && p === "avisos") return jsonResponse(opts.avisos ?? { disponible: true, items: [] });
      if (method === "GET" && p === "consentimientos") return jsonResponse({ disponible: true, items: [] });
      if (method === "GET" && p === "configuracion") return jsonResponse({ disponible: true, ventanaBloqueoDias: 7, esDefault: true, actualizadoPor: null, actualizadoEn: null });
      if (method === "GET" && p === "arco") return jsonResponse(opts.arco ?? { disponible: true, hoy: "2026-03-24", items: [] });
      if (method === "GET" && p === "incidentes") return jsonResponse(opts.incidentes ?? { disponible: true, items: [] });
      if (method === "GET" && p === "retenciones") return jsonResponse(opts.retenciones ?? { disponible: true, items: [] });
      if (method === "GET" && p === "accesos-excepcionales") return jsonResponse(opts.accesos ?? { disponible: true, items: [] });
      if (method === "GET" && p.startsWith("bitacora")) return jsonResponse({ disponible: true, items: [] });
      if (method === "POST" && p === "arco/arco-2/enlace-mis-datos") {
        const e = opts.enlace ?? { status: 200, body: { enlace: "https://app.test/hoteles/demo/mis-datos#token=m1.abc.def", venceEn: "2026-03-25T10:00:00.000Z", correo: "encolado", envioDeCorreo: "pendiente_de_configuracion" } };
        return jsonResponse(e.body, e.status);
      }
      if (method === "POST" && p === "accesos-excepcionales/acc-1/decidir") {
        return opts.decideAccesoStatus && opts.decideAccesoStatus >= 400
          ? jsonResponse({ message: "Doble control: quien solicita el acceso excepcional no puede aprobarlo ni rechazarlo; debe decidirlo otra persona con rol owner/gm." }, opts.decideAccesoStatus)
          : jsonResponse({ resultado: "aprobada" });
      }
    }
    if (method === "GET" && path.startsWith("/hoteles/prop-1/identidad-purgas")) return jsonResponse(opts.purgas ?? { disponible: true, items: [PURGA] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/identidad")) return jsonResponse(opts.list ?? { disponible: true, llaveConfigurada: true, items: [IDENT] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/registro-migratorio")) return jsonResponse({ disponible: true, items: [] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/huespedes")) return jsonResponse([{ id: "guest-1", nombreCompleto: "Ana Torres", email: null, telefono: null }]);
    if (method === "GET" && path.startsWith("/hoteles/prop-1/reservas")) return jsonResponse([]);
    if (method === "POST" && path === "/hoteles/prop-1/identidad/ident-1/revelar") {
      return jsonResponse({ identidad: IDENT, documento: { nombreCompleto: "Ana Torres", numeroDocumento: "G-1234 5678", fechaNacimiento: "1990-05-17", paisEmisor: null, vigenciaHasta: null, mrz: null } });
    }
    if (method === "POST" && path === "/hoteles/prop-1/identidad-purgas/purga-1/decidir") {
      return opts.decideStatus && opts.decideStatus >= 400
        ? jsonResponse({ message: "Doble control: quien solicita la purga no puede aprobarla ni rechazarla; debe decidirla otra persona con rol owner/gm." }, opts.decideStatus)
        : jsonResponse({ resultado: "ejecutada" });
    }
    if (method !== "GET") return jsonResponse({ ok: true, resultado: "ok", solicitudId: "x", identidad: null, retencion: null, solicitud: null });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(ctx: HotelesShellContext = CTX): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <IdentidadPage {...ctx} />
    </MemoryRouter>,
  );
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  return [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
}

const dialogo = () => document.body.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;
/** Cuerpo del dialogo (alertdialog de useConfirm o FormDialog) listo para escribir un motivo. */
async function escribirYConfirmar(texto: string | null, boton: string): Promise<void> {
  if (texto !== null) changeValue((dialogo()!.querySelector("textarea") ?? dialogo()!.querySelector("input")) as HTMLTextAreaElement, texto);
  await clickButton(botonDialogo(boton));
}

async function clickButton(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function openTab(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("IdentidadPage (hoteles)", () => {
  it("lista SOLO metadatos: tipo, ****ultimos4, nacionalidad y retencion; ningun documento en claro", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Pasaporte ****5678 · USA");
    expect(text).toContain("Retención hasta 2027-03-01");
    expect(text).toContain("Sin verificar");
    expect(text).not.toContain("G-1234");
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
  });

  it("base sin migrar (disponible:false): estado honesto 'aun no esta disponible', sin formulario de captura", async () => {
    stubFetch({ list: { disponible: false, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("aún no está disponible");
    expect(buttonByText("Capturar identidad")).toBeUndefined();
  });

  it("sin llave de cifrado: avisa y NO ofrece capturar", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: false, items: [] } });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("Falta la llave de cifrado");
    expect(buttonByText("Capturar identidad")).toBeUndefined();
  });

  it("con llave y base lista: ofrece capturar y el dialogo muestra el formulario de captura cifrada", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Capturar identidad"));
    expect(dialogo()!.querySelector("form")).not.toBeNull();
    expect(dialogo()!.querySelectorAll("label").length).toBeGreaterThanOrEqual(8);
    expect(rendered.container.textContent).toContain("Todavía no hay identidades capturadas");
  });

  it("el formulario de captura muestra el plazo que aplicara y el aviso de privacidad/consentimiento", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Capturar identidad"));
    const plazo = document.body.querySelector('[data-testid="plazo-retencion"]')!;
    expect(plazo.textContent).toContain("30 día(s)");
    const nota = document.body.querySelector('[role="note"]')!.textContent!;
    expect(nota).toContain("aviso de privacidad");
    expect(nota).toContain("consentimiento");
    expect(nota).toContain("365 días");
  });

  it("cancelar el dialogo del motivo (boton o Escape) NUNCA llama a revelar", async () => {
    stubFetch();
    const prompt = vi.spyOn(window, "prompt");
    rendered = renderPage();
    await esperar();
    const antes = fetchMock.mock.calls.length;
    await clickButton(buttonByText("Revelar"));
    expect(dialogo()).not.toBeNull();
    await clickButton(botonDialogo("Cancelar"));
    expect(dialogo()).toBeNull();
    await clickButton(buttonByText("Revelar"));
    await act(async () => {
      dialogo()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(antes);
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
  });

  it("revelar con motivo: POST con el motivo, muestra el documento y 'Ocultar' lo descarta", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Revelar"));
    await escribirYConfirmar("Verificacion en mostrador al hacer check-in", "Revelar");
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/identidad/ident-1/revelar"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ motivo: "Verificacion en mostrador al hacer check-in" });
    const box = rendered.container.querySelector('[data-testid="documento-revelado"]')!;
    expect(box.textContent).toContain("Ana Torres");
    expect(box.textContent).toContain("G-1234 5678");

    await clickButton(buttonByText("Ocultar"));
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("G-1234");
  });

  it("rol reservations: captura/lista pero NO ve Revelar, Marcar verificada, Solicitar purga ni la pestana Purgas", async () => {
    stubFetch();
    rendered = renderPage({ ...CTX, role: "reservations" });
    await esperar();
    expect(buttonByText("Revelar")).toBeUndefined();
    expect(buttonByText("Marcar verificada")).toBeUndefined();
    expect(buttonByText("Solicitar purga")).toBeUndefined();
    expect(buttonByText("Purgas")).toBeUndefined();
  });

  it("frontdesk: puede revelar y verificar, pero no solicitar purga ni ve la pestana Purgas", async () => {
    stubFetch();
    rendered = renderPage({ ...CTX, role: "frontdesk" });
    await esperar();
    expect(buttonByText("Revelar")).toBeDefined();
    expect(buttonByText("Marcar verificada")).toBeDefined();
    expect(buttonByText("Solicitar purga")).toBeUndefined();
    expect(buttonByText("Purgas")).toBeUndefined();
  });

  it("pestana Purgas (owner): lista la solicitud pendiente y aprobar la ejecuta", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await openTab("Purgas");
    expect(rendered.container.textContent).toContain("Cancelacion ARCO del titular");
    expect(rendered.container.textContent).toContain("Doble control");
    await clickButton(buttonByText("Aprobar purga"));
    await escribirYConfirmar("", "Aprobar purga");
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/identidad-purgas/purga-1/decidir"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ aprobar: true });
    expect(toastMock.success).toHaveBeenCalledWith("Purga ejecutada.", expect.anything());
  });

  it("purgas: cancelar el dialogo de decision NO llama a decidir", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await openTab("Purgas");
    await clickButton(buttonByText("Aprobar purga"));
    await clickButton(botonDialogo("Cancelar"));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/decidir"))).toBe(false);
  });

  it("doble control: si el servidor rechaza al solicitante (403), se muestra el mensaje real y NO hay toast de exito", async () => {
    stubFetch({ decideStatus: 403 });
    rendered = renderPage();
    await esperar();
    await openTab("Purgas");
    await clickButton(buttonByText("Aprobar purga"));
    await escribirYConfirmar("", "Aprobar purga");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("Doble control"), expect.anything());
  });
});

describe("IdentidadPage (hoteles) -- H-02: bloqueo, consentimiento y privacidad", () => {
  it("una identidad BLOQUEADA muestra el bloqueo, no ofrece Revelar/Verificar/Solicitar purga y el admin ve Acceso excepcional y Retencion legal", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [IDENT_BLOQUEADA] } });
    rendered = renderPage();
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Bloqueada");
    expect(rendered.container.querySelector('[data-testid="identidad-bloqueada"]')!.textContent).toContain("Retención vencida");
    expect(rendered.container.querySelector('[data-testid="identidad-bloqueada"]')!.textContent).toContain("sin acceso operativo");
    expect(buttonByText("Revelar")).toBeUndefined();
    expect(buttonByText("Marcar verificada")).toBeUndefined();
    expect(buttonByText("Solicitar purga")).toBeUndefined();
    expect(buttonByText("Acceso excepcional")).toBeDefined();
    expect(buttonByText("Retención legal")).toBeDefined();
  });

  it("frontdesk no ve acciones sobre una identidad bloqueada; owner ve 'Bloquear' y 'Retencion legal' sobre una activa", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [IDENT_BLOQUEADA] } });
    rendered = renderPage({ ...CTX, role: "frontdesk" });
    await esperar();
    expect(buttonByText("Acceso excepcional")).toBeUndefined();
    rendered.unmount();
    stubFetch();
    rendered = renderPage();
    await esperar();
    expect(buttonByText("Bloquear")).toBeDefined();
    expect(buttonByText("Retención legal")).toBeDefined();
  });

  it("con aviso vigente el formulario de captura pide aceptar TODAS las finalidades obligatorias antes de capturar", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] }, avisos: { disponible: true, items: [AVISO] } });
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Capturar identidad"));
    await esperar();
    const fieldset = document.body.querySelector('fieldset[aria-label="Consentimiento y aviso de privacidad"]')!;
    expect(fieldset.textContent).toContain("Usamos tus datos para identificarte y facturar.");
    expect(fieldset.textContent).toContain("Finalidades obligatorias (todas)");
    expect(fieldset.textContent).toContain("casilla distinta, sin marcar");
    expect(fieldset.querySelector('[role="alert"]')).not.toBeNull();
    const boxes = [...fieldset.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    // 0 = registrar consentimiento, 1-2 = obligatorias, 3 = opcional, 4 = sensibles
    expect(boxes[1]!.checked).toBe(false);
    expect(boxes[3]!.checked).toBe(false);
    for (const b of [boxes[1]!, boxes[2]!]) await clickButton(b);
    expect(fieldset.querySelector('[role="alert"]')).toBeNull();
  });

  it("sin aviso vigente avisa que se publique uno y la captura sigue disponible (consentimiento opcional)", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Capturar identidad"));
    const fieldset = document.body.querySelector('fieldset[aria-label="Consentimiento y aviso de privacidad"]')!;
    expect(fieldset.textContent).toContain("No hay un aviso de privacidad vigente");
    expect(dialogo()!.querySelector("form")).not.toBeNull();
  });

  it("pestana Privacidad: muestra que NO es asesoria legal y la lista 'un abogado debe confirmar'", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    expect(rendered.container.querySelector('[data-testid="aviso-legal"]')!.textContent).toContain("NO es asesoria legal");
    expect(rendered.container.textContent).toContain("Un abogado debe confirmar (2 puntos)");
    expect(rendered.container.textContent).toContain("naturales o habiles");
  });

  it("pestana Privacidad > ARCO (owner): lista la solicitud con su plazo vencido y las acciones", async () => {
    stubFetch({ arco: { disponible: true, hoy: "2026-03-24", items: [ARCO] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("ARCO");
    expect(rendered.container.textContent).toContain("ARCO-20260301-AB12CD");
    expect(rendered.container.querySelector('[data-testid="plazo-arco"]')!.textContent).toContain("vencida hace 3 d");
    expect(buttonByText("Procedente")).toBeDefined();
    expect(buttonByText("Prórroga (+20 d)")).toBeDefined();
  });

  it("H-30 ARCO: el origen 'Formulario publico' se etiqueta, el staff no puede elegirlo como canal y solo un ACCESO procedente ofrece el enlace 'Mis datos'", async () => {
    stubFetch({ arco: { disponible: true, hoy: "2026-03-24", items: [ARCO, ARCO_ACCESO] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("ARCO");
    expect(rendered.container.textContent).toContain("por Formulario público");
    await clickButton(buttonByText("Registrar solicitud"));
    const opciones = [...document.body.querySelectorAll<HTMLOptionElement>("#arco-canal option")].map((o) => o.textContent);
    expect(opciones).toContain("Mostrador");
    expect(opciones).not.toContain("Formulario público");
    expect([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Enlace «Mis datos»"))).toHaveLength(1);
  });

  it("H-30 enlace 'Mis datos': elige al huesped, genera el enlace por la API y avisa honestamente que el correo no saldra sin Resend", async () => {
    stubFetch({ arco: { disponible: true, hoy: "2026-03-24", items: [ARCO_ACCESO] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("ARCO");
    await act(async () => {
      buttonByText("Enlace «Mis datos»").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    // la busqueda de huespedes tiene un retraso de 250 ms
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const sel = document.body.querySelector<HTMLSelectElement>("#mis-datos-h-arco-2")!;
    expect([...sel.options].map((o) => o.textContent)).toContain("Ana Torres");
    const generar = botonDialogo("Generar enlace");
    expect(generar.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(sel, "guest-1");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    await act(async () => {
      dialogo()!.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/arco/arco-2/enlace-mis-datos"))!;
    expect(JSON.parse(String(post[1].body))).toEqual({ huespedId: "guest-1", enviarCorreo: true });
    const res = document.body.querySelector('[data-testid="enlace-mis-datos-resultado"]')!;
    expect((res.querySelector("input") as HTMLInputElement).value).toBe("https://app.test/hoteles/demo/mis-datos#token=m1.abc.def");
    expect(res.textContent).toContain("NO saldrá hasta que se configure el envío de correo");
  });

  it("H-30 enlace 'Mis datos': un rechazo del servidor se muestra tal cual", async () => {
    stubFetch({ arco: { disponible: true, hoy: "2026-03-24", items: [ARCO_ACCESO] }, enlace: { status: 400, body: { message: "El enlace solo se emite para una solicitud de acceso procedente." } } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("ARCO");
    await act(async () => {
      buttonByText("Enlace «Mis datos»").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    // la busqueda de huespedes tiene un retraso de 250 ms
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const sel = document.body.querySelector<HTMLSelectElement>("#mis-datos-h-arco-2")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "guest-1");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    await act(async () => {
      dialogo()!.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(dialogo()!.querySelector('[role="alert"]')!.textContent).toContain("solo se emite para una solicitud de acceso procedente");
  });

  it("pestana Privacidad > Incidentes (owner): el recordatorio del art. 19 es visible y solo informa; frontdesk reporta pero no ve ARCO ni Retencion", async () => {
    stubFetch({ incidentes: { disponible: true, items: [INCIDENTE] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("Incidentes");
    const alerta = rendered.container.querySelector('[data-testid="recordatorio-notificar"]')!;
    expect(alerta.textContent).toContain("DE INMEDIATO");
    expect(alerta.textContent).toContain("NO envia");
    expect(buttonByText("Registrar notificación al titular")).toBeDefined();
    rendered.unmount();

    stubFetch();
    rendered = renderPage({ ...CTX, role: "frontdesk" });
    await esperar();
    await openTab("Privacidad");
    expect(buttonByText("ARCO")).toBeUndefined();
    expect(buttonByText("Retención y bloqueo")).toBeUndefined();
    await openTab("Incidentes");
    expect(buttonByText("Reportar incidente")).toBeDefined();
    await clickButton(buttonByText("Reportar incidente"));
    expect(dialogo()!.querySelector("form")).not.toBeNull();
    expect(rendered.container.textContent).toContain("Solo owner/gm ven y gestionan los incidentes reportados.");
  });

  it("pestana Privacidad > Retencion y bloqueo: lista retenciones y accesos; el doble control rechaza al solicitante con el mensaje real", async () => {
    stubFetch({ retenciones: { disponible: true, items: [RETENCION] }, accesos: { disponible: true, items: [ACCESO] }, decideAccesoStatus: 403 });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("Retención y bloqueo");
    expect(rendered.container.textContent).toContain("Caso FGR-2026-0042");
    expect(rendered.container.textContent).toContain("autoriza: Direccion juridica");
    expect(buttonByText("Liberar retención")).toBeDefined();
    await clickButton(buttonByText("Aprobar acceso"));
    await escribirYConfirmar("", "Aprobar acceso");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("Doble control"), expect.anything());
  });

  it("base sin migrar (032): las secciones de privacidad muestran 'aun no esta disponible', sin pantallas rotas", async () => {
    stubFetch({ avisos: { disponible: false, items: [] }, arco: { disponible: false, hoy: "2026-03-24", items: [] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    expect(rendered.container.textContent).toContain("migración 032 pendiente");
    await openTab("ARCO");
    expect(rendered.container.textContent).toContain("migración 032 pendiente");
  });
});

const escrituras = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET");

describe("IdentidadPage (hoteles) -- UNI-C gestion: dialogos en lugar de window.prompt y altas en FormDialog", () => {
  it("boveda: Bloquear y Solicitar purga piden el motivo (minimo 10) en un dialogo; Cancelar no escribe y confirmar manda el motivo", async () => {
    stubFetch();
    const prompt = vi.spyOn(window, "prompt");
    rendered = renderPage();
    await esperar();

    await clickButton(buttonByText("Bloquear"));
    await clickButton(botonDialogo("Cancelar"));
    expect(escrituras()).toHaveLength(0);

    await clickButton(buttonByText("Bloquear"));
    await escribirYConfirmar("corto", "Bloquear");
    expect(escrituras()).toHaveLength(0); // menos de 10 caracteres: el dialogo no deja continuar
    await escribirYConfirmar("Solicitud del titular por ARCO", "Bloquear");
    const bloqueo = escrituras()[0]!;
    expect(String(bloqueo[0])).toContain("/bloquear");
    expect(JSON.parse((bloqueo[1] as RequestInit).body as string)).toEqual({ motivo: "Solicitud del titular por ARCO" });

    await clickButton(buttonByText("Solicitar purga"));
    await escribirYConfirmar("Cancelacion ARCO del titular", "Solicitar purga");
    expect(escrituras().some(([u]) => String(u).endsWith("/solicitar-purga"))).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("privacidad > aviso: Publicar version nueva abre un dialogo y manda POST con las finalidades por linea", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await clickButton(buttonByText("Publicar versión nueva"));
    const campo = (id: string) => dialogo()!.querySelector(`#${id}`) as HTMLInputElement;
    changeValue(campo("aviso-version"), "v2");
    changeValue(campo("aviso-texto"), "Usamos tus datos para identificarte y facturar tu estancia.");
    changeValue(campo("aviso-obligatorias"), "identificar al huesped\nfacturacion");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const post = escrituras().find(([u]) => String(u).endsWith("/privacidad/avisos"))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ version: "v2", finalidadesObligatorias: ["identificar al huesped", "facturacion"], finalidadesOpcionales: [] });
    expect(toastMock.success).toHaveBeenCalledWith("Aviso publicado como versión vigente.", expect.anything());
  });

  it("privacidad > aviso: 'Usar plantilla base' solo llena el formulario (declara encargados y transferencias, con la etiqueta de revision legal) y NO publica nada", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await clickButton(buttonByText("Publicar versión nueva"));
    expect(dialogo()!.textContent).toContain("Requiere revisión legal");
    const escriturasAntes = escrituras().length;
    await clickButton(botonDialogo("Usar plantilla base"));
    const campo = (id: string) => dialogo()!.querySelector(`#${id}`) as HTMLInputElement;
    const texto = campo("aviso-texto").value;
    for (const proveedor of ["OpenRouter", "Meta / WhatsApp", "Google y LiveKit", "PAC", "Stripe", "Resend"]) expect(texto, proveedor).toContain(proveedor);
    expect(campo("aviso-obligatorias").value.split("\n").length).toBeGreaterThanOrEqual(2);
    expect(campo("aviso-opcionales").value).toContain("reseña");
    expect(dialogo()!.textContent).toContain("requiere revisión legal");
    // No se publica sola: ninguna escritura hasta que el hotel la revise y pulse "Publicar versión nueva".
    expect(escrituras().length).toBe(escriturasAntes);
    changeValue(campo("aviso-version"), "base-1");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const post = escrituras().find(([u]) => String(u).endsWith("/privacidad/avisos"))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ version: "base-1" });
    expect(JSON.parse((post[1] as RequestInit).body as string).textoSimplificado).toContain("OpenRouter");
  });

  it("privacidad > ARCO: registrar solicitud en dialogo; avanzar exige nota de 10+ caracteres y Cancelar no escribe", async () => {
    stubFetch({ arco: { disponible: true, hoy: "2026-03-24", items: [ARCO] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("ARCO");

    await clickButton(buttonByText("Registrar solicitud"));
    expect(botonDialogo("Registrar solicitud").disabled).toBe(true);
    changeValue(dialogo()!.querySelector("#arco-solicitante") as HTMLInputElement, "Juan Perez");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const alta = escrituras().find(([u]) => String(u).endsWith("/privacidad/arco"))!;
    expect(JSON.parse((alta[1] as RequestInit).body as string)).toMatchObject({ derecho: "acceso", solicitante: "Juan Perez", canal: "mostrador" });

    const antes = escrituras().length;
    await clickButton(buttonByText("Procedente"));
    await clickButton(botonDialogo("Cancelar"));
    expect(escrituras()).toHaveLength(antes);
    await clickButton(buttonByText("Procedente"));
    await escribirYConfirmar("corta", "Procedente");
    expect(escrituras()).toHaveLength(antes);
    await escribirYConfirmar("Identidad verificada en mostrador", "Procedente");
    const avanzar = escrituras().find(([u]) => String(u).endsWith("/arco/arco-1/avanzar"))!;
    expect(JSON.parse((avanzar[1] as RequestInit).body as string)).toEqual({ estado: "procedente", nota: "Identidad verificada en mostrador" });
  });

  it("privacidad > incidentes: cerrar un incidente con riesgo significativo pide nota y motivo de no notificar; cancelar en cualquier paso no escribe", async () => {
    stubFetch({ incidentes: { disponible: true, items: [INCIDENTE] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("Incidentes");
    await clickButton(buttonByText("Cerrar incidente"));
    await escribirYConfirmar("Se corrigio y se aviso al huesped", "Continuar");
    expect(dialogo()!.textContent).toContain("Motivo de no notificar");
    await clickButton(botonDialogo("Cancelar"));
    expect(escrituras()).toHaveLength(0);

    await clickButton(buttonByText("Cerrar incidente"));
    await escribirYConfirmar("Se corrigio y se aviso al huesped", "Continuar");
    await escribirYConfirmar("El titular ya fue avisado por telefono", "Cerrar incidente");
    const post = escrituras().find(([u]) => String(u).endsWith("/incidentes/inc-1/accion"))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ accion: "cerrar", nota: "Se corrigio y se aviso al huesped", motivoNoNotificar: "El titular ya fue avisado por telefono" });
  });

  it("privacidad > retencion: Liberar retencion pide nota y Cancelar no escribe", async () => {
    stubFetch({ retenciones: { disponible: true, items: [RETENCION] } });
    rendered = renderPage();
    await esperar();
    await openTab("Privacidad");
    await openTab("Retención y bloqueo");
    await clickButton(buttonByText("Liberar retención"));
    await clickButton(botonDialogo("Cancelar"));
    expect(escrituras()).toHaveLength(0);
    await clickButton(buttonByText("Liberar retención"));
    await escribirYConfirmar("Caso cerrado por la autoridad", "Liberar retención");
    expect(escrituras().some(([u]) => String(u).endsWith("/retenciones/hold-1/liberar"))).toBe(true);
  });
});
