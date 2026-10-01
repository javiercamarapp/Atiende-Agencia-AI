// @vitest-environment jsdom
//
// PR-11 de diseno-ux: las pantallas de shell (aceptar invitacion, elegir organizacion, sin
// organizacion, selector de vertical) pasan a tokens y primitivos del DS v2. Esta prueba fija
// que el comportamiento NO cambio: validacion local, navegacion y textos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act } from "react";
import { AceptarInvitacionPage } from "../src/shell/AceptarInvitacion.tsx";
import { SeleccionarOrganizacionPage } from "../src/shell/SeleccionarOrganizacion.tsx";
import { SinOrganizacionPage } from "../src/shell/SinOrganizacion.tsx";
import { SeleccionarVerticalPage } from "../src/shell/SeleccionarVertical.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

function Ubicacion() {
  return <output data-testid="ruta">{useLocation().pathname}</output>;
}

function escribir(el: HTMLInputElement, valor: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AceptarInvitacionPage", () => {
  it("precarga el token de la URL y NO llama al servidor si las contrasenas no coinciden", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onAccepted = vi.fn();
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/aceptar-invitacion?token=abc123"]}>
        <AceptarInvitacionPage apiBaseUrl="http://api.test" onAccepted={onAccepted} />
      </MemoryRouter>,
    );
    const c = rendered.container;
    const campos = [...c.querySelectorAll("input")];
    expect(campos).toHaveLength(4);
    expect(campos[0]!.value).toBe("abc123");
    escribir(campos[1]!, "Ana Prueba");
    escribir(campos[2]!, "contrasena-uno");
    escribir(campos[3]!, "contrasena-dos");
    act(() => {
      c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(c.querySelector('[role="alert"]')?.textContent).toBe("Las contraseñas no coinciden.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("cada campo tiene etiqueta accesible enlazada", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <AceptarInvitacionPage apiBaseUrl="http://api.test" onAccepted={() => undefined} />
      </MemoryRouter>,
    );
    const etiquetas = [...rendered.container.querySelectorAll("label")].map((l) => l.textContent ?? "");
    expect(etiquetas.some((t) => t.includes("Token de invitación"))).toBe(true);
    expect(etiquetas.some((t) => t.includes("Confirma tu contraseña"))).toBe(true);
    for (const input of rendered.container.querySelectorAll("input")) {
      expect(rendered.container.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    }
  });
});

describe("SeleccionarOrganizacionPage", () => {
  const session: LoginSession = {
    token: "t",
    refreshToken: "r",
    email: "ana@example.com",
    organizations: [
      { id: "o1", slug: "uno", nombre: "Hotel Uno", vertical: "hoteles", rol: "owner" },
      { id: "o2", slug: "dos", nombre: "Hotel Dos", vertical: "hoteles", rol: "repartidor" },
      { id: "o3", slug: "otra", nombre: "Otra vertical", vertical: "citas", rol: "owner" },
    ],
  };

  function montar(state: unknown) {
    return renderComponent(
      <MemoryRouter initialEntries={[{ pathname: "/elegir", state }]}>
        <Ubicacion />
        <Routes>
          <Route path="/elegir" element={<SeleccionarOrganizacionPage />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("lista solo las organizaciones de la vertical y navega a la elegida", () => {
    rendered = montar({ session, vertical: "hoteles" });
    const botones = [...rendered.container.querySelectorAll("button")];
    expect(botones.map((b) => b.textContent)).toEqual(["Hotel Unorol: owner", "Hotel Dosrol: repartidor"]);
    act(() => botones[1]!.click());
    expect(rendered.container.querySelector('[data-testid="ruta"]')?.textContent).toBe("/hoteles/dos/repartidor");
  });

  it("sin sesion en el estado muestra un mensaje real, no una pantalla en blanco", () => {
    rendered = montar(null);
    expect(rendered.container.textContent).toContain("No pudimos recuperar tu sesión");
  });

  it("una vertical sin organizaciones lo dice", () => {
    rendered = montar({ session, vertical: "rentas" });
    expect(rendered.container.textContent).toContain("No encontramos ninguna organización de rentas");
  });
});

describe("SinOrganizacionPage y SeleccionarVerticalPage", () => {
  it("SinOrganizacion usa el correo y la vertical del estado cuando existen", () => {
    rendered = renderComponent(
      <MemoryRouter initialEntries={[{ pathname: "/sin-organizacion", state: { email: "ana@example.com", vertical: "citas" } }]}>
        <SinOrganizacionPage />
      </MemoryRouter>,
    );
    expect(rendered.container.textContent).toContain("ana@example.com");
    expect(rendered.container.textContent).toContain("de citas");
  });

  it("SeleccionarVertical ofrece las 6 verticales con enlace a su login y los textos legales", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <SeleccionarVerticalPage />
      </MemoryRouter>,
    );
    const hrefs = [...rendered.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const v of ["despachos", "citas", "hoteles", "licitaciones", "rentas", "restaurantes"]) expect(hrefs).toContain(`/${v}/login`);
    expect(hrefs).toContain("/terminos");
    expect(hrefs).toContain("/privacidad");
  });
});
