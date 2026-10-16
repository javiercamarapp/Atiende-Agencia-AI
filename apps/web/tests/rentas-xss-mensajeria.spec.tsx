// @vitest-environment jsdom
//
// Rn-P3-13 (adversarial, XSS) -- el texto que controla el huesped (borradores, nombre del huesped, motivo de rechazo) se pinta SIEMPRE como
// texto en la bandeja de Aprobaciones: nunca crea elementos <script>/<img>/<svg>, atributos de evento ni ejecuta codigo. Equivalente del
// `xss-mensajeria.adversarial.test.tsx` del original.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AprobacionesPage } from "../src/verticals/rentas/pages/Aprobaciones.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__xss;
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

const PAYLOADS = {
  script: "<script>globalThis.__xss = 'script'</script>",
  img: "<img src=x onerror=\"globalThis.__xss='img'\">",
  svg: "<svg onload=\"globalThis.__xss='svg'\"></svg>",
  enlace: "<a href=\"javascript:globalThis.__xss='a'\">clic</a>",
  iframe: "<iframe srcdoc=\"<script>parent.__xss='iframe'</script>\"></iframe>",
};

const res = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const base = { conversacionId: "c1", mensajeEntranteId: null, canal: "airbnb", generadoPor: "agente_llm", redactado: true, aprobadoPor: null, aprobadoEn: null, rechazadoPor: null, rechazadoEn: null, mensajeEnviadoId: null, creadoEn: "2026-10-01T10:00:00Z", actualizadoEn: "2026-10-01T10:00:00Z" };
const PENDIENTE = { ...base, id: "b1", texto: `Hola ${PAYLOADS.script} ${PAYLOADS.img} ${PAYLOADS.svg} ${PAYLOADS.enlace} ${PAYLOADS.iframe}`, estado: "pendiente_aprobacion", motivoRechazo: null };
const RECHAZADO = { ...base, id: "b2", texto: PAYLOADS.img, estado: "rechazado", rechazadoPor: "u1", rechazadoEn: "2026-10-01T11:00:00Z", motivoRechazo: PAYLOADS.script };
const CONVERSACION = { id: "c1", organizationId: "org-1", propertyId: "prop-1", unidadId: "u1", canal: "airbnb", ocupacionId: null, huespedMinimoId: null, propiedadNombre: PAYLOADS.svg, huespedNombre: PAYLOADS.img, fechaCheckIn: null, fechaCheckOut: null, reservaConfirmada: false, creadoEn: "2026-10-01T09:00:00Z" };

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

async function abrir(): Promise<RenderedComponent> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/unidades")) return res({ unidades: [{ id: "u1", name: "Depa 101", nombre: "Depa 101" }] });
      if (url.endsWith("/unidades/u1/conversaciones")) return res({ conversaciones: [CONVERSACION] });
      if (url.endsWith("/conversaciones/c1/borradores")) return res({ borradores: [PENDIENTE, RECHAZADO] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
  const r = renderComponent(<MemoryRouter><AprobacionesPage {...CTX} /></MemoryRouter>);
  await esperar();
  const verHistorial = [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Ver historial"));
  if (verHistorial) {
    click(verHistorial);
    await esperar();
  }
  return r;
}

describe("Aprobaciones -- texto del huesped con HTML/JS hostil", () => {
  it("se muestra como texto literal: ningun elemento peligroso en el DOM", async () => {
    rendered = await abrir();
    const dom = rendered.container;
    expect(dom.querySelector("script")).toBeNull();
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("svg[onload]")).toBeNull();
    expect(dom.querySelector("iframe")).toBeNull();
    expect(dom.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(dom.querySelector("[onerror], [onload], [onclick]")).toBeNull();
  });

  it("el payload aparece escapado como texto visible (no se pierde ni se interpreta)", async () => {
    rendered = await abrir();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain(PAYLOADS.script);
    expect(texto).toContain(PAYLOADS.img);
    expect(texto).toContain(PAYLOADS.enlace);
  });

  it("el historial expandido (borrador rechazado y su motivo) tambien escapa el contenido", async () => {
    rendered = await abrir();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain(`Motivo: ${PAYLOADS.script}`);
    expect(rendered.container.querySelectorAll("script")).toHaveLength(0);
  });

  it("ningun payload se ejecuto", async () => {
    rendered = await abrir();
    expect((globalThis as Record<string, unknown>).__xss).toBeUndefined();
  });
});
