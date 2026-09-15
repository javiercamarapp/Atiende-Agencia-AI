// Regresión del hallazgo de auditoría: varias funciones de
// `aplicacion/reservas.ts`/`limpieza/aplicacion/tareas.ts` hacían su PROPIO
// `BEGIN`/`COMMIT`/`ROLLBACK` sobre la MISMA sesión de Postgres que la capa de rutas
// (`dbSession`/`TenancyEngine.withAppSession`, ver packages/db/src/
// managed-postgres-engine.ts) ya había abierto ANTES de correr el handler
// (`begin` + `set local role authenticated` + `set_config('request.jwt.claim.sub',
// ...)`, todo con alcance de TRANSACCIÓN). En Postgres real, Postgres no anida
// transacciones: un segundo `BEGIN` dentro de una ya abierta es un no-op con
// WARNING, pero el `COMMIT` interno sí confirmaba de verdad la transacción EXTERNA
// de la request -- terminándola -- y con ella expiraba el contexto de sesión para
// todo lo que corriera después en el MISMO handler (permission denied, o RLS
// aplicado con el rol de conexión del pool en vez del rol de usuario real).
//
// El fix reemplaza esos `BEGIN`/`COMMIT`/`ROLLBACK` propios por
// `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, que sí anidan de verdad
// dentro de la transacción externa sin confirmarla ni revertirla nunca.
//
// LIMITACIÓN HONESTA: este entorno no tiene un Postgres real disponible para probar
// contra él directamente (`InMemoryRentasTenancyEngine` es el único motor de rentas
// con el que corren los tests de este paquete) — así que este archivo NO puede
// demostrar el síntoma exacto en producción (`set local role`/`set_config`
// perdidos tras un COMMIT interno prematuro, que solo Postgres real expone). Lo que
// SÍ puede probar, y prueba, es el invariante ESTRUCTURAL cuya violación causa ese
// síntoma: "ninguna función de esta capa emite un BEGIN/COMMIT/ROLLBACK crudo
// mientras ya corre dentro de la transacción externa que abrió `withAppSession`".
// Para eso, `InMemoryRentasTenancyEngine.exec()` fue ajustado (ver su propio
// comentario de cabecera) para LANZAR ante cualquier `BEGIN`/`COMMIT`/`ROLLBACK`
// crudo en vez de tolerarlo en silencio como antes -- si alguna función de
// `aplicacion/reservas.ts`/`limpieza/aplicacion/tareas.ts` reintrodujera el patrón
// viejo, el describe de abajo ("regresión end-to-end") volvería a fallar de
// inmediato en CI, sin necesidad de un Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { cancelarOcupacion, crearBloqueo, crearReservaConfirmada, modificarFechasReserva } from "../src/aplicacion/reservas.ts";
import { crearTareaLimpiezaPorCheckout, crearTareaOperativaManual } from "../src/limpieza/aplicacion/tareas.ts";
import type { UnidadRecord } from "../src/types.ts";

