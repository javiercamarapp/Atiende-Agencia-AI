// @vitest-environment jsdom
//
// D-30 -- step-up (segundo factor) en las acciones sensibles del panel de despachos: orquestacion (`conStepUp`), dialogo y
// cableado en los clientes. Garantias: Cancelar NUNCA ejecuta la accion; sin TOTP dado de alta no hay bypass; con la base sin
// migrar (2FA no disponible) la accion sigue su camino de siempre; el token viaja en `x-step-up-token` con alcance `despachos_sensitive`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { StepUpDialog } from "../src/verticals/despachos/components/StepUpDialog.tsx";
import { StepUpCanceladoError, StepUpSinEnrolarError, conStepUp, registrarStepUpPrompter } from "../src/verticals/despachos/lib/step-up.ts";
import { crearPortalEnlace } from "../src/verticals/despachos/lib/portal-cliente-client.ts";
import { cerrarPeriodoCierre } from "../src/verticals/despachos/lib/cierre-mensual-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm } from "./test-utils/render.tsx";
import type { RenderedComponent } from "./test-utils/render.tsx";

const API = "http://api.local";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ESTADO = { enabled: { available: true, enabled: true, pending: false, lockedUntil: null, backupCodesRemaining: 8 }, sinAlta: { available: true, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 }, noDisponible: { available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 } };

function fetchConEstado(estado: unknown, resto: (url: string, init?: RequestInit) => Response = () => json({}, 200)) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/2fa/status")) return json(estado);
    return resto(url, init);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const llamadasA = (f: ReturnType<typeof vi.fn>, sufijo: string) => f.mock.calls.filter((c) => String(c[0]).endsWith(sufijo));

let rendered: RenderedComponent | undefined;
beforeEach(() => registrarStepUpPrompter(null));
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  registrarStepUpPrompter(null);
  document.body.innerHTML = "";
});

describe("conStepUp", () => {
  it("2FA no disponible (base sin migrar): ejecuta la accion sin pedir codigo ni header", async () => {
    const prompter = vi.fn();
    registrarStepUpPrompter(prompter);
    const accion = vi.fn(async (h: Record<string, string>) => h);
    const out = await conStepUp({ fetchImpl: fetchConEstado(ESTADO.noDisponible), apiBaseUrl: API, token: "t" }, accion);
    expect(out).toEqual({});
    expect(prompter).not.toHaveBeenCalled();
  });

  it("2FA activo: pide el codigo y ejecuta la accion con x-step-up-token", async () => {
    registrarStepUpPrompter(async (s) => {
      expect(s.enrolado).toBe(true);
      return "tok-stepup";
    });
    const accion = vi.fn(async (h: Record<string, string>) => h);
    expect(await conStepUp({ fetchImpl: fetchConEstado(ESTADO.enabled), apiBaseUrl: API, token: "t" }, accion)).toEqual({ "x-step-up-token": "tok-stepup" });
  });

  it("Cancelar rechaza y la accion NO se ejecuta", async () => {
    registrarStepUpPrompter(async () => {
      throw new StepUpCanceladoError();
    });
    const accion = vi.fn(async () => "hecho");
    await expect(conStepUp({ fetchImpl: fetchConEstado(ESTADO.enabled), apiBaseUrl: API, token: "t" }, accion)).rejects.toBeInstanceOf(StepUpCanceladoError);
    expect(accion).not.toHaveBeenCalled();
  });

  it("sin TOTP dado de alta: el dialogo informa (enrolado=false) y la accion NO se ejecuta (sin bypass)", async () => {
    const prompter = vi.fn(async () => {
      throw new StepUpSinEnrolarError();
    });
    registrarStepUpPrompter(prompter);
    const accion = vi.fn(async () => "hecho");
    await expect(conStepUp({ fetchImpl: fetchConEstado(ESTADO.sinAlta), apiBaseUrl: API, token: "t" }, accion)).rejects.toBeInstanceOf(StepUpSinEnrolarError);
    expect(prompter).toHaveBeenCalledWith(expect.objectContaining({ enrolado: false }));
    expect(accion).not.toHaveBeenCalled();
  });

  it("2FA activo pero sin dialogo montado: no ejecuta la accion", async () => {
    const accion = vi.fn(async () => "hecho");
    await expect(conStepUp({ fetchImpl: fetchConEstado(ESTADO.enabled), apiBaseUrl: API, token: "t" }, accion)).rejects.toThrow(/verificación/);
    expect(accion).not.toHaveBeenCalled();
  });
});

