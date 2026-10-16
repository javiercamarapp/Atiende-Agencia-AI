// @vitest-environment jsdom
//
// Campanas de reactivacion (autopiloto 2): <CampanasPage /> contra el contrato real de admin-marketing.ts con `fetch` mockeado por ruta.
// Se afirma: estados de carga/vacio/error/no disponible, que SOLO owner/admin la ven, requisitos honestos ("requiere X", nunca fingidos),
// el costo estimado ANTES de aprobar, que aprobar llama POST .../decidir {accion:"aprobar"} solo tras confirmar y rechazar no envia nada, que
// el mensaje 'requiere X' del servidor se muestra, y que guardar la configuracion manda centavos enteros. Sin telefonos ni nombres en pantalla.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampanasPage } from "../src/verticals/restaurantes/pages/Campanas.tsx";
import { recompraIncremental } from "../src/verticals/restaurantes/lib/marketing-client.ts";
import type { CampanaMarketing, ConfigMarketing } from "../src/verticals/restaurantes/lib/marketing-client.ts";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function respuesta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Manager Demo", staffEmail: "manager@example.com" };
const URL_PANEL = "https://api.test/v1/restaurantes/prop-1/admin/marketing";

const CONFIG: ConfigMarketing = { activo: true, tarifaCentavos: 80, topeMensualCentavos: null, minimoSegmento: 10, plantillaNombre: "reactivacion_promo", plantillaIdioma: "es_MX", hayPromocionVigente: true, plantillaAprobada: true, whatsappConectado: true, gastadoMesCentavos: 0, consentimientosVigentes: 40 };
const BORRADOR: CampanaMarketing = { id: "camp-1", segmento: "inactivo_30", estado: "borrador", conteo: 23, conteoControl: 2, costoEstimadoCentavos: 1840, promoNombre: "Vuelve con 10 por ciento", promoCodigo: "VUELVE10", creadaAt: "2026-10-04T14:00:00.000Z", decididaAt: null, encolados: null, enviados: 0, recompraTratados: 0, recompraControl: 0, ingresoTratados: 0, ventanaCerrada: false };
const APROBADA: CampanaMarketing = { ...BORRADOR, id: "camp-2", segmento: "inactivo_60", estado: "aprobada", encolados: 21, decididaAt: "2026-09-20T15:00:00.000Z", enviados: 21, recompraTratados: 4, recompraControl: 0, ingresoTratados: 1250, ventanaCerrada: true };

interface Manejadores {
  panel?: () => Response;
  decidir?: (accion: string) => Response;
  guardar?: () => Response;
}

function stubFetch(m: Manejadores) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === URL_PANEL) return (m.panel ?? (() => respuesta({ disponible: true, config: CONFIG, campanas: [BORRADOR, APROBADA] })))();
    if (method === "POST" && url.includes("/campanas/") && url.endsWith("/decidir")) return (m.decidir ?? (() => respuesta({ estado: "aprobada", encolados: 21, control: 2 })))(JSON.parse(init!.body as string).accion);
    if (method === "PUT" && url === `${URL_PANEL}/config`) return (m.guardar ?? (() => respuesta({ disponible: true, config: CONFIG })))();
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T => rendered!.container.querySelector<T>(sel)!;
const dialogo = (): HTMLElement | null => document.body.querySelector('[role="alertdialog"]');
const llamadas = (metodo: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === metodo);

