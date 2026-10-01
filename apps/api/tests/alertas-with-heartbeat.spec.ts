// withHeartbeat + alertas salientes: un cron que falla avisa; el aviso es best-effort.
import { describe, expect, it, vi } from "vitest";
import { InMemorySaludRepository } from "@atiende/db";
import type { AppDeps } from "../src/deps.ts";
import type { DespachadorAlertas } from "../src/alertas/tipos.ts";
import { CronPartialFailureError, withHeartbeat } from "../src/salud/with-heartbeat.ts";

function deps(alertas?: DespachadorAlertas): AppDeps {
  return { saludRepo: new InMemorySaludRepository(), alertas } as unknown as AppDeps;
}

describe("withHeartbeat -> alertas salientes", () => {
  it("cuando el handler lanza, notifica UNA alerta 'alta' con el cron y relanza la misma excepcion", async () => {
    const notificar = vi.fn().mockResolvedValue({ resultados: [] });
    const err = new Error("boom");
    await expect(withHeartbeat(deps({ notificar }), "/internal/test/cron", async () => { throw err; })()).rejects.toBe(err);
    expect(notificar).toHaveBeenCalledTimes(1);
    expect(notificar.mock.calls[0]![0]).toMatchObject({ tipo: "cron_error:/internal/test/cron", severidad: "alta", detalle: "boom", contexto: { cron: "/internal/test/cron" } });
  });

  it("un fallo parcial (CronPartialFailureError) tambien avisa y devuelve la Response original", async () => {
    const notificar = vi.fn().mockResolvedValue({ resultados: [] });
    const respuesta = new Response("{}", { status: 200 });
    const r = await withHeartbeat(deps({ notificar }), "/internal/test/parcial", async () => { throw new CronPartialFailureError("1 unidad fallo", respuesta); })();
    expect(r).toBe(respuesta);
    expect(notificar).toHaveBeenCalledTimes(1);
  });

  it("un cron que termina bien NO notifica", async () => {
    const notificar = vi.fn();
    await withHeartbeat(deps({ notificar }), "/internal/test/ok", async () => new Response("{}"))();
    expect(notificar).not.toHaveBeenCalled();
  });

  it("si el despachador lanza, el cron sigue fallando con SU excepcion original (el aviso nunca la reemplaza)", async () => {
    const notificar = vi.fn().mockRejectedValue(new Error("despachador roto"));
    const err = new Error("boom real");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(withHeartbeat(deps({ notificar }), "/internal/test/cron", async () => { throw err; })()).rejects.toBe(err);
    } finally {
      error.mockRestore();
    }
  });

  it("sin despachador (base/entorno sin configurar) el comportamiento previo no cambia", async () => {
    const err = new Error("boom");
    await expect(withHeartbeat(deps(undefined), "/internal/test/cron", async () => { throw err; })()).rejects.toBe(err);
  });

  it("el mensaje del error con datos sensibles llega redactado al canal (integracion con el despachador real)", async () => {
    const { crearDespachadorAlertas } = await import("../src/alertas/despachador.ts");
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}", { status: 200 }));
    const despachador = crearDespachadorAlertas({ correo: null, webhook: { url: "https://hooks.example.com/x", secreto: null }, sentry: null, limitePorHora: 5 }, { fetchImpl: f });
    await expect(withHeartbeat(deps(despachador), "/internal/test/cron", async () => { throw new Error("insert fallo para cliente@correo.com password=hunter2"); })()).rejects.toThrow();
    const cuerpo = String(f.mock.calls[0]![1].body);
    expect(cuerpo).not.toContain("cliente@correo.com");
    expect(cuerpo).not.toContain("hunter2");
  });
});
