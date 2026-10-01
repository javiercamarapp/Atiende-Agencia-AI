import { describe, expect, it, vi } from "vitest";
import { atenderAlertaSync, fetchConflictos, fetchMonitorSync, resolverConflicto } from "../src/verticals/rentas/lib/ical-monitor-client.ts";

const OCUPACION_A = { id: "o1", inicio: "2027-05-10", fin: "2027-05-14", estado: "confirmado", capa: "reserva", canal: "airbnb" };
const OCUPACION_B = { id: "o2", inicio: "2027-05-12", fin: "2027-05-16", estado: "conflicto_pendiente", capa: "reserva", canal: "booking" };

describe("fetchMonitorSync", () => {
  it("pide GET .../sync-monitor y mapea el wire snake_case a camelCase", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/sync-monitor");
      return new Response(
        JSON.stringify({
          ahora: "2026-10-01T12:00:00.000Z",
          feeds: [
            { id: "f1", unidad_id: "u1", unidad_nombre: "Casa", canal: "airbnb", activo: true, salud: "en_backoff", ultima_sincronizacion_exitosa_en: null, en_cuarentena_desde: null, motivo_cuarentena: null, intentos_fallidos_consecutivos: 2, ultimo_intento_en: "2026-10-01T11:00:00.000Z", proximo_intento_en: "2026-10-01T12:30:00.000Z" },
          ],
          alertas: { disponible: true, abiertas: [{ id: "a1", unidad_id: "u1", unidad_nombre: "Casa", canal: "booking", tipo: "conflicto_detectado", severidad: "critica", detalle: "x", eventos_aplicados: 1, conflictos: 1, creado_en: "2026-10-01T11:00:00.000Z" }] },
          conflictos_abiertos: 1,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await fetchMonitorSync(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(r.alertasDisponibles).toBe(true);
    expect(r.conflictosAbiertos).toBe(1);
    expect(r.feeds[0]).toMatchObject({ id: "f1", salud: "en_backoff", intentosFallidosConsecutivos: 2, proximoIntentoEn: "2026-10-01T12:30:00.000Z" });
    expect(r.alertas[0]).toMatchObject({ id: "a1", severidad: "critica", conflictos: 1, creadoEn: "2026-10-01T11:00:00.000Z" });
  });

  it("un 403 del servidor es un error real con su mensaje", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchMonitorSync(fetchImpl, "http://api.local", "tok", "prop-1")).rejects.toThrow(/permiso/);
  });
});

describe("fetchConflictos / resolverConflicto / atenderAlertaSync", () => {
  it("lista los conflictos abiertos con ambas reservas y su canal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/conflictos?estado=abiertos");
      return new Response(JSON.stringify({ total_abiertos: 1, conflictos: [{ id: "k1", unidad_id: "u1", unidad_nombre: "Casa", tipo: "overbooking_confirmado", detectado_en: "2026-10-01T11:00:00.000Z", resuelto_en: null, ocupacion_a: OCUPACION_A, ocupacion_b: OCUPACION_B }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchConflictos(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(r.totalAbiertos).toBe(1);
    expect(r.conflictos[0]).toMatchObject({ id: "k1", tipo: "overbooking_confirmado", ocupacionA: { canal: "airbnb" }, ocupacionB: { canal: "booking" }, resueltoEn: null });
  });

  it("resolver y atender hacen POST real a su ruta con cuerpo vacío", async () => {
    const llamadas: [string, string | undefined][] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push([url, init?.method]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolverConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1");
    await atenderAlertaSync(fetchImpl, "http://api.local", "tok", "prop-1", "a1");
    expect(llamadas).toEqual([
      ["http://api.local/rentas/prop-1/conflictos/k1/resolver", "POST"],
      ["http://api.local/rentas/prop-1/sync-alertas/a1/atender", "POST"],
    ]);
  });

  it("un 409 (migración pendiente) llega como error legible", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Resolver conflictos aún no está disponible en este ambiente (migración pendiente)." }), { status: 409 })) as unknown as typeof fetch;
    await expect(resolverConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1")).rejects.toThrow(/aún no está disponible/);
  });
});
