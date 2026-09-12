// Tests reales del owner statement (Fase 2, Flujo 5): agregación pura
// (generarOwnerStatement/calcularHashStatement/esMismoContenidoQueVersionAnterior) +
// un test de concurrencia real sobre `bloquearOwnerStatementEnTransaccion` -- mismo
// patrón que el test de concurrencia de `bloquearUnidadEnTransaccion`
// (tests/reservas.spec.ts), sin Postgres real.
import { describe, expect, it } from "vitest";
import { generarOwnerStatement, calcularHashStatement, esMismoContenidoQueVersionAnterior } from "../src/finanzas/statement.ts";
import type { ReservaParaStatement } from "../src/finanzas/statement.ts";
import { bloquearOwnerStatementEnTransaccion } from "../src/ejecutor.ts";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";

function reserva(overrides: Partial<ReservaParaStatement> & { ocupacionId: string }): ReservaParaStatement {
  return {
    moneda: "MXN",
    ingresoBrutoCentavos: 600000,
    comisionCanalCentavos: 0,
    comisionGestorCentavos: 120000,
    gastosCentavos: 30000,
    impuestosCentavos: 0,
    netoCentavos: 450000,
    ...overrides,
  };
}

describe("generarOwnerStatement", () => {
  it("agrega totales correctos y genera una línea de ingreso + comisión + gasto por cada reserva", () => {
    const resultado = generarOwnerStatement({
      ownerId: "owner-1",
      propertyId: "property-1",
      periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
      moneda: "MXN",
      reservas: [reserva({ ocupacionId: "b" }), reserva({ ocupacionId: "a" })],
    });

    expect(resultado.totales.ingresosBrutosCentavos).toBe(1200000);
    expect(resultado.totales.comisionGestorCentavos).toBe(240000);
    expect(resultado.totales.gastosCentavos).toBe(60000);
    expect(resultado.totales.netoCentavos).toBe(900000);
    // ingreso + comisión_gestor + gasto por cada una de las 2 reservas (sin comisión de
    // canal ni impuesto porque ambos vienen en 0 -- nunca una línea de monto 0).
    expect(resultado.lineas).toHaveLength(6);
  });

  it("el hash es estable sin importar el orden de entrada de las reservas", () => {
    const a = generarOwnerStatement({
      ownerId: "owner-1",
      propertyId: "property-1",
      periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
      moneda: "MXN",
      reservas: [reserva({ ocupacionId: "a" }), reserva({ ocupacionId: "b" })],
    });
    const b = generarOwnerStatement({
      ownerId: "owner-1",
      propertyId: "property-1",
      periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
      moneda: "MXN",
      reservas: [reserva({ ocupacionId: "b" }), reserva({ ocupacionId: "a" })],
    });
    expect(a.hashContenido).toBe(b.hashContenido);
  });

  it("un cambio real de contenido (un gasto distinto) produce un hash distinto", () => {
    const a = generarOwnerStatement({ ownerId: "owner-1", propertyId: "property-1", periodo: { inicio: "2026-06-01", fin: "2026-07-01" }, moneda: "MXN", reservas: [reserva({ ocupacionId: "a" })] });
    const b = generarOwnerStatement({
      ownerId: "owner-1",
      propertyId: "property-1",
      periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
      moneda: "MXN",
      reservas: [reserva({ ocupacionId: "a", gastosCentavos: 99999 })],
    });
    expect(a.hashContenido).not.toBe(b.hashContenido);
  });

  it("lanza si no hay ninguna reserva -- un statement sin movimientos no tiene sentido", () => {
    expect(() => generarOwnerStatement({ ownerId: "owner-1", propertyId: "property-1", periodo: { inicio: "2026-06-01", fin: "2026-07-01" }, moneda: "MXN", reservas: [] })).toThrow();
  });

  it("lanza si una reserva viene en una moneda distinta al statement -- el motor nunca convierte tipo de cambio", () => {
    expect(() =>
      generarOwnerStatement({
        ownerId: "owner-1",
        propertyId: "property-1",
        periodo: { inicio: "2026-06-01", fin: "2026-07-01" },
        moneda: "MXN",
        reservas: [reserva({ ocupacionId: "a", moneda: "USD" })],
      }),
    ).toThrow();
  });
});

