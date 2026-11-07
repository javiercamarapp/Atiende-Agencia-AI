// @vitest-environment jsdom
//
// Bandera de diseno POR ORGANIZACION (migracion 0060): el hook que llaman los 6 shells (via useVerticalSession) guarda el valor de
// la organizacion activa para el primer pintado y recarga UNA vez si lo pintado ya no coincide.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { CLAVE_RECARGA_DISENO, recargarPorDiseno, useDisenoOrganizacion } from "../src/lib/useDisenoOrganizacion.ts";
import { renderComponent as render } from "./test-utils/render.tsx";
import type { RenderedComponent } from "./test-utils/render.tsx";

function sesion(diseno?: string | null): LoginSession {
  const org = { id: "o1", slug: "pm", nombre: "PM", vertical: "restaurantes", rol: "owner", ...(diseno === undefined ? {} : { diseno }) };
  return { token: "t", refreshToken: "r", email: "a@b.mx", organizations: [org] };
}

function Sonda({ s, slug }: { s: LoginSession | null; slug: string }) {
  useDisenoOrganizacion(s, slug);
  return null;
}

let montado: RenderedComponent | null = null;
const recargas = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-diseno");
  recargas.mockReset();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload: recargas } as unknown as Location);
});
afterEach(() => {
  montado?.unmount();
  montado = null;
  vi.restoreAllMocks();
});

describe("useDisenoOrganizacion", () => {
  it("organizacion con ds3 y pagina en el diseno actual: guarda el valor y recarga una vez", () => {
    montado = render(createElement(Sonda, { s: sesion("ds3"), slug: "pm" }));
    expect(window.localStorage.getItem("atiende-diseno-org")).toBe("ds3");
    expect(recargas).toHaveBeenCalledTimes(1);
  });

  it("ya pintado en ds3: no recarga", () => {
    document.documentElement.dataset.diseno = "ds3";
    montado = render(createElement(Sonda, { s: sesion("ds3"), slug: "pm" }));
    expect(recargas).not.toHaveBeenCalled();
  });

  it("null con ds3 pintado por la organizacion: borra el valor y recarga", () => {
    window.localStorage.setItem("atiende-diseno-org", "ds3");
    document.documentElement.dataset.diseno = "ds3";
    montado = render(createElement(Sonda, { s: sesion(null), slug: "pm" }));
    expect(window.localStorage.getItem("atiende-diseno-org")).toBeNull();
    expect(recargas).toHaveBeenCalledTimes(1);
  });

  it("sesion persistida antes del campo (sin diseno), otra organizacion o sin sesion: no toca nada", () => {
    window.localStorage.setItem("atiende-diseno-org", "ds3");
    montado = render(createElement(Sonda, { s: sesion(undefined), slug: "pm" }));
    montado.rerender(createElement(Sonda, { s: sesion("ds3"), slug: "otra" }));
    montado.rerender(createElement(Sonda, { s: null, slug: "pm" }));
    expect(window.localStorage.getItem("atiende-diseno-org")).toBe("ds3");
    expect(recargas).not.toHaveBeenCalled();
  });
});

describe("recargarPorDiseno", () => {
  it("recarga una sola vez por pestana y por valor (sin bucle)", () => {
    const r = vi.fn();
    expect(recargarPorDiseno("ds3", r)).toBe(true);
    expect(recargarPorDiseno("ds3", r)).toBe(false);
    expect(r).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CLAVE_RECARGA_DISENO)).toBe("ds3");
    expect(recargarPorDiseno(null, r)).toBe(true);
  });

  it("sin sessionStorage no recarga", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const r = vi.fn();
    expect(recargarPorDiseno("ds3", r)).toBe(false);
    expect(r).not.toHaveBeenCalled();
  });
});
