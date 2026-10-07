// @vitest-environment jsdom
//
// H-P3-05 -- <EquipoPage /> de hoteles: gate de rol (owner/gm), invitar con uno de los 8 roles, ver pendientes y revocar. Revocar pasa por el
// ConfirmDialog: DESCARTARLO (Cancelar) NUNCA llama al servidor; si el servidor falla el mensaje real queda visible.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EquipoPage } from "../src/verticals/hoteles/pages/Equipo.tsx";
import { STAFF_ROLE_OPTIONS } from "../src/verticals/hoteles/lib/staff-client.ts";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
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

const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "http://api.local", token: "tok", propertyId: "prop-1", orgSlug: "hotel-demo", role, staffFullName: "Yo", staffEmail: "yo@hotel.mx" });
const montar = (role: string) => renderComponent(<EquipoPage {...ctx(role)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const MIEMBROS = [
  { id: "u-yo", email: "yo@hotel.mx", fullName: "Yo Propietaria", verticalRole: "owner", propertyIds: null },
  { id: "u-rec", email: "recepcion@hotel.mx", fullName: "Rita Recepción", verticalRole: "frontdesk", propertyIds: null },
];
const INVITACION = { id: "inv-1", email: "pendiente@hotel.mx", verticalRole: "accountant", propertyIds: null, status: "pending", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" };

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

describe("EquipoPage de hoteles", () => {
  it("un rol que no es owner/gm no pide nada y lo explica", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    for (const rol of ["frontdesk", "accountant", "housekeeping", "reservations"]) {
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("reservado al propietario y al gerente general");
      rendered.unmount();
      rendered = undefined;
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("owner y gm ven invitaciones pendientes y el equipo activo con sus roles", async () => {
    for (const rol of ["owner", "gm"]) {
      vi.stubGlobal("fetch", red().fn);
      rendered = montar(rol);
      await esperar();
      const texto = rendered.container.textContent ?? "";
      expect(texto).toContain("pendiente@hotel.mx");
      expect(texto).toContain("Rita Recepción");
      expect(texto).toContain("Contabilidad");
      expect(texto).toContain("(tú)");
      rendered.unmount();
      rendered = undefined;
    }
  });

  it("el selector ofrece los 8 roles de hoteles", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("owner");
    await esperar();
    const opciones = [...rendered.container.querySelectorAll("#equipo-invitar-rol option")].map((o) => (o as HTMLOptionElement).value);
    expect(opciones.sort()).toEqual([...STAFF_ROLE_OPTIONS].sort());
    expect(opciones).toHaveLength(8);
  });

  it("invitar manda POST con correo en minusculas y el rol elegido, y muestra el token UNA vez", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "POST" && url.endsWith("/invitaciones") ? json({ ...INVITACION, email: "nueva@hotel.mx", verticalRole: "housekeeping", inviteToken: "TOKEN-SECRETO-1234567890" }, true, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner");
    await esperar();
    changeValue(rendered.container.querySelector("#equipo-invitar-correo") as HTMLInputElement, "Nueva@Hotel.MX");
    changeValue(rendered.container.querySelector("#equipo-invitar-rol") as HTMLSelectElement, "housekeeping");
    await submitForm(rendered.container.querySelector("form") as HTMLFormElement);
    await esperar();
    const posts = mutaciones();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ method: "POST", url: "http://api.local/v1/hoteles/prop-1/admin/staff/invitaciones", body: { email: "nueva@hotel.mx", verticalRole: "housekeeping" } });
    expect(rendered.container.textContent).toContain("TOKEN-SECRETO-1234567890");
  });

  it("si el servidor rechaza la invitacion (p. ej. un gm invitando a un propietario) el mensaje real queda visible", async () => {
    const { fn } = red((url, init) => (init?.method === "POST" ? json({ message: "No puedes invitar a alguien con más alcance que el tuyo." }, false, 403) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("gm");
    await esperar();
    changeValue(rendered.container.querySelector("#equipo-invitar-correo") as HTMLInputElement, "dueno@hotel.mx");
    await submitForm(rendered.container.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(rendered.container.textContent).toContain("más alcance que el tuyo");
  });

  it("revocar: Cancelar en el dialogo NO llama al servidor; confirmar manda DELETE y recarga", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "DELETE" ? json({ ok: true }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner");
    await esperar();
    await act(async () => click(boton(rendered!, "Revocar")));
    await esperar();
    expect(dialogo()).not.toBeNull();
    await act(async () => click(botonDialogo("Cancelar")));
    await esperar();
    expect(mutaciones()).toHaveLength(0);

    await act(async () => click(boton(rendered!, "Revocar")));
    await esperar();
    await act(async () => click(botonDialogo("Revocar")));
    await esperar();
    expect(mutaciones()).toEqual([expect.objectContaining({ method: "DELETE", url: "http://api.local/v1/hoteles/prop-1/admin/staff/invitaciones/inv-1" })]);
  });

  it("error al cargar: muestra el error con reintento, nunca una lista vacia", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "boom" }, false, 500)));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("boom");
    expect(rendered.container.textContent).not.toContain("No hay ninguna invitación pendiente");
  });
});