describe("clientes de acciones sensibles", () => {
  it("crear enlace del portal: manda x-step-up-token y el token pedido con el alcance despachos_sensitive", async () => {
    registrarStepUpPrompter(async () => "tok-abc");
    const f = fetchConEstado(ESTADO.enabled, () => json({ id: "e1", etiqueta: "x", expiraEn: "2026-11-01", url: "u" }, 201));
    await crearPortalEnlace(f, API, "t", "p1", "Cliente", 7);
    const crear = llamadasA(f as never, "/portal-cliente/enlaces")[0]!;
    expect((crear[1] as RequestInit).headers).toMatchObject({ "x-step-up-token": "tok-abc" });
  });

  it("cerrar periodo cancelado: ninguna llamada a /cerrar", async () => {
    registrarStepUpPrompter(async () => {
      throw new StepUpCanceladoError();
    });
    const f = fetchConEstado(ESTADO.enabled);
    await expect(cerrarPeriodoCierre(f, API, "t", "p1", "per1", "2026-09")).rejects.toBeInstanceOf(StepUpCanceladoError);
    expect(llamadasA(f as never, "/cerrar")).toHaveLength(0);
  });
});

describe("StepUpDialog", () => {
  const montar = () => (rendered = renderComponent(<MemoryRouter><StepUpDialog orgSlug="mi-despacho" /></MemoryRouter>));
  const dialogo = () => document.body.querySelector('[role="dialog"]');
  const botonPorTexto = (t: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === t) as HTMLButtonElement;

  it("Cancelar cierra el dialogo y rechaza: la accion pendiente nunca corre", async () => {
    montar();
    const accion = vi.fn(async () => "hecho");
    let resultado: unknown;
    await act(async () => {
      resultado = conStepUp({ fetchImpl: fetchConEstado(ESTADO.enabled), apiBaseUrl: API, token: "t" }, accion).catch((e) => e);
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(dialogo()?.textContent).toContain("Verifica tu identidad");
    click(botonPorTexto("Cancelar"));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(await resultado).toBeInstanceOf(StepUpCanceladoError);
    expect(accion).not.toHaveBeenCalled();
    expect(dialogo()).toBeNull();
  });

  it("codigo correcto: pide el token con scope despachos_sensitive y ejecuta la accion con el header", async () => {
    montar();
    const f = fetchConEstado(ESTADO.enabled, (url) => (url.endsWith("/auth/step-up") ? json({ stepUpToken: "tok-ok" }) : json({})));
    const accion = vi.fn(async (h: Record<string, string>) => h);
    let resultado!: Promise<Record<string, string>>;
    await act(async () => {
      resultado = conStepUp({ fetchImpl: f, apiBaseUrl: API, token: "t" }, accion);
      await new Promise((r) => setTimeout(r, 0));
    });
    changeValue(document.body.querySelector("#despachos-stepup-codigo") as HTMLInputElement, "123456");
    // `requestStepUpToken` usa el `fetch` global: se sustituye para esta prueba.
    const original = globalThis.fetch;
    globalThis.fetch = f;
    try {
      await submitForm(document.body.querySelector("form") as HTMLFormElement);
    } finally {
      globalThis.fetch = original;
    }
    expect(await resultado).toEqual({ "x-step-up-token": "tok-ok" });
    const paso = llamadasA(f as never, "/auth/step-up")[0]!;
    expect(JSON.parse(String((paso[1] as RequestInit).body))).toEqual({ scope: "despachos_sensitive", code: "123456" });
  });

  it("sin TOTP activo: muestra el aviso con enlace a Seguridad, sin campo de codigo, y cerrar rechaza con StepUpSinEnrolarError", async () => {
    montar();
    const accion = vi.fn(async () => "hecho");
    let resultado: unknown;
    await act(async () => {
      resultado = conStepUp({ fetchImpl: fetchConEstado(ESTADO.sinAlta), apiBaseUrl: API, token: "t" }, accion).catch((e) => e);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.body.querySelector("#despachos-stepup-codigo")).toBeNull();
    expect(document.body.querySelector('a[href="/despachos/mi-despacho/seguridad"]')).not.toBeNull();
    click(botonPorTexto("Cerrar"));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(await resultado).toBeInstanceOf(StepUpSinEnrolarError);
    expect(accion).not.toHaveBeenCalled();
  });
});
