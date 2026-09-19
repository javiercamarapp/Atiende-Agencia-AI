// Test real (sin mocks) del mecanismo de romper-cristal -- cubre los tres requisitos
// literales del gap: (1) razón obligatoria capturada en cada acceso, (2) SIEMPRE queda
// un registro de auditoría de quién/cuándo/por qué/qué datos exactos, (3) fail-closed:
// si la auditoría no se puede persistir, no hay datos entregados.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryBreakGlassAuditRepository } from "../../src/break-glass/audit-repository.ts";
import { InMemoryBreakGlassRentasDataRepository } from "../../src/break-glass/data-repository.ts";
import type { BreakGlassRentasDataRepository } from "../../src/break-glass/data-repository.ts";
import {
  leerDatosTenantBreakGlass,
  leerFinanzasTenantBreakGlass,
  leerLimpiezaTenantBreakGlass,
  leerMensajeriaTenantBreakGlass,
  leerPayoutsTenantBreakGlass,
  leerPricingTenantBreakGlass,
  leerReservasTenantBreakGlass,
  leerSyncIcalTenantBreakGlass,
  validarRazonBreakGlass,
} from "../../src/break-glass/acceso.ts";
import {
  BreakGlassAuditWriteFailedError,
  BreakGlassOrganizationRequiredError,
  BreakGlassReasonRequiredError,
} from "../../src/break-glass/errors.ts";
import { BREAK_GLASS_MIN_REASON_LENGTH } from "../../src/break-glass/tipos.ts";
import type { BreakGlassAccessInput, BreakGlassReservaResumen, SuperadminActor } from "../../src/break-glass/tipos.ts";

const ACTOR: SuperadminActor = { userId: randomUUID(), email: "superadmin@atiende.dev" };
const RAZON_VALIDA = "Ticket SOP-4821: el tenant reporta un cobro duplicado, investigar sus reservas.";
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function inputBase(organizationId: string, overrides: Partial<BreakGlassAccessInput> = {}): BreakGlassAccessInput {
  return {
    actor: ACTOR,
    organizationId,
    reason: RAZON_VALIDA,
    resourceType: "reservas",
    resourceScope: {},
    ...overrides,
  };
}

describe("validarRazonBreakGlass", () => {
  it("acepta una razón que alcanza el mínimo tras trim() y la devuelve ya trimeada", () => {
    const razon = validarRazonBreakGlass(`   ${RAZON_VALIDA}   `);
    expect(razon).toBe(RAZON_VALIDA);
  });

  it(`rechaza una razón vacía`, () => {
    expect(() => validarRazonBreakGlass("")).toThrow(BreakGlassReasonRequiredError);
  });

  it("rechaza una razón de solo espacios (no es un 'placeholder' válido aunque tenga longitud)", () => {
    expect(() => validarRazonBreakGlass("                    ")).toThrow(BreakGlassReasonRequiredError);
  });

  it(`rechaza una razón más corta que BREAK_GLASS_MIN_REASON_LENGTH (${BREAK_GLASS_MIN_REASON_LENGTH})`, () => {
    const corta = "a".repeat(BREAK_GLASS_MIN_REASON_LENGTH - 1);
    expect(() => validarRazonBreakGlass(corta)).toThrow(BreakGlassReasonRequiredError);
  });

  it("acepta exactamente en el límite (frontera correcta, ni off-by-one de más ni de menos)", () => {
    const exacta = "a".repeat(BREAK_GLASS_MIN_REASON_LENGTH);
    expect(validarRazonBreakGlass(exacta)).toBe(exacta);
  });

  it("el error trae actualLength/minLength para que el llamador arme un mensaje sin volver a parsear", () => {
    try {
      validarRazonBreakGlass("urgente");
      expect.unreachable("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(BreakGlassReasonRequiredError);
      const e = err as BreakGlassReasonRequiredError;
      expect(e.actualLength).toBe(7);
      expect(e.minLength).toBe(BREAK_GLASS_MIN_REASON_LENGTH);
      expect(e.code).toBe("break_glass_reason_required");
    }
  });
});

describe("leerDatosTenantBreakGlass -- el requisito central: razón obligatoria ANTES de ejecutar nada", () => {
  it("sin razón válida, NUNCA ejecuta el lector -- ni un intento de lectura se dispara", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgId = randomUUID();
    let lectorLlamado = false;

    await expect(
      leerDatosTenantBreakGlass(
        auditRepo,
        inputBase(orgId, { reason: "muy corta" }),
        async () => {
          lectorLlamado = true;
          return [];
        },
        () => ({}),
        NOW,
      ),
    ).rejects.toThrow(BreakGlassReasonRequiredError);

    expect(lectorLlamado).toBe(false);
    expect(auditRepo.entries).toHaveLength(0);
  });

  it("sin organizationId, lanza BreakGlassOrganizationRequiredError sin ejecutar el lector", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    let lectorLlamado = false;

    await expect(
      leerDatosTenantBreakGlass(
        auditRepo,
        inputBase("", {}),
        async () => {
          lectorLlamado = true;
          return [];
        },
        () => ({}),
        NOW,
      ),
    ).rejects.toThrow(BreakGlassOrganizationRequiredError);
    expect(lectorLlamado).toBe(false);
  });
});

