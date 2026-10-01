// @vitest-environment jsdom
//
// Smoke tests reales de <SeguridadPage /> (L-01): estado "no disponible" honesto con la base sin
// migrar, alta de 2FA (clave + confirmacion + codigos de respaldo mostrados una vez) y el error real
// del servidor ante un codigo incorrecto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeguridadPage } from "../src/verticals/licitaciones/pages/Seguridad.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

/** Deja resolverse la cadena real fetchJson -> withAuthRefresh -> json() dentro de act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Ana",
  staffEmail: "ana@example.com",
};

function res(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

async function mount() {
  rendered = renderComponent(<SeguridadPage {...CTX} />);
  await settle();
  return rendered;
}

describe("<SeguridadPage />", () => {
  it("base sin migrar: dice honestamente que no esta disponible y no ofrece activar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 })));
    const r = await mount();
    expect(r.container.textContent).toContain("todavía no está disponible en este ambiente");
    expect(r.container.textContent).not.toContain("Activar verificación en dos pasos");
  });

  it("alta: activar muestra la clave; confirmar con el codigo muestra los codigos de respaldo una vez", async () => {
    let enabled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/2fa/status")) return res({ available: true, enabled, pending: false, lockedUntil: null, backupCodesRemaining: enabled ? 2 : 0 });
      if (url.endsWith("/auth/2fa/setup")) return res({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Atiende:ana" }, 201);
      if (url.endsWith("/auth/2fa/confirm")) {
        expect(JSON.parse(init!.body as string)).toEqual({ code: "123456" });
        enabled = true;
        return res({ enabled: true, backupCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] });
      }
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await mount();

    const activar = [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Activar verificación"))!;
    click(activar);
    await settle();
    expect(r.container.textContent).toContain("JBSWY3DPEHPK3PXP");

    changeValue(r.container.querySelector<HTMLInputElement>("#seguridad-confirmar")!, "123 456");
    await submitForm(r.container.querySelectorAll("form")[0]!);
    await settle();
    expect(r.container.textContent).toContain("AAAAA-BBBBB");
    expect(r.container.textContent).toContain("Guarda tus códigos de respaldo");
    expect(r.container.textContent).toContain("Activa");
  });

  it("codigo incorrecto: muestra el mensaje real del servidor y no activa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/2fa/status")) return res({ available: true, enabled: false, pending: true, lockedUntil: null, backupCodesRemaining: 0 });
        if (url.endsWith("/auth/2fa/setup")) return res({ secret: "SECRETO", otpauthUrl: "otpauth://x" }, 201);
        if (url.endsWith("/auth/2fa/confirm")) return res({ code: "second_factor_invalid", message: "El código es incorrecto o ya se usó." }, 422);
        throw new Error(`fetch inesperado: ${url}`);
      }),
    );
    const r = await mount();
    click([...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Activar verificación"))!);
    await settle();
    changeValue(r.container.querySelector<HTMLInputElement>("#seguridad-confirmar")!, "000000");
    await submitForm(r.container.querySelectorAll("form")[0]!);
    await settle();
    expect(r.container.textContent).toContain("El código es incorrecto o ya se usó.");
    expect(r.container.textContent).not.toContain("Guarda tus códigos de respaldo");
  });
});
