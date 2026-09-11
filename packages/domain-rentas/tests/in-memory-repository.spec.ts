import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { crearReservaConfirmada } from "../src/aplicacion/reservas.ts";

describe("InMemoryRentasRepository: calendario (delegado al store compartido)", () => {
  it("findUnidad no encuentra una unidad de OTRA property (aislamiento)", async () => {
    const store = new InMemoryRentasCalendarStore();
    const repo = new InMemoryRentasRepository(store);
    const propertyId = randomUUID();
    const unidadId = randomUUID();
    repo.seedUnidad({ id: unidadId, organizationId: randomUUID(), propertyId, duracionMinimaNoches: 1 });

    expect(await repo.findUnidad(propertyId, unidadId)).not.toBeNull();
    expect(await repo.findUnidad(randomUUID(), unidadId)).toBeNull();
  });

  it("findCanalPorCodigo resuelve el catálogo semilla ('manual', 'airbnb', etc.)", async () => {
    const repo = new InMemoryRentasRepository();
    expect(await repo.findCanalPorCodigo("manual")).not.toBeNull();
    expect(await repo.findCanalPorCodigo("no-existe")).toBeNull();
  });

  it("un ocupacionId creado por la transacción cruda (aplicacion/reservas.ts) es visible para attachGuestToOcupacion del repository -- mismo store compartido", async () => {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);
    const repo = new InMemoryRentasRepository(store);

    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const unidadId = randomUUID();
    repo.seedUnidad({ id: unidadId, organizationId, propertyId, duracionMinimaNoches: 1 });

    const resultado = await engine.withAppSession({ userId: null }, (session) =>
      crearReservaConfirmada(session, { organizationId, propertyId, unidadId, rango: { inicio: "2026-06-01", fin: "2026-06-03" }, estado: "confirmado", bloqueante: true }),
    );

    const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre: "Ana Pérez", contacto: "+52 55 1234 5678" });
    await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);

    const resumen = await repo.findOcupacion(propertyId, unidadId, resultado.ocupacionId);
    expect(resumen).not.toBeNull();
    expect(resumen!.capa).toBe("reserva");
  });
});

describe("InMemoryRentasRepository: finanzas", () => {
  it("findReglaComisionCanal prioriza la regla específica de la property sobre la global del tenant", async () => {
    const repo = new InMemoryRentasRepository();
    const propertyId = randomUUID();
    const canalId = randomUUID();
    repo.seedReglaComisionCanal({ propertyId: null, canalId, config: { yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "regla global" } });
    repo.seedReglaComisionCanal({ propertyId, canalId, config: { yaNetoDeComision: true, comisionBasisPoints: 0, fuente: "regla específica Airbnb" } });

    const resuelta = await repo.findReglaComisionCanal(propertyId, canalId);
    expect(resuelta.fuente).toBe("regla específica Airbnb");
  });

  it("cae a la regla global del tenant si no hay una específica de la property", async () => {
    const repo = new InMemoryRentasRepository();
    const canalId = randomUUID();
    repo.seedReglaComisionCanal({ propertyId: null, canalId, config: { yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "regla global" } });

    const resuelta = await repo.findReglaComisionCanal(randomUUID(), canalId);
    expect(resuelta.fuente).toBe("regla global");
  });

  it("fail-closed: lanza si no hay NINGUNA regla configurada (nunca asume 0%)", async () => {
    const repo = new InMemoryRentasRepository();
    await expect(repo.findReglaComisionCanal(randomUUID(), randomUUID())).rejects.toThrow(/No hay rentas.regla_comision_canal/);
  });

  it("insertReservaFinanciero respeta la unicidad 1:1 con ocupacionId (mismo criterio que el UNIQUE real)", async () => {
    const repo = new InMemoryRentasRepository();
    const ocupacionId = randomUUID();
    const input = {
      organizationId: randomUUID(),
      propertyId: randomUUID(),
      ocupacionId,
      moneda: "MXN",
      montoBrutoCentavos: 100000,
      yaNetoDeComision: true,
      comisionCanalBasisPoints: 0,
      comisionCanalFuente: "Airbnb",
      comisionCanalCentavos: 0,
      comisionGestorBasisPoints: 2000,
      comisionGestorBase: "neto_de_canal" as const,
      comisionGestorCentavos: 20000,
      montoRecibidoCentavos: 100000,
      gastos: [],
      gastosCentavos: 0,
      impuestos: [],
      impuestosCentavos: 0,
      netoCentavos: 80000,
      createdBy: randomUUID(),
    };
    await repo.insertReservaFinanciero(input);
    await expect(repo.insertReservaFinanciero(input)).rejects.toThrow(/ya existe un movimiento financiero/);
  });

  it("findReservaFinanciero no filtra entre properties -- aislamiento", async () => {
    const repo = new InMemoryRentasRepository();
    const ocupacionId = randomUUID();
    const propertyId = randomUUID();
    await repo.insertReservaFinanciero({
      organizationId: randomUUID(),
      propertyId,
      ocupacionId,
      moneda: "MXN",
      montoBrutoCentavos: 100000,
      yaNetoDeComision: true,
      comisionCanalBasisPoints: 0,
      comisionCanalFuente: "Airbnb",
      comisionCanalCentavos: 0,
      comisionGestorBasisPoints: 0,
      comisionGestorBase: "neto_de_canal",
      comisionGestorCentavos: 0,
      montoRecibidoCentavos: 100000,
      gastos: [],
      gastosCentavos: 0,
      impuestos: [],
      impuestosCentavos: 0,
      netoCentavos: 100000,
      createdBy: randomUUID(),
    });

    expect(await repo.findReservaFinanciero(propertyId, ocupacionId)).not.toBeNull();
    expect(await repo.findReservaFinanciero(randomUUID(), ocupacionId)).toBeNull();
  });
});