describe("InMemoryRentasTenancyEngine: detecta un BEGIN/COMMIT/ROLLBACK crudo dentro de la transacción externa", () => {
  it("lanza si algo emite BEGIN mientras ya corre dentro de withAppSession", async () => {
    const engine = new InMemoryRentasTenancyEngine();
    await expect(
      engine.withAppSession({ userId: null }, async (session) => {
        await session.exec("BEGIN");
      }),
    ).rejects.toThrow(/BEGIN\/COMMIT\/ROLLBACK/);
  });

  it("lanza si algo emite COMMIT mientras ya corre dentro de withAppSession", async () => {
    const engine = new InMemoryRentasTenancyEngine();
    await expect(
      engine.withAppSession({ userId: null }, async (session) => {
        await session.exec("COMMIT");
      }),
    ).rejects.toThrow(/BEGIN\/COMMIT\/ROLLBACK/);
  });

  it("lanza si algo emite ROLLBACK mientras ya corre dentro de withAppSession", async () => {
    const engine = new InMemoryRentasTenancyEngine();
    await expect(
      engine.withAppSession({ userId: null }, async (session) => {
        await session.exec("ROLLBACK");
      }),
    ).rejects.toThrow(/BEGIN\/COMMIT\/ROLLBACK/);
  });

  it("SAVEPOINT/RELEASE SAVEPOINT/ROLLBACK TO SAVEPOINT sí se aceptan (son la forma correcta de anidar)", async () => {
    const engine = new InMemoryRentasTenancyEngine();
    await expect(
      engine.withAppSession({ userId: null }, async (session) => {
        await session.exec("SAVEPOINT sp_x");
        await session.exec("RELEASE SAVEPOINT sp_x");
        await session.exec("SAVEPOINT sp_y");
        await session.exec("ROLLBACK TO SAVEPOINT sp_y");
        await session.exec("RELEASE SAVEPOINT sp_y");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("regresión end-to-end: las operaciones que antes hacían BEGIN/COMMIT interno siguen funcionando dentro de UNA sola transacción externa", () => {
  it("crearReservaConfirmada + crearTareaLimpiezaPorCheckout + crearBloqueo + modificarFechasReserva + cancelarOcupacion + crearTareaOperativaManual, todas en el MISMO withAppSession (una sola request real), sin perder el contexto de la sesión", async () => {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);

    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const userId = randomUUID();
    const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1 };
    store.seedUnidad(unidad);

    // Mismo patrón que `requirePropertyMembership`: si el contexto de la sesión
    // (claims.userId) sobreviviera solo "por accidente" a un COMMIT interno
    // prematuro en Postgres real, aquí se detectaría porque esta consulta de
    // membership se ejecuta DESPUÉS de toda la secuencia de escrituras de abajo,
    // usando la MISMA sesión/`claims` capturada al abrir `withAppSession` una sola
    // vez para todo el bloque -- exactamente como una request real de dos pasos.
    engine.seedProperty({ id: propertyId, organizationId });
    engine.seedMembership({ userId, organizationId, propertyIds: null, platformRole: "admin", verticalRole: "admin_gestora" });

    // TODO el flujo corre dentro de UNA sola llamada a `withAppSession` -- la misma
    // forma en que `dbSession` abre UNA transacción por request y el handler HTTP
    // hace ahí dentro todas sus llamadas de dominio con el mismo `TenantDbSession`
    // (ver apps/api/src/routes/verticals/rentas/*.ts). Si cualquiera de las
    // funciones de abajo todavía emitiera un `BEGIN`/`COMMIT`/`ROLLBACK` crudo, el
    // `exec()` ajustado de `InMemoryRentasTenancyEngine` lanzaría de inmediato y
    // este test fallaría.
    const resultadoFinal = await engine.withAppSession({ userId }, async (session) => {
      const reserva = await crearReservaConfirmada(session, {
        organizationId,
        propertyId,
        unidadId: unidad.id,
        rango: { inicio: "2026-06-01", fin: "2026-06-05" },
        estado: "confirmado",
        bloqueante: true,
        externalId: "e2e-reserva",
      });
      expect(reserva.conflicto).toBeNull();

      // Buffer por defecto (CONFIGURACION_OPERATIVA_DEFECTO) = 1 noche -> crea el
      // bloqueo BUFFER_LIMPIEZA en [2026-06-05, 2026-06-06), justo después del
      // checkout -- sin solapar la reserva ni el bloqueo de mantenimiento de abajo.
      const tareaLimpieza = await crearTareaLimpiezaPorCheckout(session, {
        unidadId: unidad.id,
        ocupacionUnidadId: reserva.ocupacionId,
        fechaCheckout: "2026-06-05",
      });
      expect(tareaLimpieza.bufferOcupacionId).not.toBeNull();

      // Bloqueo de mantenimiento en fechas totalmente distintas -- reutiliza el
      // MISMO advisory lock de unidad ya sostenido por esta sesión (reentrante,
      // nunca se encola detrás de sí misma).
      const bloqueoMantenimiento = await crearBloqueo(session, {
        organizationId,
        propertyId,
        unidadId: unidad.id,
        rango: { inicio: "2026-07-01", fin: "2026-07-03" },
        razon: "MANTENIMIENTO",
      });
      expect(bloqueoMantenimiento.conflictosCapaCruzada).toHaveLength(0);

      // Reduce la reserva original -- no toca el buffer ([06-05,06-06)) ni el
      // bloqueo de mantenimiento (julio), así que no debería registrar conflicto.
      const modificada = await modificarFechasReserva(session, reserva.ocupacionId, { inicio: "2026-06-01", fin: "2026-06-03" });
      expect(modificada.conflicto).toBeNull();
      expect(modificada.rangoEfectivo).toEqual({ inicio: "2026-06-01", fin: "2026-06-03" });

      const cancelada = await cancelarOcupacion(session, reserva.ocupacionId);
      expect(cancelada.estadoAnterior).toBe("confirmado");

      const tareaManual = await crearTareaOperativaManual(session, {
        unidadId: unidad.id,
        tipo: "mantenimiento",
        programadaPara: "2026-07-10",
      });

      // El contexto de la sesión (claims.userId) sigue vivo DESPUÉS de toda la
      // secuencia de escrituras de arriba -- la consulta de membership, que
      // depende de `claims.userId`, sigue resolviendo la fila sembrada al
      // principio en vez de quedarse sin contexto (lo que pasaría en Postgres
      // real si algo de arriba hubiera hecho un COMMIT crudo a mitad de camino).
      const membership = await session.query(
        `select m.organization_id, m.platform_role, m.vertical_role
         from core.membership m
         join core.property p on p.organization_id = m.organization_id
         where p.id = $1
           and m.user_id = auth.uid()
           and (m.property_ids is null or p.id = any(m.property_ids));`,
        [propertyId],
      );
      expect(membership.rows).toHaveLength(1);

      return { reservaId: reserva.ocupacionId, tareaLimpiezaId: tareaLimpieza.tareaId, bloqueoMantenimientoId: bloqueoMantenimiento.ocupacionId, tareaManualId: tareaManual.tareaId };
    });

    // Estado final coherente -- las seis operaciones realmente persistieron sus
    // efectos dentro de la ÚNICA transacción externa, ninguna se perdió ni quedó a
    // medias por culpa de un COMMIT/ROLLBACK ajeno.
    expect(store.getOcupacion(resultadoFinal.reservaId)?.estado).toBe("cancelado");

    const tareaLimpieza = store.getTareaOperativa(resultadoFinal.tareaLimpiezaId);
    expect(tareaLimpieza?.tipo).toBe("limpieza");
    expect(tareaLimpieza?.bufferOcupacionId).not.toBeNull();

    expect(store.getOcupacion(resultadoFinal.bloqueoMantenimientoId)?.estado).toBe("confirmado");

    const tareaManual = store.getTareaOperativa(resultadoFinal.tareaManualId);
    expect(tareaManual?.tipo).toBe("mantenimiento");
    expect(tareaManual?.ocupacionUnidadId).toBeNull();
  });
});
