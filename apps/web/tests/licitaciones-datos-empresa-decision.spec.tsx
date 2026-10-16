// @vitest-environment jsdom
//
// Datos de la empresa -- aprobar/rechazar (migracion 036): quien propone no decide, tarifas con step-up, doble clic de una sola
// escritura, Cancelar/Escape sin escribir, y "propuso/aprobo" visible. Contra un fetch simulado: lo que el servidor rechazaria igual
// solo se oculta o se deshabilita aqui; el servidor SIEMPRE decide.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DatosEmpresaPage } from "../src/verticals/licitaciones/pages/DatosEmpresa.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const USER = "00000000-0000-0000-0000-0000000000a1";
const OTRA = "00000000-0000-0000-0000-0000000000b2";
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/u, "")}.s`;
const ctx = (role: string, sub = USER): LicitacionesShellContext => ({ apiBaseUrl: "https://api.test", token: jwt(sub), propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Ana", staffEmail: "ana@example.com" });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const postsTo = (suffix: string) => posts().filter(([url]) => String(url).endsWith(suffix));

const PEOPLE = { [USER]: "Ana", [OTRA]: "Beto" };
const doc = (over: Record<string, unknown> = {}) => ({ id: "d1", type: "acta", label: "Acta constitutiva", expiresAt: null, approvalStatus: "pendiente_aprobacion", proposedBy: OTRA, approvedBy: null, approvedAt: null, ...over });
const rate = (over: Record<string, unknown> = {}) => ({ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01", validUntil: null, proposedBy: OTRA, approvedBy: null, approvedAt: null, ...over });

function stubFetch(opts: { documents?: unknown[]; rates?: unknown[]; twoFactor?: { available: boolean; enabled: boolean }; decide?: () => Response } = {}) {
  const twoFactor = opts.twoFactor ?? { available: true, enabled: true };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/auth/2fa/status")) return json({ ...twoFactor, pending: false, lockedUntil: null, backupCodesRemaining: 8 });
    if (u.endsWith("/auth/step-up")) return json({ stepUpToken: "su-token" });
    if (method === "GET" && u.endsWith("/company/documents")) return json({ documents: opts.documents ?? [doc()], people: PEOPLE });
    if (method === "GET" && u.endsWith("/company/rates")) return json({ rates: opts.rates ?? [rate()], people: PEOPLE });
    if (method === "GET" && u.endsWith("/company/capabilities")) return json({ capabilities: [], people: {} });
    if (method === "GET" && u.endsWith("/company/experience")) return json({ experience: [], people: {} });
    if (method === "GET" && u.endsWith("/company/signers")) return json({ signers: [], people: {} });
    if (method === "POST" && /\/(approve|reject)$/u.test(u)) return (opts.decide ?? (() => json({ ok: true })))();
    throw new Error(`fetch inesperado: ${method} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montar(c: LicitacionesShellContext, tab = "documentos") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[`/x?tab=${tab}`]}>
      <DatosEmpresaPage {...c} />
    </MemoryRouter>,
  );
  await settle();
  return rendered;
}

