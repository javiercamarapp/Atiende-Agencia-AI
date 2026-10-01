import { describe, expect, it, vi } from "vitest";
import { atenderAlertaSync, decidirConflicto, fetchConflictos, fetchHistorialConflicto, fetchMonitorSync, resolverConflicto, validarMotivoDecision } from "../src/verticals/rentas/lib/ical-monitor-client.ts";

const OCUPACION_A = { id: "o1", inicio: "2027-05-10", fin: "2027-05-14", estado: "confirmado", capa: "reserva", canal: "airbnb" };
const OCUPACION_B = { id: "o2", inicio: "2027-05-12", fin: "2027-05-16", estado: "conflicto_pendiente", capa: "reserva", canal: "booking" };

describe("fetchMonitorSync", () => {
  it("pide GET .../sync-monitor y mapea el wire snake_case a camelCase", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/sync-monitor");
      return new Response(
        JSON.stringify({
          ahora: "2026-10-01T12:00:00.000Z",
          zona_horaria: "America/Cancun",
          resumen_por_canal: [{ canal: "airbnb", total_feeds: 1, peor: "en_backoff", unidades_con_problema: 1, por_salud: { ok: 0, desactualizado: 0, en_backoff: 1, en_cuarentena: 0, sin_sincronizar: 0, inactivo: 0 }, sincronizacion_mas_antigua_en: null }],
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
    expect(r.zonaHoraria).toBe("America/Cancun");
    expect(r.resumenPorCanal).toEqual([{ canal: "airbnb", totalFeeds: 1, peor: "en_backoff", unidadesConProblema: 1, porSalud: expect.objectContaining({ en_backoff: 1 }), sincronizacionMasAntiguaEn: null }]);
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
      return new Response(
        JSON.stringify({
          zona_horaria: "America/Cancun",
          total_abiertos: 1,
          conflictos: [
            {
              id: "k1", estado: "abierto", motivo_resolucion: null, unidad_id: "u1", unidad_nombre: "Casa", tipo: "overbooking_confirmado", detectado_en: "2026-10-01T11:00:00.000Z",
              detectado_en_local: "2026-10-01 06:00", resuelto_en: null, resuelto_en_local: null, resuelto_por_mi: false, solape: { inicio: "2027-05-12", fin: "2027-05-14", vigencia: "futuro" },
              ocupacion_a: OCUPACION_A, ocupacion_b: OCUPACION_B,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await fetchConflictos(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(r.totalAbiertos).toBe(1);
    expect(r.zonaHoraria).toBe("America/Cancun");
    expect(r.conflictos[0]).toMatchObject({
      id: "k1", estado: "abierto", tipo: "overbooking_confirmado", ocupacionA: { canal: "airbnb" }, ocupacionB: { canal: "booking" }, resueltoEn: null,
      detectadoEnLocal: "2026-10-01 06:00", solape: { inicio: "2027-05-12", fin: "2027-05-14", vigencia: "futuro" }, resueltoPorMi: false, motivoResolucion: null,
    });
  });

  it("pide cada filtro de estado en la query", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ zona_horaria: "America/Cancun", total_abiertos: 0, conflictos: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    for (const estado of ["abiertos", "resueltos", "ignorados", "todos"] as const) await fetchConflictos(fetchImpl, "http://api.local", "tok", "prop-1", estado);
    expect(urls.map((u) => u.split("?")[1])).toEqual(["estado=abiertos", "estado=resueltos", "estado=ignorados", "estado=todos"]);
  });

  it("resolver, ignorar con motivo y atender hacen POST real a su ruta con el cuerpo esperado", async () => {
    const llamadas: [string, string | undefined, unknown][] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push([url, init?.method, JSON.parse(String(init?.body))]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolverConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1");
    await decidirConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1", { accion: "ignorado", motivo: "  mismo huésped  " });
    await decidirConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1", { accion: "resuelto", motivo: "se canceló en Booking" });
    await atenderAlertaSync(fetchImpl, "http://api.local", "tok", "prop-1", "a1");
    expect(llamadas).toEqual([
      ["http://api.local/rentas/prop-1/conflictos/k1/resolver", "POST", { accion: "resuelto" }],
      ["http://api.local/rentas/prop-1/conflictos/k1/resolver", "POST", { accion: "ignorado", motivo: "mismo huésped" }],
      ["http://api.local/rentas/prop-1/conflictos/k1/resolver", "POST", { accion: "resuelto", motivo: "se canceló en Booking" }],
      ["http://api.local/rentas/prop-1/sync-alertas/a1/atender", "POST", {}],
    ]);
  });

  it("ignorar sin motivo (o con uno de menos de 3 caracteres) falla ANTES de llamar a la red", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(decidirConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1", { accion: "ignorado" })).rejects.toThrow(/motivo/);
    await expect(decidirConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1", { accion: "ignorado", motivo: " ab " })).rejects.toThrow(/motivo/);
    await expect(decidirConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1", { accion: "resuelto", motivo: "x".repeat(501) })).rejects.toThrow(/500/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(validarMotivoDecision({ accion: "ignorado", motivo: "abc" })).toBeNull();
    expect(validarMotivoDecision({ accion: "resuelto" })).toBeNull();
  });

  it("el 409 de 'solape vigente' llega con su mensaje para que la pantalla lo muestre", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Las dos reservas siguen cruzadas: cancela una en su canal y vuelve a sincronizar, o ignora el conflicto indicando el motivo." }), { status: 409 })) as unknown as typeof fetch;
    await expect(resolverConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1")).rejects.toThrow(/siguen cruzadas/);
  });

  it("fetchHistorialConflicto mapea la bitácora y respeta disponible: false", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/conflictos/k1/historial");
      return new Response(JSON.stringify({ disponible: true, zona_horaria: "America/Cancun", entradas: [{ id: "h1", accion: "ignorado", motivo: "mismo huésped", creado_en: "2027-01-01T05:30:00Z", creado_en_local: "2027-01-01 00:30", por_mi: true }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchHistorialConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1")).toEqual({
      disponible: true,
      zonaHoraria: "America/Cancun",
      entradas: [{ id: "h1", accion: "ignorado", motivo: "mismo huésped", creadoEnLocal: "2027-01-01 00:30", porMi: true }],
    });
    const sinTabla = vi.fn(async () => new Response(JSON.stringify({ disponible: false, zona_horaria: "America/Cancun", entradas: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchHistorialConflicto(sinTabla, "http://api.local", "tok", "prop-1", "k1")).toMatchObject({ disponible: false, entradas: [] });
  });

  it("un 409 (migración pendiente) llega como error legible", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Resolver conflictos aún no está disponible en este ambiente (migración pendiente)." }), { status: 409 })) as unknown as typeof fetch;
    await expect(resolverConflicto(fetchImpl, "http://api.local", "tok", "prop-1", "k1")).rejects.toThrow(/aún no está disponible/);
  });
});
