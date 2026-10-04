// @vitest-environment jsdom
//
// UNI-C despachos (estructura y formularios) -- pagina "Equipo": un solo h1, estados reales, la alta pasa a FormDialog con
// labels visibles y revocar una invitacion pasa por useConfirm (Cancelar nunca llama a la API).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "../src/verticals/despachos/pages/Staff.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Admin", staffEmail: "a@example.com" });

const INVITE = { id: "inv-1", email: "nuevo@example.com", verticalRole: "contador", propertyIds: null, status: "pending", expiresAt: "2026-10-20T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z" };
const MIEMBRO = { id: "m-1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "auditor", propertyIds: null };

function res(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body, headers: new Headers() } as unknown as Response;
}

function stubFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/admin/staff/invitaciones")) return res({ invitations: [INVITE] });
    if (method === "GET" && url.endsWith("/admin/staff/miembros")) return res({ miembros: [MIEMBRO] });
    if (method === "DELETE") return res({ ok: true });
    if (method === "POST") return res({ ...INVITE, id: "inv-2", email: "otra@example.com", inviteToken: "tok-secreto" });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montar(role: string): Promise<RenderedComponent> {
  const r = renderComponent(<StaffPage {...CTX(role)} />);
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  return r;
}

const escrituras = () => fetchMock.mock.calls.filter(([, init]) => ["DELETE", "POST", "PATCH"].includes((init as RequestInit | undefined)?.method ?? "GET"));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const boton = (root: ParentNode, texto: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;

describe("Equipo (Staff) -- estructura y formularios", () => {
  it("tiene un solo h1 \"Equipo\" y ningun control sin label", async () => {
    stubFetch();
    rendered = await montar("admin");
    const h1s = rendered.container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("Equipo");
    for (const c of rendered.container.querySelectorAll("select,input,textarea")) {
      const id = c.getAttribute("id");
      expect(id !== null && rendered.container.querySelector(`label[for="${id}"]`) !== null).toBe(true);
    }
  });

  it("un rol sin permiso ve el estado \"Sin permiso\" y no llama a la API", async () => {
    stubFetch();
    rendered = await montar("contador");
    expect(rendered.container.textContent).toContain("Sin permiso");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(boton(rendered.container, "Invitar")).toBeUndefined();
  });

  it("revocar pide confirmacion: Cancelar no llama a la API", async () => {
    stubFetch();
    rendered = await montar("admin");
    await act(async () => {
      click(boton(rendered!.container, "Revocar")!);
      await flushMicrotasks();
    });
    expect(dialogo()).not.toBeNull();
    expect(escrituras()).toHaveLength(0);
    await act(async () => {
      click(boton(dialogo()!, "Cancelar")!);
      await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);
  });

  it("revocar confirmado llama a DELETE de esa invitacion", async () => {
    stubFetch();
    rendered = await montar("admin");
    await act(async () => {
      click(boton(rendered!.container, "Revocar")!);
      await flushMicrotasks();
    });
    await act(async () => {
      click(boton(dialogo()!, "Revocar")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const dels = escrituras();
    expect(dels).toHaveLength(1);
    expect(String(dels[0]![0])).toContain("/admin/staff/invitaciones/inv-1");
  });

  it("la alta abre un FormDialog con labels y muestra el token una sola vez", async () => {
    stubFetch();
    rendered = await montar("admin");
    await act(async () => {
      click(boton(rendered!.container, "Invitar")!);
      await flushMicrotasks();
    });
    const dlg = document.body.querySelector('[role="dialog"]')!;
    expect(dlg).not.toBeNull();
    const email = dlg.querySelector('input[type="email"]') as HTMLInputElement;
    expect(dlg.querySelector(`label[for="${email.id}"]`)).not.toBeNull();
    await act(async () => {
      changeValue(email, "Otra@Example.com");
      await flushMicrotasks();
    });
    await act(async () => {
      click(boton(dlg, "Invitar")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    const posts = escrituras();
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ email: "otra@example.com", verticalRole: "contador" });
    expect(rendered.container.textContent).toContain("tok-secreto");
  });
});
