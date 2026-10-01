// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminSeguridadPage } from "../src/superadmin/pages/Seguridad.tsx";
import { limpiarStepUp, stepUpVigente } from "../src/superadmin/lib/stepup.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  limpiarStepUp();
  vi.unstubAllGlobals();
});

function stub(estado: Record<string, unknown>, extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = extra?.(url, init);
    if (r) return r;
    if (url.endsWith("/superadmin/mfa/estado")) return json(estado);
    if (url.includes("/superadmin/seguridad/bitacora")) return json({ disponible: true, eventos: [] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const render = () => renderComponent(<SuperAdminSeguridadPage apiBaseUrl="https://api.test" token="tok" />);

describe("SuperAdminSeguridadPage", () => {
  it("base sin migrar: aviso honesto, sin boton de enrolar", async () => {
    stub({ disponible: false, obligatoria: false, inscrito: false, pendiente: false, bloqueadoHastaMs: null });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("todavía no está disponible en esta base");
    expect(rendered.container.textContent).not.toContain("Enrolar autenticador");
  });

  it("sin factor: ofrece enrolar; enrolar muestra el secreto y activar con codigo valido deja MFA activa", async () => {
    let inscrito = false;
    const fetchMock = stub(
      { disponible: true, obligatoria: false, inscrito: false, pendiente: false, bloqueadoHastaMs: null },
      (url, init) => {
        if (url.endsWith("/superadmin/mfa/estado")) return json({ disponible: true, obligatoria: false, inscrito, pendiente: false, bloqueadoHastaMs: null });
        if (url.endsWith("/superadmin/mfa/enrolar") && init?.method === "POST") return json({ secreto: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Atiende:a?secret=JBSWY3DPEHPK3PXP" }, true, 201);
        if (url.endsWith("/superadmin/mfa/verificar") && init?.method === "POST") {
          inscrito = true;
          return json({ activado: true, stepUpToken: "su-1", expiraEnSegundos: 300 });
        }
        return undefined;
      },
    );
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enrolar autenticador"))!);
    await esperar();
    expect((rendered.container.querySelector("#mfa-secreto") as HTMLInputElement).value).toBe("JBSWY3DPEHPK3PXP");

    const form = rendered.container.querySelector("#mfa-codigo")!.closest("form") as HTMLFormElement;
    changeValue(rendered.container.querySelector("#mfa-codigo") as HTMLInputElement, "12");
    await submitForm(form);
    expect(rendered.container.textContent).toContain("6 dígitos");

    changeValue(rendered.container.querySelector("#mfa-codigo") as HTMLInputElement, "123 456");
    await submitForm(form);
    await esperar();
    expect(rendered.container.textContent).toContain("MFA activa");
    expect(stepUpVigente("tok")).toBe("su-1");
    const verificar = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith("/mfa/verificar"))!;
    expect(JSON.parse(String((verificar[1] as RequestInit).body))).toEqual({ codigo: "123456" });
  });

  it("con MFA activa no ofrece enrolar de nuevo y muestra el formulario de restablecer a otro superadmin", async () => {
    stub({ disponible: true, obligatoria: true, inscrito: true, pendiente: false, bloqueadoHastaMs: null });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("MFA activa");
    expect(t).toContain("Obligatoria en este despliegue");
    expect(t).not.toContain("Enrolar autenticador");
    expect(t).toContain("Restablecer el factor de otro superadmin");
  });
});
