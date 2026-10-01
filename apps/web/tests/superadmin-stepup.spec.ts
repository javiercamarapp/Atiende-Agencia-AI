// Cliente del step-up MFA: fetchConStepUp adjunta el token vigente, pide el codigo
// UNA vez ante 403 stepup_required y reintenta UNA vez; nunca entra en bucle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConStepUp, guardarStepUp, limpiarStepUp, registrarStepUpPrompter, stepUpVigente, verificarMfa } from "../src/superadmin/lib/stepup.ts";

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  limpiarStepUp();
  registrarStepUpPrompter(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  limpiarStepUp();
  registrarStepUpPrompter(null);
});

describe("stepUpVigente", () => {
  it("solo para el mismo access token, y no vencido (margen de 10 s)", () => {
    guardarStepUp("acc-1", "su-1", 300, 1_000);
    expect(stepUpVigente("acc-1", 1_000)).toBe("su-1");
    expect(stepUpVigente("acc-2", 1_000)).toBeNull();
    expect(stepUpVigente("acc-1", 1_000 + 289_000)).toBe("su-1");
    expect(stepUpVigente("acc-1", 1_000 + 290_000)).toBeNull();
  });
});

describe("fetchConStepUp", () => {
  it("sin token cacheado NO agrega header; 200 se devuelve tal cual y no se pide step-up", async () => {
    fetchMock = vi.fn(async () => res(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = vi.fn(async () => undefined);
    registrarStepUpPrompter(prompter);
    const r = await fetchConStepUp("https://api", "acc", "https://api/x", { method: "POST", headers: { a: "b" } });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ a: "b" });
    expect(prompter).not.toHaveBeenCalled();
  });

  it("con token vigente lo adjunta en x-stepup-token", async () => {
    fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    guardarStepUp("acc", "su-9", 300);
    await fetchConStepUp("https://api", "acc", "https://api/x", { headers: { a: "b" } });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ a: "b", "x-stepup-token": "su-9" });
  });

  it("403 stepup_required: pide el codigo, y reintenta UNA vez con el token nuevo", async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(403, { code: "stepup_required" }))
      .mockResolvedValueOnce(res(200, { hecho: true }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = vi.fn(async ({ accessToken }: { accessToken: string }) => guardarStepUp(accessToken, "su-nuevo", 300));
    registrarStepUpPrompter(prompter);
    const r = await fetchConStepUp("https://api", "acc", "https://api/x", { method: "PUT" });
    expect(r.status).toBe(200);
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toEqual({ "x-stepup-token": "su-nuevo" });
  });

  it("si el reintento vuelve a ser 403 stepup_required NO entra en bucle (devuelve esa respuesta)", async () => {
    fetchMock = vi.fn(async () => res(403, { code: "stepup_required" }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = vi.fn(async () => undefined);
    registrarStepUpPrompter(prompter);
    const r = await fetchConStepUp("https://api", "acc", "https://api/x");
    expect(r.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prompter).toHaveBeenCalledTimes(1);
  });

  it("si el usuario cancela el dialogo se devuelve el 403 original y no se reintenta", async () => {
    fetchMock = vi.fn(async () => res(403, { code: "stepup_required" }));
    vi.stubGlobal("fetch", fetchMock);
    registrarStepUpPrompter(async () => {
      throw new Error("cancelado");
    });
    const r = await fetchConStepUp("https://api", "acc", "https://api/x");
    expect(r.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("otros 403 (p. ej. forbidden, mfa_enrollment_required) y 401 no disparan el dialogo", async () => {
    for (const [status, code] of [[403, "forbidden"], [403, "mfa_enrollment_required"], [401, "unauthorized"]] as const) {
      fetchMock = vi.fn(async () => res(status, { code }));
      vi.stubGlobal("fetch", fetchMock);
      const prompter = vi.fn(async () => undefined);
      registrarStepUpPrompter(prompter);
      const r = await fetchConStepUp("https://api", "acc", "https://api/x");
      expect(r.status).toBe(status);
      expect(prompter).not.toHaveBeenCalled();
    }
  });

  it("sin dialogo registrado (p. ej. tests) devuelve el 403 sin romper", async () => {
    fetchMock = vi.fn(async () => res(403, { code: "stepup_required" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchConStepUp("https://api", "acc", "https://api/x");
    expect(r.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verificarMfa", () => {
  it("un acierto guarda el step-up en memoria para ese access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { activado: false, stepUpToken: "su-ok", expiraEnSegundos: 300 })));
    await expect(verificarMfa("https://api", "acc", "123456")).resolves.toEqual({ ok: true, activado: false });
    expect(stepUpVigente("acc")).toBe("su-ok");
  });
  it("un fallo devuelve el codigo y mensaje del servidor y NO guarda nada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(401, { code: "mfa_codigo_invalido", message: "Código incorrecto." })));
    await expect(verificarMfa("https://api", "acc", "000000")).resolves.toEqual({ ok: false, code: "mfa_codigo_invalido", message: "Código incorrecto." });
    expect(stepUpVigente("acc")).toBeNull();
  });
});