describe("leerDatosTenantBreakGlass -- SIEMPRE queda un registro de auditoría de quién/cuándo/por qué/qué se vio", () => {
  it("un acceso exitoso persiste una fila con actor, organización, razón, tipo de recurso y el resumen EXACTO de lo devuelto", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgId = randomUUID();
    const datosFalsos = ["reserva-1", "reserva-2", "reserva-3"];

    const { data, auditEntry } = await leerDatosTenantBreakGlass(
      auditRepo,
      inputBase(orgId, { resourceScope: { propertyId: "prop-1" } }),
      async () => datosFalsos,
      (d) => ({ total: d.length, ids: d }),
      NOW,
    );

    expect(data).toEqual(datosFalsos);
    expect(auditEntry.actorUserId).toBe(ACTOR.userId);
    expect(auditEntry.actorEmail).toBe(ACTOR.email);
    expect(auditEntry.organizationId).toBe(orgId);
    expect(auditEntry.reason).toBe(RAZON_VALIDA);
    expect(auditEntry.resourceType).toBe("reservas");
    expect(auditEntry.resourceScope).toEqual({ propertyId: "prop-1" });
    expect(auditEntry.resultSummary).toEqual({ total: 3, ids: datosFalsos });
    expect(auditEntry.occurredAtMs).toBe(NOW);
    expect(auditEntry.seq).toBeGreaterThan(0);
    expect(auditEntry.hash).toBeTruthy();

    expect(auditRepo.entries).toHaveLength(1);
    expect(auditRepo.entries[0]).toEqual(auditEntry);
  });

  it("dos accesos del mismo superadmin a la misma organización el mismo día producen DOS filas -- nunca se colapsan (a diferencia del dedupe diario de core-authz/impersonation)", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgId = randomUUID();

    await leerDatosTenantBreakGlass(auditRepo, inputBase(orgId), async () => "a", () => ({}), NOW);
    await leerDatosTenantBreakGlass(auditRepo, inputBase(orgId), async () => "b", () => ({}), NOW + 1000);

    expect(auditRepo.entries).toHaveLength(2);
    expect(auditRepo.entries[0]!.seq).not.toBe(auditRepo.entries[1]!.seq);
  });

  it("la cadena encadena por organización: prevHash de la segunda fila es el hash de la primera; organizaciones distintas empiezan cadenas independientes", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgA = randomUUID();
    const orgB = randomUUID();

    const r1 = await leerDatosTenantBreakGlass(auditRepo, inputBase(orgA), async () => "x", () => ({}), NOW);
    const r2 = await leerDatosTenantBreakGlass(auditRepo, inputBase(orgA), async () => "y", () => ({}), NOW + 1);
    const r3 = await leerDatosTenantBreakGlass(auditRepo, inputBase(orgB), async () => "z", () => ({}), NOW + 2);

    expect(r1.auditEntry.prevHash).toBeNull();
    expect(r2.auditEntry.prevHash).toBe(r1.auditEntry.hash);
    // orgB es una cadena nueva -- su primera fila también arranca sin prevHash, pese a
    // no ser la primera fila de la TABLA (la de orgA ya tenía dos).
    expect(r3.auditEntry.prevHash).toBeNull();
  });
});

