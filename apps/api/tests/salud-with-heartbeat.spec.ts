// withHeartbeat -- ver ../src/salud/with-heartbeat.ts. Dos garantías DURAS a
// probar: (1) un fallo al escribir el latido nunca tumba ni altera la
// respuesta real del handler envuelto: (2) si el handler lanza, el wrapper
// registra el error y relanza la MISMA excepción (comportamiento
// indistinguible de no estar instrumentado, salvo por el latido registrado).
import { describe, expect, it, vi } from "vitest";
import { InMemorySaludRepository } from "@atiende/db";
import type { AppDeps } from "../src/deps.ts";
import { CronPartialFailureError, withHeartbeat } from "../src/salud/with-heartbeat.ts";

function depsConSaludRepo(saludRepo: InMemorySaludRepository = new InMemorySaludRepository()): AppDeps {
  // Cast deliberado: withHeartbeat solo lee `deps.saludRepo`, un AppDeps
  // completo no aporta nada a este test unitario.
  return { saludRepo } as unknown as AppDeps;
}

describe("withHeartbeat", () => {
  it("cuando el handler responde bien, registra un latido 'ok' y devuelve la MISMA response sin alterarla", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const deps = depsConSaludRepo(saludRepo);
    const respuestaReal = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const envuelto = withHeartbeat(deps, "/internal/test/cron", async () => respuestaReal);
    const respuesta = await envuelto();

    expect(respuesta).toBe(respuestaReal);
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos).toHaveLength(1);
    expect(latidos[0]).toMatchObject({ cronName: "/internal/test/cron", lastStatus: "ok", lastError: null, consecutiveFailures: 0 });
  });

  it("cuando el handler lanza, registra un latido 'error' con el mensaje real Y relanza EXACTAMENTE la misma excepción", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const deps = depsConSaludRepo(saludRepo);
    const errorReal = new Error("el conector externo devolvió 500");

    const envuelto = withHeartbeat(deps, "/internal/test/cron-roto", async () => {
      throw errorReal;
    });

    await expect(envuelto()).rejects.toBe(errorReal);
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]).toMatchObject({ cronName: "/internal/test/cron-roto", lastStatus: "error", lastError: "el conector externo devolvió 500", consecutiveFailures: 1 });
  });

  it("fallos consecutivos se acumulan en el latido, y un 'ok' los reinicia a 0", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const deps = depsConSaludRepo(saludRepo);

    const roto = withHeartbeat(deps, "/internal/test/intermitente", async () => {
      throw new Error("falla 1");
    });
    await expect(roto()).rejects.toThrow();
    await expect(roto()).rejects.toThrow();
    let latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]!.consecutiveFailures).toBe(2);

    const sano = withHeartbeat(deps, "/internal/test/intermitente", async () => new Response("ok"));
    await sano();
    latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]!.consecutiveFailures).toBe(0);
    expect(latidos[0]!.lastStatus).toBe("ok");
  });

  it("REGLA DURA: si `saludRepo.recordCronHeartbeat` falla, el error del latido NUNCA se propaga -- la response real del handler se devuelve intacta", async () => {
    const saludRepoRoto = { recordCronHeartbeat: vi.fn().mockRejectedValue(new Error("la tabla cron_heartbeat no existe")) } as unknown as InMemorySaludRepository;
    const deps = depsConSaludRepo(saludRepoRoto);
    const respuestaReal = new Response(JSON.stringify({ ok: true, dato: "real" }), { status: 200 });

    const envuelto = withHeartbeat(deps, "/internal/test/cron", async () => respuestaReal);
    const respuesta = await envuelto();

    expect(respuesta).toBe(respuestaReal);
    expect(await respuesta.json()).toEqual({ ok: true, dato: "real" });
  });

  it("REGLA DURA: si `saludRepo.recordCronHeartbeat` falla mientras el handler TAMBIÉN lanza, se relanza la excepción del handler (nunca la del latido)", async () => {
    const saludRepoRoto = { recordCronHeartbeat: vi.fn().mockRejectedValue(new Error("fallo al escribir el latido")) } as unknown as InMemorySaludRepository;
    const deps = depsConSaludRepo(saludRepoRoto);
    const errorDelHandler = new Error("el handler real falló por su cuenta");

    const envuelto = withHeartbeat(deps, "/internal/test/cron", async () => {
      throw errorDelHandler;
    });

    await expect(envuelto()).rejects.toBe(errorDelHandler);
  });

  it("r4-fix-crons-transaccion-por-unidad: CronPartialFailureError registra latido 'error' pero devuelve la Response ORIGINAL (200 + detalle), nunca la relanza al caller HTTP", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const deps = depsConSaludRepo(saludRepo);
    const respuestaParcial = new Response(JSON.stringify({ ok: false, failures: [{ organization_id: "org-1", error: "boom" }] }), { status: 200 });

    const envuelto = withHeartbeat(deps, "/internal/test/barrido-parcial", async () => {
      throw new CronPartialFailureError("1 unidad falló", respuestaParcial);
    });
    const respuesta = await envuelto();

    // El caller HTTP (Vercel Cron) recibe la Response 200 real, con el detalle
    // de failures -- nunca un 500 (las unidades que sí corrieron ya
    // persistieron, aisladas por transacción propia; no tiene sentido que el
    // scheduler la reintente completa).
    expect(respuesta).toBe(respuestaParcial);
    expect(respuesta.status).toBe(200);
    // Pero el latido SÍ queda como "error" -- el panel de salud no debe
    // mostrar "ok" limpio cuando una unidad real falló.
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]).toMatchObject({ cronName: "/internal/test/barrido-parcial", lastStatus: "error", lastError: "1 unidad falló", consecutiveFailures: 1 });
  });

  it("el mensaje de error se trunca a 500 caracteres antes de registrarlo", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const deps = depsConSaludRepo(saludRepo);
    const mensajeLargo = "x".repeat(1000);

    const envuelto = withHeartbeat(deps, "/internal/test/error-largo", async () => {
      throw new Error(mensajeLargo);
    });
    await expect(envuelto()).rejects.toThrow();

    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]!.lastError!.length).toBeLessThanOrEqual(500);
  });
});
