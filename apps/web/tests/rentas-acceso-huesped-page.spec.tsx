// @vitest-environment jsdom
//
// Smoke tests reales de <AccesoHuespedPage /> (Rn-04): gate de rol, base sin migrar,
// política/reservas/bitácora y marcar pago.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccesoHuespedPage } from "../src/verticals/rentas/pages/AccesoHuesped.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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

const PENDIENTE = { reserva_id: "r9", unidad_id: "u1", unidad_nombre: "Casa del mar", canal: "airbnb", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: null, omitida_en: "2027-03-09T10:10:00Z" };
const CONFIG = { disponible: true, enlace_publico: "https://app.atiende.ai/rentas/precheckin/prop-1", texto_sugerido: "Hola, completa tu pre-check-in:\nhttps://app.atiende.ai/rentas/precheckin/prop-1", reglamento: "No fiestas.", reglamento_version: 2 };
const MENSAJE = "Hola,\n\nDireccion: Calle 60 #123\nCodigo de acceso: 9137";

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
    if (url.endsWith("/acceso-huesped/pendientes")) return json({ disponible, pendientes: disponible ? [PENDIENTE] : [] });
    if (url.endsWith("/acceso-huesped/precheckin")) return json(disponible ? CONFIG : { disponible: false, enlace_publico: null, texto_sugerido: null, reglamento: null, reglamento_version: 1 });
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

const botonPorTexto = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogoConfirmacion = () => document.body.querySelector('[role="alertdialog"]');

function instalarPortapapeles(escribir: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(escribir) }, configurable: true });
  return (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
}

describe("AccesoHuespedPage -- Rn-P3-09 pendientes de entregar", () => {
  it("lista la reserva omitida; «Copiar mensaje para la OTA» lee el mensaje descifrado (GET) y lo copia, sin escribir nada en el servidor", async () => {
    const { fn, llamadas } = red(true, (url) => (url.endsWith("/reservas/r9/acceso-mensaje") ? json({ disponible: true, mensaje: MENSAJE }) : undefined));
    vi.stubGlobal("fetch", fn);
    const copiar = instalarPortapapeles(async () => undefined);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Pendientes de entregar (1)");
    expect(rendered.container.textContent).toContain("Casa del mar");
    await act(async () => {
      click(botonPorTexto("Copiar mensaje para la OTA")!);
      await flushMicrotasks();
    });
    await esperar();
    expect(copiar).toHaveBeenCalledWith(MENSAJE);
    expect(rendered.container.textContent).toContain("Mensaje copiado");
    expect(llamadas.filter((l) => l.method !== "GET")).toEqual([]);
    // El mensaje (con el codigo) no queda pintado en pantalla cuando el portapapeles funciono.
    expect(rendered.container.textContent).not.toContain("9137");
  });

  it("si el navegador no deja copiar, muestra el mensaje para copiarlo a mano y se descarta al cerrar", async () => {
    vi.stubGlobal("fetch", red(true, (url) => (url.endsWith("/reservas/r9/acceso-mensaje") ? json({ disponible: true, mensaje: MENSAJE }) : undefined)).fn);
    instalarPortapapeles(async () => {
      throw new Error("denegado");
    });
    rendered = montar("admin_gestora");
    await esperar();
    await act(async () => {
      click(botonPorTexto("Copiar mensaje para la OTA")!);
      await flushMicrotasks();
    });
    await esperar();
    const area = rendered.container.querySelector("textarea[readonly]") as HTMLTextAreaElement;
    expect(area.value).toBe(MENSAJE);
    click(botonPorTexto("Cerrar")!);
    await esperar();
    expect(rendered.container.textContent).not.toContain("9137");
  });

  it("«Marcar como entregado por la OTA»: CANCELAR no llama al servidor; confirmar hace POST entrega-manual y recarga", async () => {
    const { fn, llamadas } = red(true, (url, init) => (init?.method === "POST" && url.endsWith("/reservas/r9/entrega-manual") ? json({ reserva_id: "r9", entregada: true, nueva: true }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPorTexto("Marcar como entregado por la OTA")!);
    await esperar();
    expect(dialogoConfirmacion()).not.toBeNull();
    click([...dialogoConfirmacion()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancelar"))!);
    await esperar();
    expect(llamadas.filter((l) => l.method === "POST")).toEqual([]);

    click(botonPorTexto("Marcar como entregado por la OTA")!);
    await esperar();
    await act(async () => {
      click([...dialogoConfirmacion()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar como entregado") && !b.textContent.includes("OTA"))!);
      await flushMicrotasks();
    });
    await esperar();
    expect(llamadas.filter((l) => l.method === "POST").map((l) => l.url)).toEqual(["http://api.local/rentas/prop-1/reservas/r9/entrega-manual"]);
    expect(rendered.container.textContent).toContain("Acceso marcado como entregado.");
  });

  it("sin pendientes explica el vacio; contra la base sin la migracion 036 dice que no esta disponible", async () => {
    const base = red(true, (url) => (url.endsWith("/acceso-huesped/pendientes") ? json({ disponible: true, pendientes: [] }) : undefined));
    vi.stubGlobal("fetch", base.fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Nada pendiente");
    rendered.unmount();
    vi.stubGlobal("fetch", red(true, (url) => (url.endsWith("/acceso-huesped/pendientes") ? json({ disponible: false, pendientes: [] }) : url.endsWith("/acceso-huesped/precheckin") ? json({ disponible: false, enlace_publico: null, texto_sugerido: null, reglamento: null, reglamento_version: 1 }) : undefined)).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect((rendered.container.textContent?.match(/Aún no disponible/g) ?? []).length).toBe(2);
    expect(botonPorTexto("Copiar mensaje para la OTA")).toBeUndefined();
  });
});

describe("AccesoHuespedPage -- Rn-P3-08 enlace de pre-check-in y reglamento", () => {
  it("muestra el enlace fijo y el texto sugerido, los copia y guarda el reglamento con PUT", async () => {
    const { fn, llamadas } = red(true, (url, init) => (init?.method === "PUT" && url.endsWith("/acceso-huesped/precheckin") ? json({ ...CONFIG, reglamento: "Sin mascotas.", reglamento_version: 3 }) : undefined));
    vi.stubGlobal("fetch", fn);
    const copiar = instalarPortapapeles(async () => undefined);
    rendered = montar("admin_gestora");
    await esperar();
    const enlace = rendered.container.querySelector('input[readonly]') as HTMLInputElement;
    expect(enlace.value).toBe(CONFIG.enlace_publico);
    await act(async () => {
      click(botonPorTexto("Copiar enlace")!);
      await flushMicrotasks();
    });
    await esperar();
    expect(copiar).toHaveBeenCalledWith(CONFIG.enlace_publico);
    await act(async () => {
      click(botonPorTexto("Copiar texto sugerido")!);
      await flushMicrotasks();
    });
    await esperar();
    expect(copiar).toHaveBeenCalledWith(CONFIG.texto_sugerido);

    const area = [...rendered.container.querySelectorAll("textarea")].find((t) => t.value === "No fiestas.") as HTMLTextAreaElement;
    changeValue(area, "Sin mascotas.");
    await submitForm(area.closest("form")!);
    await esperar();
    const put = llamadas.find((l) => l.method === "PUT" && l.url.endsWith("/acceso-huesped/precheckin"));
    expect(put).toBeDefined();
    expect(rendered.container.textContent).toContain("Reglamento guardado.");
  });
});