describe("leerDatosTenantBreakGlass -- fail-closed: sin fila de auditoría persistida, NO hay datos entregados", () => {
  it("si auditRepo.record falla, la función lanza BreakGlassAuditWriteFailedError y NUNCA devuelve los datos ya leídos", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgId = randomUUID();
    const fallaOriginal = new Error("conexión a la base caída");
    auditRepo.fallarSiguiente(fallaOriginal);

    let dataFueLeidaPorElLector = false;

    await expect(
      leerDatosTenantBreakGlass(
        auditRepo,
        inputBase(orgId),
        async () => {
          dataFueLeidaPorElLector = true;
          return ["dato-sensible-del-tenant"];
        },
        () => ({}),
        NOW,
      ),
    ).rejects.toThrow(BreakGlassAuditWriteFailedError);

    // La lectura SÍ se ejecutó (así se pudo construir el resumen a auditar), pero eso
    // nunca escapó de esta función hacia el llamador -- el `await expect(...).rejects`
    // de arriba es la prueba de que ningún `.then`/retorno normal entregó `data`.
    expect(dataFueLeidaPorElLector).toBe(true);
    expect(auditRepo.entries).toHaveLength(0);
  });

  it("el error fail-closed conserva la causa original para diagnóstico", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const causaOriginal = new Error("constraint violada");
    auditRepo.fallarSiguiente(causaOriginal);

    try {
      await leerDatosTenantBreakGlass(auditRepo, inputBase(randomUUID()), async () => null, () => ({}), NOW);
      expect.unreachable("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(BreakGlassAuditWriteFailedError);
      expect((err as BreakGlassAuditWriteFailedError).cause).toBe(causaOriginal);
    }
  });

  it("si el LECTOR mismo falla (antes de producir datos), el error se propaga tal cual -- no se inserta ninguna fila 'intento fallido'", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fallaDeLectura = new Error("timeout consultando rentas.ocupacion");

    await expect(
      leerDatosTenantBreakGlass(
        auditRepo,
        inputBase(randomUUID()),
        async () => {
          throw fallaDeLectura;
        },
        () => ({}),
        NOW,
      ),
    ).rejects.toBe(fallaDeLectura);

    expect(auditRepo.entries).toHaveLength(0);
  });
});

describe("leerReservasTenantBreakGlass -- la composición concreta para resourceType='reservas'", () => {
  function reserva(overrides: Partial<BreakGlassReservaResumen> = {}): BreakGlassReservaResumen {
    return {
      ocupacionId: randomUUID(),
      propertyId: randomUUID(),
      unidadId: randomUUID(),
      checkIn: "2026-09-20",
      checkOut: "2026-09-25",
      estado: "confirmado",
      huespedNombre: "Huésped de Prueba",
      huespedContacto: "huesped@ejemplo.mx",
      ...overrides,
    };
  }

  it("lee las reservas del tenant correcto y audita EXACTAMENTE los ids devueltos + el total", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const reservasOrgA = [reserva(), reserva()];
    const reservasOrgB = [reserva()];
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(
      new Map([
        [orgA, reservasOrgA],
        [orgB, reservasOrgB],
      ]),
    );

    const { data, auditEntry } = await leerReservasTenantBreakGlass(
      auditRepo,
      dataRepo,
      { actor: ACTOR, organizationId: orgA, reason: RAZON_VALIDA },
      NOW,
    );

    expect(data).toEqual(reservasOrgA);
    expect(data).not.toEqual(reservasOrgB);
    expect(auditEntry.resourceType).toBe("reservas");
    expect(auditEntry.resultSummary).toEqual({
      total: 2,
      ocupacionIds: reservasOrgA.map((r) => r.ocupacionId),
    });
  });

  it("un tenant sin reservas produce un resultado vacío pero SIGUE auditando el acceso (total: 0 también es 'qué se vio')", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const orgId = randomUUID();
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map());

    const { data, auditEntry } = await leerReservasTenantBreakGlass(
      auditRepo,
      dataRepo,
      { actor: ACTOR, organizationId: orgId, reason: RAZON_VALIDA },
      NOW,
    );

    expect(data).toEqual([]);
    expect(auditEntry.resultSummary).toEqual({ total: 0, ocupacionIds: [] });
    expect(auditRepo.entries).toHaveLength(1);
  });

  it("sin razón obligatoria, ni siquiera intenta leer las reservas del tenant", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(
      new Map([[randomUUID(), [reserva()]]]),
    );
    let seLlamoAlDataRepo = false;
    // Espía deliberadamente parcial (solo implementa el método que este test
    // ejercita) -- cast explícito a BreakGlassRentasDataRepository porque el
    // resto de métodos del puerto (Fase 10c) nunca se invocan aquí: la
    // aserción real es `seLlamoAlDataRepo` en false (ni siquiera
    // listReservasTenant debería llamarse sin una razón válida).
    const dataRepoEspia = {
      listReservasTenant: async (id: string, callerId: string) => {
        seLlamoAlDataRepo = true;
        return dataRepo.listReservasTenant(id, callerId);
      },
    } as unknown as BreakGlassRentasDataRepository;

    await expect(
      leerReservasTenantBreakGlass(auditRepo, dataRepoEspia, { actor: ACTOR, organizationId: randomUUID(), reason: "no" }, NOW),
    ).rejects.toThrow(BreakGlassReasonRequiredError);
    expect(seLlamoAlDataRepo).toBe(false);
  });
});

