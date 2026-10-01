// Rn-01 -- funciones puras de lease/backoff/bitácora/salud del monitor.
import { describe, expect, it } from "vitest";
import { calcularBackoffFeedSegundos, eventosBitacoraDeCiclo } from "../src/sync/lease.ts";
import { clasificarSaludFeed, type FeedMonitorRecord } from "../src/sync/monitor.ts";
import type { ResultadoImportarCiclo } from "../src/sync/motor.ts";

function ciclo(parcial: Partial<ResultadoImportarCiclo>): ResultadoImportarCiclo {
  return { resultado: "exito_con_eventos", eventosEnFeed: 0, eventosAplicados: 0, ecosDescartados: 0, conflictosDetectados: 0, alertaCuarentena: null, revisionesUidReciclado: [], eventosDescartadosPorError: [], candidatosACancelarPorAusencia: [], ...parcial };
}

describe("calcularBackoffFeedSegundos (espejo de rentas.ical_backoff_segundos)", () => {
  it("1 fallo -> 30 min, 2 -> 60 min, 3 -> 2 h, 4 -> 4 h, 5 o más -> 6 h (tope)", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 99].map(calcularBackoffFeedSegundos)).toEqual([1800, 3600, 7200, 14_400, 21_600, 21_600, 21_600, 21_600]);
  });

  it("sin dato, 0 o negativos cuentan como un fallo (un fallo siempre espera)", () => {
    expect([null, undefined, 0, -3, Number.NaN].map((n) => calcularBackoffFeedSegundos(n as number))).toEqual([1800, 1800, 1800, 1800, 1800]);
  });
});

describe("eventosBitacoraDeCiclo", () => {
  it("una corrida sin cambios ni incidencias no genera ninguna fila (no inflar la bitácora a 15 min)", () => {
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "no_modificado" }))).toEqual([]);
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "exito_con_eventos", eventosEnFeed: 3 }))).toEqual([]);
  });

  it("cambios aplicados sin conflicto: una fila informativa", () => {
    const eventos = eventosBitacoraDeCiclo(ciclo({ eventosAplicados: 2 }));
    expect(eventos).toEqual([{ tipo: "sync_con_cambios", severidad: "info", detalle: "2 evento(s) aplicado(s)", eventosAplicados: 2, conflictos: 0 }]);
  });

  it("un conflicto entre canales (overbooking) siempre es una alerta crítica y reemplaza a la fila informativa", () => {
    const eventos = eventosBitacoraDeCiclo(ciclo({ eventosAplicados: 1, conflictosDetectados: 1 }));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ tipo: "conflicto_detectado", severidad: "critica", conflictos: 1, eventosAplicados: 1 });
  });

  it("un fallo bajo el umbral es informativo; al activar la cuarentena es crítico; persistente es aviso", () => {
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "fallo_red" }))[0]).toMatchObject({ tipo: "sync_fallido", severidad: "info" });
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "fallo_red", alertaCuarentena: { tipo: "cuarentena_activada", motivo: "3 intentos" } }))).toEqual([
      { tipo: "cuarentena_activada", severidad: "critica", detalle: "3 intentos", eventosAplicados: 0, conflictos: 0 },
    ]);
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "fallo_parseo", alertaCuarentena: { tipo: "cuarentena_persistente", motivo: "sigue" } }))[0]).toMatchObject({ tipo: "cuarentena_persistente", severidad: "aviso" });
  });

  it("un feed vacío inesperado es un aviso, y los eventos descartados por error agregan un aviso aparte", () => {
    expect(eventosBitacoraDeCiclo(ciclo({ resultado: "exito_vacio", alertaCuarentena: { tipo: "vacio_inesperado", motivo: "0 eventos" } }))[0]).toMatchObject({ tipo: "vacio_inesperado", severidad: "aviso" });
    const eventos = eventosBitacoraDeCiclo(ciclo({ eventosDescartadosPorError: [{ uid: "a", error: "x" }] }));
    expect(eventos).toEqual([{ tipo: "sync_fallido", severidad: "aviso", detalle: "1 evento(s) del feed descartado(s) por error", eventosAplicados: 0, conflictos: 0 }]);
  });

  it("nunca incluye la URL del feed en el detalle", () => {
    const todos = [
      ...eventosBitacoraDeCiclo(ciclo({ resultado: "fallo_red" })),
      ...eventosBitacoraDeCiclo(ciclo({ resultado: "fallo_parseo" })),
      ...eventosBitacoraDeCiclo(ciclo({ conflictosDetectados: 2, eventosAplicados: 2 })),
    ];
    for (const e of todos) expect(e.detalle).not.toMatch(/https?:/i);
  });
});

describe("clasificarSaludFeed", () => {
  const AHORA = Date.parse("2026-10-01T12:00:00Z");
  const base: FeedMonitorRecord = {
    id: "f", unidadId: "u", unidadNombre: "U", canalCodigo: "airbnb", activo: true,
    ultimaSincronizacionExitosaEn: "2026-10-01T11:50:00Z", enCuarentenaDesde: null, intentosFallidosConsecutivos: 0, motivoCuarentena: null,
    ultimoIntentoEn: null, proximoIntentoEn: null, leaseHasta: null,
  };

  it("ok / desactualizado / sin_sincronizar / inactivo", () => {
    expect(clasificarSaludFeed(base, AHORA)).toBe("ok");
    expect(clasificarSaludFeed({ ...base, ultimaSincronizacionExitosaEn: "2026-10-01T10:00:00Z" }, AHORA)).toBe("desactualizado");
    expect(clasificarSaludFeed({ ...base, ultimaSincronizacionExitosaEn: null }, AHORA)).toBe("sin_sincronizar");
    expect(clasificarSaludFeed({ ...base, activo: false }, AHORA)).toBe("inactivo");
  });

  it("en_cuarentena gana sobre en_backoff, y en_backoff solo mientras proximoIntentoEn sea futuro", () => {
    expect(clasificarSaludFeed({ ...base, enCuarentenaDesde: "2026-10-01T09:00:00Z", proximoIntentoEn: "2026-10-01T13:00:00Z" }, AHORA)).toBe("en_cuarentena");
    expect(clasificarSaludFeed({ ...base, proximoIntentoEn: "2026-10-01T13:00:00Z" }, AHORA)).toBe("en_backoff");
    expect(clasificarSaludFeed({ ...base, proximoIntentoEn: "2026-10-01T11:00:00Z" }, AHORA)).toBe("ok");
  });
});