describe("calcularHashStatement / esMismoContenidoQueVersionAnterior", () => {
  it("esMismoContenidoQueVersionAnterior es false cuando no hay versión anterior (null)", () => {
    const hash = calcularHashStatement("owner-1", "property-1", { inicio: "2026-06-01", fin: "2026-07-01" }, "MXN", []);
    expect(esMismoContenidoQueVersionAnterior(hash, null)).toBe(false);
  });

  it("esMismoContenidoQueVersionAnterior es true cuando el hash coincide exacto", () => {
    const hash = calcularHashStatement("owner-1", "property-1", { inicio: "2026-06-01", fin: "2026-07-01" }, "MXN", []);
    expect(esMismoContenidoQueVersionAnterior(hash, hash)).toBe(true);
  });

  it("esMismoContenidoQueVersionAnterior es false cuando el hash difiere", () => {
    const hash = calcularHashStatement("owner-1", "property-1", { inicio: "2026-06-01", fin: "2026-07-01" }, "MXN", []);
    expect(esMismoContenidoQueVersionAnterior(hash, "otro-hash-cualquiera")).toBe(false);
  });
});

describe("concurrencia real: bloquearOwnerStatementEnTransaccion serializa dos generaciones del MISMO (owner, property, periodo)", () => {
  it("de dos intentos concurrentes con el MISMO contenido, exactamente uno crea y el otro reusa -- nunca ambos crean, nunca un error sin manejar (réplica de la corrección D-DSD-15 del repo origen, ver diseño §1.3/§4.2)", async () => {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);

    // Simula el estado persistido de `rentas.owner_statement` para esta clave --
    // deliberadamente un array simple (no un Map atómico) para que la carrera sea
    // real si el lock no sirviera: dos lecturas de `versiones.at(-1)` ANTES de que
    // cualquiera escriba producirían dos "creaciones" en vez de una.
    const versiones: Array<{ version: number; hash: string }> = [];

    async function intentarGenerar(hashCalculado: string): Promise<{ creado: boolean; version: number }> {
      return engine.withAppSession({ userId: null }, async (session) => {
        await bloquearOwnerStatementEnTransaccion(session, "owner-1", "property-1", "2026-06-01", "2026-07-01");
        // Punto de suspensión real (equivalente al round-trip de red de una query SQL
        // real) -- si el lock no sirviera, ambas ramas paralelas llegarían aquí antes
        // de que cualquiera empuje a `versiones`.
        await Promise.resolve();
        const anterior = versiones.at(-1) ?? null;
        if (anterior && esMismoContenidoQueVersionAnterior(hashCalculado, anterior.hash)) {
          return { creado: false, version: anterior.version };
        }
        const version = (anterior?.version ?? 0) + 1;
        versiones.push({ version, hash: hashCalculado });
        return { creado: true, version };
      });
    }

    const mismoHash = calcularHashStatement("owner-1", "property-1", { inicio: "2026-06-01", fin: "2026-07-01" }, "MXN", []);
    const [a, b] = await Promise.all([intentarGenerar(mismoHash), intentarGenerar(mismoHash)]);

    const resultados = [a, b];
    expect(resultados.filter((r) => r.creado)).toHaveLength(1);
    expect(resultados.filter((r) => !r.creado)).toHaveLength(1);
    expect(versiones).toHaveLength(1); // nunca dos filas para la misma clave
    // La request que reusó ve la MISMA versión que la que creó -- nunca 0 ni undefined.
    expect(a.version).toBe(b.version);
  });

  it("dos periodos DISTINTOS del mismo owner nunca se bloquean entre sí", async () => {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);
    const orden: string[] = [];

    async function marcar(periodoInicio: string, periodoFin: string, etiqueta: string) {
      return engine.withAppSession({ userId: null }, async (session) => {
        await bloquearOwnerStatementEnTransaccion(session, "owner-1", "property-1", periodoInicio, periodoFin);
        orden.push(`inicio:${etiqueta}`);
        await Promise.resolve();
        orden.push(`fin:${etiqueta}`);
      });
    }

    await Promise.all([marcar("2026-06-01", "2026-07-01", "junio"), marcar("2026-07-01", "2026-08-01", "julio")]);

    // Ambos "inicio" ocurren antes de que ninguno mutuamente bloquee al otro -- si
    // compartieran lock, se verían intercalados como inicio/fin/inicio/fin.
    expect(orden.slice(0, 2).sort()).toEqual(["inicio:julio", "inicio:junio"]);
  });
});