describe("Datos de la empresa -- quien puede decidir", () => {
  it("writer, reviewer y viewer NO ven Aprobar/Rechazar; analyst ve los de documentos pero no los de tarifas; owner ve ambos", async () => {
    for (const role of ["writer", "reviewer", "viewer"]) {
      stubFetch();
      await montar(ctx(role));
      expect(boton("Aprobar"), role).toBeUndefined();
      expect(boton("Rechazar"), role).toBeUndefined();
      rendered!.unmount();
    }
    stubFetch();
    await montar(ctx("analyst"));
    expect(boton("Aprobar")).toBeDefined();
    rendered!.unmount();
    stubFetch();
    await montar(ctx("analyst"), "tarifas");
    expect(boton("Aprobar")).toBeUndefined();
    rendered!.unmount();
    stubFetch();
    await montar(ctx("owner"), "tarifas");
    expect(boton("Aprobar")).toBeDefined();
    expect(boton("Rechazar")).toBeDefined();
  });

  it("un dato ya aprobado o rechazado no ofrece decidir", async () => {
    stubFetch({ documents: [doc({ approvalStatus: "aprobado", approvedBy: USER }), doc({ id: "d2", label: "Otra", approvalStatus: "rechazado", approvedBy: USER })] });
    await montar(ctx("owner", OTRA));
    expect(boton("Aprobar")).toBeUndefined();
  });

  it("el AUTOR ve los botones deshabilitados y el motivo a la vista; no se escribe nada", async () => {
    stubFetch({ documents: [doc({ proposedBy: USER })] });
    await montar(ctx("owner", USER));
    expect(boton("Aprobar")!.disabled).toBe(true);
    expect(boton("Rechazar")!.disabled).toBe(true);
    expect(rendered!.container.textContent).toContain("Lo propusiste o editaste tú: lo debe decidir otra persona.");
    click(boton("Aprobar")!);
    await settle();
    expect(dialogo()).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("muestra quien propuso y quien aprobo (con nombres del equipo, 'tu' para quien mira)", async () => {
    stubFetch({ documents: [doc({ approvalStatus: "aprobado", proposedBy: OTRA, approvedBy: USER })] });
    await montar(ctx("owner", USER));
    expect(rendered!.container.textContent).toContain("Propuso: Beto · Aprobó: tú");
  });
});

describe("Datos de la empresa -- decidir un documento (sin step-up)", () => {
  it("el primer clic solo abre la confirmacion; Cancelar y Escape no escriben", async () => {
    stubFetch();
    await montar(ctx("owner", USER));
    click(boton("Aprobar")!);
    await settle();
    expect(dialogo()).not.toBeNull();
    expect(posts()).toHaveLength(0);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    await settle();
    expect(posts()).toHaveLength(0);
    click(boton("Aprobar")!);
    await settle();
    keydown(dialogo()!, "Escape");
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("confirmar hace POST .../documents/d1/approve SIN cabecera de step-up y recarga", async () => {
    stubFetch();
    await montar(ctx("owner", USER));
    click(boton("Aprobar")!);
    await settle();
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    const llamadas = postsTo("/company/documents/d1/approve");
    expect(llamadas).toHaveLength(1);
    expect(((llamadas[0]![1] as RequestInit).headers as Record<string, string>)["x-step-up-token"]).toBeUndefined();
    expect(postsTo("/auth/step-up")).toHaveLength(0);
    // recargo la lista tras decidir
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith("/company/documents") && ((i as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("rechazar hace POST .../reject", async () => {
    stubFetch();
    await montar(ctx("owner", USER));
    click(boton("Rechazar")!);
    await settle();
    await act(async () => {
      click(botonDialogo("Rechazar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(postsTo("/company/documents/d1/reject")).toHaveLength(1);
  });

  it("doble clic en confirmar: UNA sola escritura (guardia WI-06)", async () => {
    stubFetch();
    await montar(ctx("owner", USER));
    click(boton("Aprobar")!);
    await settle();
    const confirmar = botonDialogo("Aprobar");
    await act(async () => {
      confirmar.click();
      confirmar.click();
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(postsTo("/company/documents/d1/approve")).toHaveLength(1);
  });

  it("un 409 del servidor (otra persona decidio antes) se muestra y la lista se refresca", async () => {
    stubFetch({ decide: () => json({ message: "Este dato ya no está pendiente de aprobación." }, 409) });
    await montar(ctx("owner", USER));
    click(boton("Aprobar")!);
    await settle();
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(rendered!.container.textContent).toContain("ya no está pendiente");
  });
});

describe("Datos de la empresa -- decidir una tarifa (con step-up)", () => {
  async function abrirTarifa() {
    stubFetch();
    await montar(ctx("owner", USER), "tarifas");
    click(boton("Aprobar")!);
    await settle();
  }

  it("el dialogo pide el codigo de dos pasos; Cancelar o Escape no piden step-up ni escriben", async () => {
    await abrirTarifa();
    expect(dialogo()!.textContent).toContain("Confirma tu identidad");
    expect(botonDialogo("Aprobar").disabled).toBe(true); // el codigo es requerido
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    await settle();
    click(boton("Aprobar")!);
    await settle();
    keydown(dialogo()!, "Escape");
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("con el codigo: pide el step-up (alcance company_rate_approval) y aprueba con x-step-up-token", async () => {
    await abrirTarifa();
    changeValue(dialogo()!.querySelector("input")!, "123456");
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    const stepUp = postsTo("/auth/step-up");
    expect(stepUp).toHaveLength(1);
    expect(JSON.parse(String((stepUp[0]![1] as RequestInit).body))).toEqual({ scope: "company_rate_approval", code: "123456" });
    const decision = postsTo("/company/rates/r1/approve");
    expect(decision).toHaveLength(1);
    expect(((decision[0]![1] as RequestInit).headers as Record<string, string>)["x-step-up-token"]).toBe("su-token");
  });

  it("sin 2FA enrolado avisa que hay que activarlo (el servidor igual responde 403)", async () => {
    stubFetch({ twoFactor: { available: true, enabled: false } });
    await montar(ctx("owner", USER), "tarifas");
    expect(rendered!.container.textContent).toContain("activa tu verificación en dos pasos");
  });
});
