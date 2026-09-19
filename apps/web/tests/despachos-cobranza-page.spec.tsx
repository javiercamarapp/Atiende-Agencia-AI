// @vitest-environment jsdom
//
// Smoke tests reales de <CobranzaPage /> (despachos — cartera por antigüedad,
// score de cobrabilidad y recordatorios reales por correo; cierra el hallazgo de
// auditoría ALTA "cobranza tiene motor completo pero cero UI"). Mismo patrón que
// despachos-cierre-mensual-page.spec.tsx: `fetch` global mockeado por ruta real
// contra cobranza-client.ts/cfdi-client.ts, estados de carga/vacío/error, datos
// reales (monto en pesos formateado, antigüedad, score), y la interacción
// principal (marcar cuenta pagada y enviar recordatorio) verificando método/ruta/
// cuerpo reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CobranzaPage } from "../src/verticals/despachos/pages/Cobranza.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { CuentaCobranza } from "../src/verticals/despachos/lib/cobranza-client.ts";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

const CUENTA: CuentaCobranza = {
  id: "cta-1",
  invoiceId: "inv-1",
  facturaId: "ABCDEFGH-1234-5678",
  monto: 11600,
  fechaVencimiento: "2026-08-15",
  diasVencido: 35,
  bucket: "31-60",
  score: 0.55,
  clienteNombre: "Cliente Demo SA",
  clienteEmail: "cliente@example.com",
  montoPagado: null,
  pagadoEn: null,
  creadoEn: "2026-08-01T00:00:00.000Z",
};

const RESUMEN = {
  totalCartera: 11600,
  totalCount: 1,
  totalEsperado: 6000,
  tasaRecuperacionEsperada: 55,
  porAntiguedad: {
    "0-30": { count: 0, monto: 0, porcentaje: 0 },
    "31-60": { count: 1, monto: 11600, porcentaje: 100 },
    "61-90": { count: 0, monto: 0, porcentaje: 0 },
    "90+": { count: 0, monto: 0, porcentaje: 0 },
  },
  alertas: [],
  topMontos: [],
};

interface Handlers {
  cuentas?: readonly (typeof CUENTA)[] | (() => readonly (typeof CUENTA)[]);
  cuentasOk?: boolean;
  resumen?: typeof RESUMEN;
  invoices?: unknown[];
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/cobranza/resumen")) return jsonResponse(handlers.resumen ?? RESUMEN);
    if (method === "GET" && url.includes("/cfdi")) return jsonResponse(handlers.invoices ?? []);
    if (method === "GET" && url.includes("/cobranza/cuentas")) {
      const list = typeof handlers.cuentas === "function" ? handlers.cuentas() : (handlers.cuentas ?? []);
      return jsonResponse(list, handlers.cuentasOk ?? true);
    }
    // Mediodía UTC (no medianoche) -- evita que `formatDate` (sin `timeZone`,
    // usa la zona de la máquina que corre el test) pinte un día distinto según
    // dónde corra: medianoche UTC cae en "18 sep" en zonas al oeste de UTC
    // (America/Mexico_City) pero en "19 sep" en UTC/Europe/Madrid, así que
    // `npm run test:unit` solo pasaba en la Mac del autor (CST). Verificado con
    // node: 18:00Z es "19 sep 2026" en UTC, Europe/Madrid (UTC+2) y
    // America/Mexico_City (UTC-6) por igual.
    if (method === "POST" && url.endsWith("/pagar")) return jsonResponse({ ...CUENTA, pagadoEn: "2026-09-19T18:00:00.000Z" });
    if (method === "POST" && url.endsWith("/recordatorio")) return jsonResponse({ etapa: "recordatorio_formal", diasVencido: 35, enviado: true, motivo: null });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<CobranzaPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CobranzaPage (despachos)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ cuentas: [] });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando cobranza");
  });

  it("estado vacío explícito (solo pendientes, por default) — nunca un error", async () => {
    stubFetch({ cuentas: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay cuentas por cobrar pendientes");
  });

  it("estado de error real cuando el fetch de cuentas falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ cuentas: [], cuentasOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando cobranza");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("renderiza una cuenta real: monto en pesos formateado (nunca el entero crudo), cliente y días de atraso", async () => {
    stubFetch({ cuentas: [CUENTA] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("$11,600.00");
    expect(text).toContain("Cliente Demo SA");
    expect(text).toContain("35 días de atraso");
    expect(text).toContain("31-60 días");
  });

  it("el resumen ejecutivo muestra la cartera total y la tasa de recuperación esperada reales", async () => {
    stubFetch({ cuentas: [CUENTA] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("$11,600.00");
    expect(text).toContain("55% tasa esperada");
  });

  it("'Marcar pagada' llama POST .../cobranza/cuentas/cta-1/pagar con el monto real y recarga", async () => {
    let current: readonly (typeof CUENTA)[] = [CUENTA];
    stubFetch({ cuentas: () => current });
    rendered = renderPage();
    await esperarCarga();

    const pagarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar pagada"))!;
    current = [{ ...CUENTA, pagadoEn: "2026-09-19T18:00:00.000Z" }]; // ver nota de zona horaria arriba
    await act(async () => {
      pagarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/despachos/prop-1/cobranza/cuentas/cta-1/pagar" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ montoPagado: 11600 });
    // Tras recargar, la cuenta ya viene con `pagadoEn` real -- el badge cambia a
    // "Pagada" y sus acciones (incluido el mensaje transitorio) desaparecen, mismo
    // criterio que el componente: una cuenta pagada no ofrece "marcar pagada" de
    // nuevo.
    expect(rendered.container.textContent).toContain("Pagada 19 sep 2026");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Marcar pagada"))).toBe(false);
  });

  it("'Enviar recordatorio' con etapa elegida llama POST .../recordatorio con {stage} real", async () => {
    stubFetch({ cuentas: [CUENTA] });
    rendered = renderPage();
    await esperarCarga();

    changeValue(rendered.container.querySelector("#cobranza-etapa-cta-1") as HTMLSelectElement, "segundo_recordatorio");
    const enviarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enviar recordatorio"))!;
    await act(async () => {
      enviarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/despachos/prop-1/cobranza/cuentas/cta-1/recordatorio" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ stage: "segundo_recordatorio" });
    expect(rendered.container.textContent).toContain("Recordatorio enviado");
  });

  it("recordatorio sin correo de contacto: muestra el mensaje honesto de 'evento registrado', no lo confunde con éxito", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/cobranza/resumen")) return jsonResponse(RESUMEN);
      if (method === "GET" && url.includes("/cfdi")) return jsonResponse([]);
      if (method === "GET" && url.includes("/cobranza/cuentas")) return jsonResponse([CUENTA]);
      if (method === "POST" && url.endsWith("/recordatorio")) return jsonResponse({ etapa: "recordatorio_formal", diasVencido: 35, enviado: false, motivo: "no_email" });
      throw new Error(`fetch inesperado: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    const enviarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enviar recordatorio"))!;
    await act(async () => {
      enviarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(rendered.container.textContent).toContain("no tiene correo de contacto capturado");
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("no tiene correo de contacto capturado");
  });
});
