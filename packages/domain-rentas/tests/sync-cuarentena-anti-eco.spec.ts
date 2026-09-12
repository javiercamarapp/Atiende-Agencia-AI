import { describe, expect, it } from "vitest";
import { aplicarResultadoCiclo, ESTADO_FEED_INICIAL } from "../src/sync/cuarentena.ts";
import { detectarEco } from "../src/sync/anti-eco.ts";
import { calcularBackoffMs, reconciliarCompleto } from "../src/sync/reconciliacion.ts";
import { construirUidExportado } from "../src/ical/exportador.ts";

describe("aplicarResultadoCiclo", () => {
  it("no entra en cuarentena antes de cruzar el umbral de intentos fallidos", () => {
    let estado = ESTADO_FEED_INICIAL;
    for (let i = 0; i < 2; i++) {
      const r = aplicarResultadoCiclo(estado, "fallo_red", "2026-01-01T00:00:00Z");
      estado = r.estado;
      expect(r.alerta).toBeNull();
    }
    expect(estado.enCuarentenaDesde).toBeNull();
  });

  it("activa cuarentena al cruzar el umbral y emite alerta una sola vez", () => {
    let estado = ESTADO_FEED_INICIAL;
    let alertas = 0;
    for (let i = 0; i < 3; i++) {
      const r = aplicarResultadoCiclo(estado, "fallo_red", "2026-01-01T00:00:00Z", { umbralIntentosFallidos: 3, huboEventosActivosPreviamente: false });
      estado = r.estado;
      if (r.alerta) alertas++;
    }
    expect(estado.enCuarentenaDesde).not.toBeNull();
    expect(alertas).toBe(1);

    // Un cuarto fallo consecutivo, ya en cuarentena, emite alerta "persistente".
    const r4 = aplicarResultadoCiclo(estado, "fallo_red", "2026-01-01T00:05:00Z", { umbralIntentosFallidos: 3, huboEventosActivosPreviamente: false });
    expect(r4.alerta?.tipo).toBe("cuarentena_persistente");
  });

  it("un éxito resetea el contador y sale de cuarentena", () => {
    const enCuarentena = { ultimaSincronizacionExitosaEn: null, enCuarentenaDesde: "2026-01-01T00:00:00Z", intentosFallidosConsecutivos: 5, motivoCuarentena: "x" };
    const r = aplicarResultadoCiclo(enCuarentena, "exito_con_eventos", "2026-01-02T00:00:00Z");
    expect(r.estado.enCuarentenaDesde).toBeNull();
    expect(r.estado.intentosFallidosConsecutivos).toBe(0);
    expect(r.alerta).toBeNull();
  });

  it("emite 'vacio_inesperado' cuando el feed pasa a 0 eventos pero antes tenía activos", () => {
    const r = aplicarResultadoCiclo(ESTADO_FEED_INICIAL, "exito_vacio", "2026-01-01T00:00:00Z", { umbralIntentosFallidos: 3, huboEventosActivosPreviamente: true });
    expect(r.alerta?.tipo).toBe("vacio_inesperado");
  });

  it("no_modificado (304) resetea fallos sin tratarse como éxito con datos nuevos", () => {
    const previo = { ultimaSincronizacionExitosaEn: "2026-01-01T00:00:00Z", enCuarentenaDesde: null, intentosFallidosConsecutivos: 1, motivoCuarentena: null };
    const r = aplicarResultadoCiclo(previo, "no_modificado", "2026-01-02T00:00:00Z");
    expect(r.estado.intentosFallidosConsecutivos).toBe(0);
    expect(r.alerta).toBeNull();
  });

  it("nunca marca éxito falso: fallo_parseo también cuenta para el umbral de cuarentena", () => {
    let estado = ESTADO_FEED_INICIAL;
    for (let i = 0; i < 3; i++) {
      estado = aplicarResultadoCiclo(estado, "fallo_parseo", "2026-01-01T00:00:00Z", { umbralIntentosFallidos: 3, huboEventosActivosPreviamente: false }).estado;
    }
    expect(estado.enCuarentenaDesde).not.toBeNull();
    expect(estado.motivoCuarentena).toMatch(/parseo/);
  });
});

describe("detectarEco", () => {
  it("capa 1: detecta el namespace propio de exportación en el UID entrante", () => {
    const uid = construirUidExportado("ocupacion-1");
    const r = detectarEco({ uidEntrante: uid, hashContenidoEntrante: "cualquiera", hashesExportadosRecientes: [], canalesExportadosDeRangoCoincidente: [] });
    expect(r).toEqual({ esEco: true, capa: 1, motivo: expect.any(String) });
  });

  it("capa 2: detecta un hash de contenido que coincide con lo exportado recientemente", () => {
    const r = detectarEco({ uidEntrante: "externo@canal.com", hashContenidoEntrante: "hash-x", hashesExportadosRecientes: ["hash-a", "hash-x"], canalesExportadosDeRangoCoincidente: [] });
    expect(r.esEco).toBe(true);
    expect(r.capa).toBe(2);
  });

  it("capa 3: detecta que el rango coincidente ya se exportó a algún canal", () => {
    const r = detectarEco({ uidEntrante: "externo@canal.com", hashContenidoEntrante: "no-coincide", hashesExportadosRecientes: [], canalesExportadosDeRangoCoincidente: ["canal-vrbo"] });
    expect(r.esEco).toBe(true);
    expect(r.capa).toBe(3);
  });

  it("no es eco cuando ninguna de las tres señales coincide", () => {
    const r = detectarEco({ uidEntrante: "externo@canal.com", hashContenidoEntrante: "no-coincide", hashesExportadosRecientes: [], canalesExportadosDeRangoCoincidente: [] });
    expect(r).toEqual({ esEco: false, capa: null, motivo: expect.any(String) });
  });
});

describe("reconciliarCompleto / calcularBackoffMs", () => {
  it("detecta drift cuando un UID activo internamente ya no aparece en el feed", () => {
    const activos = [{ ocupacionId: "o1", uidCanal: "u1" }, { ocupacionId: "o2", uidCanal: "u2" }];
    const r = reconciliarCompleto(activos, new Set(["u1"]));
    expect(r.drift).toBe(1);
    expect(r.candidatosACancelarPorAusencia).toEqual([{ ocupacionId: "o2", uidCanal: "u2" }]);
  });

  it("sin drift cuando todos los UIDs activos siguen presentes en el feed", () => {
    const activos = [{ ocupacionId: "o1", uidCanal: "u1" }];
    const r = reconciliarCompleto(activos, new Set(["u1", "u2"]));
    expect(r.drift).toBe(0);
  });

  it("calcularBackoffMs crece exponencialmente con tope, y respeta Retry-After", () => {
    const opciones = { baseMs: 1000, maxMs: 60_000, factor: 2 };
    expect(calcularBackoffMs(1, opciones)).toBe(1000);
    expect(calcularBackoffMs(2, opciones)).toBe(2000);
    expect(calcularBackoffMs(3, opciones)).toBe(4000);
    expect(calcularBackoffMs(20, opciones)).toBe(60_000); // tope
    expect(calcularBackoffMs(1, opciones, 5)).toBe(5000); // Retry-After gana
  });
});