async function pulsarEnDialogo(texto: string): Promise<void> {
  const boton = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  await act(async () => {
    boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

describe("CampanasPage (restaurantes)", () => {
  it("muestra la carga primero y luego los requisitos reales, el borrador por aprobar y la campana aprobada con su recompra incremental", async () => {
    stubFetch({});
    rendered = renderComponent(<CampanasPage {...CTX} />);
    expect(rendered.container.textContent).toContain("Cargando campañas");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Con consentimiento");
    expect(texto).toContain("30 a 59 días sin pedir");
    expect(texto).toContain("Vuelve con 10 por ciento (VUELVE10)");
    expect(texto).toContain("$18.40 MXN"); // costo estimado visible ANTES de aprobar
    expect(texto).toContain("Por aprobar");
    // 4 de 21 recompraron con mensaje, 0 de 2 sin mensaje: +19 puntos incrementales (4/21 - 0/2).
    expect(q('[data-testid="resultado-camp-2"]').textContent).toContain("Incremental: +19 puntos");
    expect(rendered.container.querySelectorAll('[data-requisito="ok"]')).toHaveLength(5);
    expect(texto).not.toMatch(/\+52|@/);
  });

  it("requisitos faltantes se dicen como 'requiere X' (nunca se finge que funciona)", async () => {
    stubFetch({ panel: () => respuesta({ disponible: true, config: { ...CONFIG, tarifaCentavos: null, plantillaAprobada: false, whatsappConectado: false, hayPromocionVigente: false, activo: false }, campanas: [] }) });
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(rendered.container.querySelectorAll('[data-requisito="falta"]')).toHaveLength(5);
    expect(texto).toContain("Requiere una promoción vigente");
    expect(texto).toContain("Requiere la tarifa por mensaje");
    expect(texto).toContain("Requiere una plantilla de marketing aprobada por Meta");
    expect(texto).toContain("Requiere WhatsApp conectado");
    expect(texto).toContain("Sin campañas");
  });

  it("base sin migrar (503 / disponible:false): estado honesto, sin botones", async () => {
    stubFetch({ panel: () => respuesta({}, 503) });
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Campañas no disponibles todavía");
    expect(rendered.container.querySelector("button")).toBeNull();
  });

  it("error real del servidor: mensaje y reintentar, nunca se queda en 'Cargando'", async () => {
    stubFetch({ panel: () => respuesta({ message: "falla" }, 500) });
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Cargando campañas");
    expect(rendered.container.textContent).toContain("falla");
  });

  it("un rol que no es owner/admin NO consulta nada y ve un aviso", async () => {
    stubFetch({});
    rendered = renderComponent(<CampanasPage {...CTX} role="staff" />);
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Solo los roles");
  });

  it("aprobar pide confirmacion con el costo estimado y SOLO tras confirmar llama POST .../decidir {accion: aprobar}", async () => {
    stubFetch({});
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    click(q('button[aria-label="Aprobar la campaña de 30 a 59 días sin pedir"]'));
    await esperar();
    expect(dialogo()!.textContent).toContain("$18.40 MXN");
    expect(dialogo()!.textContent).toContain("23 clientes");
    expect(llamadas("POST")).toHaveLength(0);
    await pulsarEnDialogo("Volver");
    expect(llamadas("POST")).toHaveLength(0);

    click(q('button[aria-label="Aprobar la campaña de 30 a 59 días sin pedir"]'));
    await esperar();
    await pulsarEnDialogo("Aprobar y enviar");
    const post = llamadas("POST");
    expect(post).toHaveLength(1);
    expect(post[0]![0]).toBe(`${URL_PANEL}/campanas/camp-1/decidir`);
    expect(JSON.parse((post[0]![1] as RequestInit).body as string)).toEqual({ accion: "aprobar" });
    // Recarga la lista tras decidir (carga inicial + recarga).
    expect(fetchMock.mock.calls.filter(([url, init]) => url === URL_PANEL && (init as RequestInit).method === "GET")).toHaveLength(2);
  });

  it("rechazar no pide confirmar y llama POST .../decidir {accion: rechazar}: no se envia nada", async () => {
    stubFetch({ decidir: () => respuesta({ estado: "rechazada", encolados: 0, control: 0 }) });
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    click(q('button[aria-label="Rechazar la campaña de 30 a 59 días sin pedir"]'));
    await esperar();
    const post = llamadas("POST");
    expect(post).toHaveLength(1);
    expect(JSON.parse((post[0]![1] as RequestInit).body as string)).toEqual({ accion: "rechazar" });
  });

  it("si el servidor responde 'requiere X' (409) la campana sigue por aprobar y la pagina no se rompe", async () => {
    stubFetch({ decidir: () => respuesta({ code: "conflict", message: "Requiere una plantilla de marketing aprobada por Meta antes de enviar." }, 409) });
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    click(q('button[aria-label="Aprobar la campaña de 30 a 59 días sin pedir"]'));
    await esperar();
    await pulsarEnDialogo("Aprobar y enviar");
    expect(llamadas("POST")).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Por aprobar");
  });

  it("guardar la configuracion manda centavos enteros (tarifa y tope) y valida antes de llamar", async () => {
    stubFetch({});
    rendered = renderComponent(<CampanasPage {...CTX} />);
    await esperar();
    const form = q<HTMLFormElement>('[data-testid="campanas-config"]');
    const campo = (label: string) => form.querySelector<HTMLInputElement>(`#${(Array.from(form.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement).htmlFor}`)!;
    act(() => changeValue(campo("Tarifa por mensaje"), "abc"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(llamadas("PUT")).toHaveLength(0);
    expect(form.textContent).toContain("La tarifa por mensaje debe ser un monto en pesos");

    act(() => changeValue(campo("Tarifa por mensaje"), "0.95"));
    act(() => changeValue(campo("Tope mensual"), "1,500"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const put = llamadas("PUT");
    expect(put).toHaveLength(1);
    expect(JSON.parse((put[0]![1] as RequestInit).body as string)).toEqual({ activo: true, tarifaCentavos: 95, topeMensualCentavos: 150000, minimoSegmento: 10, plantillaNombre: "reactivacion_promo", plantillaIdioma: "es_MX" });
  });
});

describe("recompraIncremental", () => {
  const base = { estado: "aprobada" as const, encolados: 20, conteoControl: 2, recompraTratados: 4, recompraControl: 1, ventanaCerrada: true };
  it("tasa de tratados menos tasa del control, en puntos, con un decimal", () => {
    expect(recompraIncremental(base)).toBe(-30); // 20 % menos 50 %: el control recompro mas
    expect(recompraIncremental({ ...base, recompraControl: 0 })).toBe(20);
  });
  it("sin comparacion valida no hay numero: ventana abierta, sin control, sin envios o no aprobada", () => {
    expect(recompraIncremental({ ...base, ventanaCerrada: false })).toBeNull();
    expect(recompraIncremental({ ...base, conteoControl: 0 })).toBeNull();
    expect(recompraIncremental({ ...base, encolados: 0 })).toBeNull();
    expect(recompraIncremental({ ...base, estado: "borrador" })).toBeNull();
  });
});
