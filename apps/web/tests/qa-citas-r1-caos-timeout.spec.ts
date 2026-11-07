// QA-citas-R1-caos-13: sin timeout en el cliente, con la API colgada el panel quedaba en "Cargando..." sin salida.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, sendJson, CitasAdminError, RequestTimeoutError } from "../src/verticals/citas/lib/admin-client.ts";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "../src/lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../src/lib/authed-fetch.ts";
import type { LoginSession } from "../src/verticals/citas/lib/auth-client.ts";

const ctx: AuthedFetchContext<LoginSession> = { vertical: "citas", store: { read: () => null, persist: () => {}, clear: () => {} } };

/** fetch que nunca responde, pero respeta la senal de aborto como el real. */
const colgado: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("QA R1 caos citas -- timeout del cliente", () => {
  it("el tope es de 20 s o menos", () => {
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it("fetchJson con la API colgada falla con un aviso claro al vencer el tope (no se queda cargando)", async () => {
    vi.useFakeTimers();
    const p = fetchJson(colgado, "https://api.test/v1/citas/properties/p/resumen", "tok", ctx);
    const resultado = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await resultado;
    await expect(p).rejects.toThrow(/tardó demasiado/);
  });

  it("sendJson (alta de cita) tambien vence y el error NO es un CitasAdminError de servidor", async () => {
    vi.useFakeTimers();
    const p = sendJson(colgado, "https://api.test/v1/citas/properties/p/appointments", "tok", "POST", {}, ctx);
    const resultado = expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await resultado;
    await expect(p).rejects.not.toBeInstanceOf(CitasAdminError);
  });

  it("una respuesta a tiempo no se afecta y el temporizador se limpia", async () => {
    vi.useFakeTimers();
    const ok: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await expect(fetchWithTimeout(ok, "https://api.test/x")).resolves.toBeInstanceOf(Response);
    expect(vi.getTimerCount()).toBe(0);
  });
});
