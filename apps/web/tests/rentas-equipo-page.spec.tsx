// @vitest-environment jsdom
//
// Rn-20 -- <EquipoPage />: gate de rol, invitar, cambiar rol y dar de baja. Las acciones destructivas pasan por el
// ConfirmDialog: DESCARTARLO (Cancelar) NUNCA llama al servidor; si el servidor falla el mensaje real queda visible.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EquipoPage } from "../src/verticals/rentas/pages/Equipo.tsx";
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
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "yo@gestora.mx", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const montar = (rol: string) => renderComponent(<EquipoPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const MIEMBROS = [
  { id: "u-yo", email: "yo@gestora.mx", fullName: "Yo Admin", verticalRole: "admin_gestora", propertyIds: null },
  { id: "u-lim", email: "limpieza@gestora.mx", fullName: "Lupe Limpieza", verticalRole: "limpieza", propertyIds: null },
];
const INVITACION = { id: "inv-1", email: "pendiente@gestora.mx", verticalRole: "contador", propertyIds: null, status: "pending", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" };

function red(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = extra(url, init);
    if (c) return c;
    if (url.endsWith("/admin/staff/invitaciones") && (init?.method ?? "GET") === "GET") return json({ invitations: [INVITACION] });
    if (url.endsWith("/admin/staff/miembros") && (init?.method ?? "GET") === "GET") return json({ miembros: MIEMBROS });
    throw new Error(`url inesperada: ${init?.method ?? "GET"} ${url}`);
  });
  return { fn, llamadas, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const boton = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement;

describe("EquipoPage", () => {
  it("un rol que no es admin_gestora no pide nada y lo explica", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    for (const rol of ["contador", "limpieza", "operador:acceso_total"]) {
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("reservado a la administradora");
      rendered.unmount();
      rendered = undefined;
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("la administradora ve invitaciones pendientes y el equipo activo con sus roles", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("pendiente@gestora.mx");
    expect(texto).toContain("Lupe Limpieza");
    expect(texto).toContain("Contador/a");
  });

  it("invitar manda POST con correo en minusculas y el rol elegido, y muestra el token UNA vez", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "POST" && url.endsWith("/invitaciones") ? json({ ...INVITACION, email: "nueva@gestora.mx", verticalRole: "limpieza", inviteToken: "TOKEN-SECRETO-1234567890" }, true, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    changeValue(rendered.container.querySelector("#equipo-invitar-correo") as HTMLInputElement, "Nueva@Gestora.MX");
    await submitForm(rendered.container.querySelector("form")!);
    await esperar();
    expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/staff/invitaciones", method: "POST", body: { email: "nueva@gestora.mx", verticalRole: "limpieza" } }]);
    expect(rendered.container.textContent).toContain("TOKEN-SECRETO-1234567890");
  });

  describe("dar de baja", () => {
    it("el primer clic solo abre el dialogo; Cancelar NO llama al servidor", async () => {
      const { fn, mutaciones } = red();
      vi.stubGlobal("fetch", fn);
      rendered = montar("admin_gestora");
      await esperar();
      const botonesBaja = [...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Dar de baja");
      click(botonesBaja[1]!); // la fila de Lupe (la propia esta deshabilitada)
      await esperar();
      expect(dialogo()).not.toBeNull();
      expect(mutaciones()).toHaveLength(0);
      await act(async () => {
        click(botonDialogo("Cancelar"));
        await flushMicrotasks();
      });
      expect(mutaciones()).toHaveLength(0);
      expect(dialogo()).toBeNull();
      expect(rendered.container.textContent).toContain("Lupe Limpieza");
    });

    it("confirmar manda DELETE y la persona sale del listado", async () => {
      const { fn, mutaciones } = red((url, init) => (init?.method === "DELETE" && url.endsWith("/miembros/u-lim") ? json({ ok: true }) : undefined));
      vi.stubGlobal("fetch", fn);
      rendered = montar("admin_gestora");
      await esperar();
      click([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Dar de baja")[1]!);
      await esperar();
      await act(async () => {
        click(botonDialogo("Dar de baja"));
        await esperar();
      });
      expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/staff/miembros/u-lim", method: "DELETE", body: undefined }]);
      expect(rendered.container.textContent).not.toContain("Lupe Limpieza");
    });

    it("si el servidor rechaza, muestra su mensaje real y la persona sigue en el listado", async () => {
      const { fn } = red((_url, init) => (init?.method === "DELETE" ? json({ message: "No puedes dar de baja a alguien con más alcance que el tuyo." }, false, 403) : undefined));
      vi.stubGlobal("fetch", fn);
      rendered = montar("admin_gestora");
      await esperar();
      click([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Dar de baja")[1]!);
      await esperar();
      await act(async () => {
        click(botonDialogo("Dar de baja"));
        await esperar();
      });
      expect(rendered.container.textContent).toContain("con más alcance que el tuyo");
      expect(rendered.container.textContent).toContain("Lupe Limpieza");
    });

    it("no se puede dar de baja ni cambiar el rol de la propia cuenta", async () => {
      vi.stubGlobal("fetch", red().fn);
      rendered = montar("admin_gestora");
      await esperar();
      const bajas = [...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Dar de baja");
      expect(bajas[0]!.disabled).toBe(true);
      expect((rendered.container.querySelector('select[aria-label="Rol de Yo Admin"]') as HTMLSelectElement).disabled).toBe(true);
    });
  });

  describe("cambiar el rol", () => {
    it("cancelar el dialogo no cambia nada; confirmar manda PATCH con el rol nuevo", async () => {
      const { fn, mutaciones } = red((url, init) => (init?.method === "PATCH" && url.endsWith("/miembros/u-lim") ? json({ ...MIEMBROS[1], verticalRole: "contador" }) : undefined));
      vi.stubGlobal("fetch", fn);
      rendered = montar("admin_gestora");
      await esperar();
      const select = () => rendered!.container.querySelector('select[aria-label="Rol de Lupe Limpieza"]') as HTMLSelectElement;
      changeValue(select(), "contador");
      await esperar();
      expect(dialogo()).not.toBeNull();
      await act(async () => {
        click(botonDialogo("Cancelar"));
        await flushMicrotasks();
      });
      expect(mutaciones()).toHaveLength(0);
      expect(select().value).toBe("limpieza");

      changeValue(select(), "contador");
      await esperar();
      await act(async () => {
        click(botonDialogo("Cambiar rol"));
        await esperar();
      });
      expect(mutaciones()).toEqual([{ url: "http://api.local/v1/rentas/prop-1/admin/staff/miembros/u-lim", method: "PATCH", body: { verticalRole: "contador" } }]);
      expect(select().value).toBe("contador");
    });
  });

  it("revocar una invitacion pide confirmacion y Cancelar no la revoca", async () => {
    const { fn, mutaciones } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(boton(rendered, "Revocar"));
    await esperar();
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
  });
});
