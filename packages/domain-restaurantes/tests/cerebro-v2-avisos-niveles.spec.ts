// Cerebro v2, bloque 7 (SUELTO-VS-718-V2.md B7): avisos al personal como en el suelto, adaptados a callback_requests + emitirNotificacion.
//  - Dedupe por CATEGORÍA (avisoAbiertoQueCubre/planDeAviso del suelto, 30 min, misma sucursal): un segundo aviso de la misma categoría con un abierto se
//    anexa al abierto (no crea otro); si no aporta texto nuevo, no se registra nada.
//  - Niveles (alertas-operativas del suelto: repetición cada 10 min hasta el nivel 3): el tick existente /internal/restaurantes/promover-programados
//    repite la notificación crítica de un aviso URGENTE sin resolver con la llave por nivel (llaveConNivel).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barrerAvisosUrgentesSinResolver } from "../src/avisos-operativos.ts";
import { llaveConNivel, nivelDebido, planDeAviso } from "../src/whatsapp/cerebro-v2/avisos.ts";
import { executeAgentToolSafely, razonDelSueltoParaDedupe } from "../src/agent-tools/registry.ts";
import { nuevoViaje } from "./qa-viaje/arnes-viaje.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

describe("dedupe por categoría en escalar_a_humano (cerebro v2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T19:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("dos avisos de post-venta en 10 min: el segundo se anexa al abierto (una sola fila); sin cerebro v2, dos filas", async () => {
    for (const cerebroV2 of [true, false]) {
      vi.setSystemTime(new Date("2026-10-13T19:00:00-06:00"));
      const v = await nuevoViaje();
      const ctx = { organizationId: v.world.organizationId, channel: "whatsapp" as const, phone: "+5219995550111", entryPropertyId: v.t7, ...(cerebroV2 ? { cerebroV2: true } : {}) };
      const a = await executeAgentToolSafely(v.world.repo, { ...ctx, sourceEventId: "wamid.a" }, "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "Llegaron fríos los tacos" });
      expect(a.result).not.toHaveProperty("error");
      vi.setSystemTime(new Date("2026-10-13T19:10:00-06:00"));
      const b = await executeAgentToolSafely(v.world.repo, { ...ctx, sourceEventId: "wamid.b" }, "escalar_a_humano", { customer_name: "Ana", motivo: "cancelacion_modificacion", resumen: "Faltó la coca del pedido" });
      expect(b.result).not.toHaveProperty("error");
      const abiertos = ((await v.world.repo.listarAvisosDelTelefono!(v.world.organizationId, "+5219995550111", 2)) ?? []).filter((f) => !f.resolved);
      expect(abiertos).toHaveLength(cerebroV2 ? 1 : 2);
      if (cerebroV2) expect(abiertos[0]!.message).toMatch(/coca/);
    }
  });

  it("paridad: la decisión es la de planDeAviso del suelto con las razones traducidas", () => {
    const ahora = Date.parse("2026-10-13T19:10:00-06:00");
    const filas = [{ id: "a1", reason: razonDelSueltoParaDedupe("escalada:queja", "llegaron frios"), message: "llegaron frios", branch_id: "p1", created_at: new Date(ahora - 10 * 60_000).toISOString(), resolved: false }];
    expect(planDeAviso(filas, razonDelSueltoParaDedupe("escalada:cancelacion_modificacion", "falto la coca"), ahora, { branchId: "p1", message: "falto la coca" }).accion).toBe("anexar");
    expect(planDeAviso(filas, razonDelSueltoParaDedupe("escalada:alergia_salud", "alergia al cacahuate"), ahora, { branchId: "p1", message: "alergia" }).accion).toBe("registrar");
  });
});

describe("niveles: repetición de los avisos URGENTES sin resolver en el tick", () => {
  it("emite la notificación crítica con la llave del nivel que toca (10 min de umbral, cada 10 min, tope 3)", async () => {
    const ahora = new Date("2026-10-13T20:00:00Z");
    const ID = "00000000-0000-4000-8000-0000000000e1";
    const creado = new Date(ahora.getTime() - 31 * 60_000);
    const emisiones: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /avisos_urgentes_sin_resolver/, respond: () => [{ id: ID, organization_id: "00000000-0000-4000-8000-0000000000b1", property_id: null, created_at: creado.toISOString() }] },
      { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (/emit_notification/.test(sql)) emisiones.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const r = await barrerAvisosUrgentesSinResolver(session, ahora);
    const nivel = nivelDebido(creado, ahora, 10);
    expect(nivel).toBe(3);
    expect(r.emitidas).toBe(1);
    expect(emisiones[0]![2]).toBe("restaurantes.callback.pendiente");
    expect(emisiones[0]![4]).toBe("critica");
    expect(emisiones[0]![10]).toBe(`restaurantes.callback.pendiente:${llaveConNivel(ID, nivel)}`);
  });

  it("base sin la 193 (42883): no hay nada que barrer y la sesión sigue viva", async () => {
    const err = Object.assign(new Error("function restaurantes.avisos_urgentes_sin_resolver(timestamp with time zone, integer) does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /avisos_urgentes_sin_resolver/, respond: () => err },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const r = await barrerAvisosUrgentesSinResolver(session, new Date());
    expect(r.disponible).toBe(false);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});