// Fase 10c -- los 6 lectores restantes (ver ../../src/break-glass/tipos.ts y
// ../../migrations/020_break_glass_lectores.sql). Todos comparten
// `crearLectorTenantBreakGlass` (misma fábrica interna de acceso.ts) con
// `leerReservasTenantBreakGlass` ya probado arriba -- este bloque NO repite los
// 3 requisitos genéricos (razón obligatoria/auditoría/fail-closed, ya cubiertos
// por `leerDatosTenantBreakGlass`/`leerReservasTenantBreakGlass` arriba), solo
// verifica lo que es específico de cada composición nueva: (1) lee del método
// de puerto correcto, con el organizationId/callerId correctos, (2) el
// resourceType auditado es el correcto, (3) el resumen auditado es
// `{ total, ids }` sobre el campo `id` de CADA tipo de recurso, (4) el filtro
// por propiedad (`resourceScope.propertyId`) SÍ llega hasta el método de
// puerto -- para al menos uno de los 6 (representativo, mismo criterio que el
// resto de este archivo: no duplicar 6 veces la misma aserción).
describe("Fase 10c -- los 6 lectores restantes (finanzas/payouts/pricing/mensajeria/limpieza/sync_ical)", () => {
  const ORG_ID = randomUUID();

  it("leerFinanzasTenantBreakGlass: lee finanzas del tenant correcto y audita { total, ids } con resourceType='finanzas'", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), ocupacionId: randomUUID(), propertyId: randomUUID(), moneda: "MXN", montoBrutoCentavos: 500000, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 450000, createdAtMs: NOW };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map([[ORG_ID, [fila]]]));

    const { data, auditEntry } = await leerFinanzasTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);

    expect(data).toEqual({ disponible: true, datos: [fila] });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("finanzas");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
  });

  it("leerPayoutsTenantBreakGlass: resourceType='payouts'", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), propertyId: randomUUID(), canalId: randomUUID(), referenciaExterna: null, moneda: "MXN", montoTotalCentavos: 100000, fechaPayout: "2026-09-01", creadoEnMs: NOW };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map(), new Map([[ORG_ID, [fila]]]));

    const { auditEntry } = await leerPayoutsTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("payouts");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
  });

  it("leerPricingTenantBreakGlass: resourceType='pricing'", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), precioNocheCentavos: 150000, moneda: "MXN", vigenteDesde: "2026-01-01" };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map(), new Map(), new Map([[ORG_ID, [fila]]]));

    const { auditEntry } = await leerPricingTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("pricing");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
  });

  it("leerMensajeriaTenantBreakGlass: resourceType='mensajeria'", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), canalCodigo: "airbnb", huespedNombre: "Ana", fechaCheckIn: "2026-10-01", fechaCheckOut: "2026-10-05", reservaConfirmada: true, creadoEnMs: NOW };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map(), new Map(), new Map(), new Map([[ORG_ID, [fila]]]));

    const { auditEntry } = await leerMensajeriaTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("mensajeria");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
  });

  it("leerLimpiezaTenantBreakGlass: resourceType='limpieza' (cubre limpieza/mantenimiento/inspeccion)", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), tipo: "mantenimiento", estado: "pendiente", prioridad: "alta", programadaPara: "2026-09-25", completadaEnMs: null, creadoEnMs: NOW };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map(), new Map(), new Map(), new Map(), new Map([[ORG_ID, [fila]]]));

    const { auditEntry } = await leerLimpiezaTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("limpieza");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
  });

  it("leerSyncIcalTenantBreakGlass: resourceType='sync_ical', y el resumen auditado NUNCA lleva la URL completa (solo ids)", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const fila = { id: randomUUID(), propertyId: randomUUID(), unidadId: randomUUID(), canalId: randomUUID(), urlImportacionEnmascarada: "https://www.airbnb.com/***", activo: true, ultimaSincronizacionExitosaEnMs: NOW, enCuarentenaDesdeMs: null, intentosFallidosConsecutivos: 0, motivoCuarentena: null };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map([[ORG_ID, [fila]]]));

    const { data, auditEntry } = await leerSyncIcalTenantBreakGlass(auditRepo, dataRepo, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);
    expect(data).toEqual({ disponible: true, datos: [fila] });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.resourceType).toBe("sync_ical");
    expect(auditEntry!.resultSummary).toEqual({ total: 1, ids: [fila.id] });
    expect(JSON.stringify(auditEntry!.resultSummary)).not.toContain("airbnb.com");
  });

  it("filtro por propiedad: resourceScope.propertyId llega hasta el método de puerto (representativo, finanzas)", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const propertyIdBuscado = randomUUID();
    const filaDeOtraPropiedad = { id: randomUUID(), ocupacionId: randomUUID(), propertyId: randomUUID(), moneda: "MXN", montoBrutoCentavos: 1, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 1, createdAtMs: NOW };
    const filaDeLaPropiedadBuscada = { ...filaDeOtraPropiedad, id: randomUUID(), propertyId: propertyIdBuscado };
    const dataRepo = new InMemoryBreakGlassRentasDataRepository(new Map(), new Map([[ORG_ID, [filaDeOtraPropiedad, filaDeLaPropiedadBuscada]]]));

    const { data } = await leerFinanzasTenantBreakGlass(
      auditRepo,
      dataRepo,
      { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA, resourceScope: { propertyId: propertyIdBuscado } },
      NOW,
    );

    expect(data).toEqual({ disponible: true, datos: [filaDeLaPropiedadBuscada] });
  });

  it("lector NO disponible (disponible: false, migración 020 pendiente): NO audita -- auditEntry es null y no se escribe ninguna fila en la bitácora", async () => {
    const auditRepo = new InMemoryBreakGlassAuditRepository();
    const dataRepoNoDisponible: BreakGlassRentasDataRepository = {
      listReservasTenant: async () => [],
      listFinanzasTenant: async () => ({ disponible: false, datos: [] }),
      listPayoutsTenant: async () => ({ disponible: true, datos: [] }),
      listPricingTenant: async () => ({ disponible: true, datos: [] }),
      listMensajeriaTenant: async () => ({ disponible: true, datos: [] }),
      listLimpiezaTenant: async () => ({ disponible: true, datos: [] }),
      listSyncIcalTenant: async () => ({ disponible: true, datos: [] }),
    };

    const { data, auditEntry } = await leerFinanzasTenantBreakGlass(auditRepo, dataRepoNoDisponible, { actor: ACTOR, organizationId: ORG_ID, reason: RAZON_VALIDA }, NOW);

    expect(data).toEqual({ disponible: false, datos: [] });
    expect(auditEntry).toBeNull();
    expect(await auditRepo.listForActor(ACTOR.userId)).toEqual([]);
  });
});
