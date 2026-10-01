// @vitest-environment jsdom
//
// Smoke tests reales de <AccesoHuespedPage /> (Rn-04): gate de rol, base sin migrar,
// política/reservas/bitácora y marcar pago.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccesoHuespedPage } from "../src/verticals/rentas/pages/AccesoHuesped.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}
const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const montar = (rol: string) => renderComponent(<AccesoHuespedPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);

function red(disponible = true, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET" });
    const c = extra(url, init);
    if (c) return c;
    if (url.endsWith("/acceso-huesped/politica")) return json({ disponible, configurada: disponible, politica: disponible ? { activo: true, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: true } : null });
    if (url.endsWith("/unidades")) return json({ unidades: [{ id: "u1", nombre: "Casa del mar", duracionMinimaNoches: 1 }] });
    if (url.endsWith("/acceso-huesped/reservas")) return json({ disponible, reservas: disponible ? [{ reserva_id: "r1", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "manual", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: "Ana", pago_confirmado: false, liberada: false }] : [] });
    if (url.includes("/acceso-huesped/bitacora")) return json({ disponible, eventos: disponible ? [{ id: "e1", reserva_id: "abcdef12-0000", evento: "omitida_sin_contacto", canal: null, creado_en: "2026-10-01T10:00:00Z" }] : [] });
    throw new Error(`url inesperada: ${url}`);
  });
  return { fn, llamadas };
}

describe("AccesoHuespedPage", () => {
  it("el admin ve la política, las reservas y la bitácora; Marcar pagada hace POST y recarga", async () => {
    const { fn, llamadas } = red(true, (url, init) => (init?.method === "POST" && url.endsWith("/pago-confirmado") ? json({ reserva_id: "r1", pago_confirmado: true }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Política de liberación");
    expect(texto).toContain("Casa del mar");
    expect(texto).toContain("Sin pago confirmado");
    expect(texto).toContain("No enviada: sin correo del huésped");
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar pagada"))!;
    await act(async () => {
      click(boton);
      await flushMicrotasks();
    });
    await esperar();
    expect(llamadas.some((l) => l.method === "POST" && l.url === "http://api.local/rentas/prop-1/reservas/r1/pago-confirmado")).toBe(true);
    expect(rendered.container.textContent).toContain("Pago confirmado.");
  });

  it("contra la base sin la migración 025 explica que aún no está disponible", async () => {
    vi.stubGlobal("fetch", red(false).fn);
    rendered = montar("operador:acceso_total");
    await esperar();
    expect(rendered.container.textContent).toContain("Aún no disponible");
    expect(rendered.container.textContent).not.toContain("Política de liberación");
  });

  it("un rol sin acceso no pide nada y lo explica", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("contador");
    await esperar();
    expect(fn).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("no tiene acceso a esta sección");
  });
});
