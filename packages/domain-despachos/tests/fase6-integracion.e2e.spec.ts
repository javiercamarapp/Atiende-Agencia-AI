// Test de integración end-to-end (Fase 6, requerido por la tarea) — encadena
// las capas reales, sin mocks, para las tres áreas nuevas de esta fase:
//
//   1. Cierre mensual: abre un período real vía `InMemoryDespachosRepository.
//      insertPeriodoCierre` -> corre `autoCheckTareas` -> intenta cerrar
//      (falla, tareas manuales pendientes) -> completa las tareas manuales
//      restantes -> cierra -> el repositorio persiste el estado final.
//   2. Bookkeeping: clasifica un CFDI por reglas (sin override) -> genera su
//      póliza -> valida que cuadre contra el catálogo SAT real.
//   3. Devolución de IVA: dos facturas del mismo proveedor -> genera DIOT ->
//      concilia contra una declaración real -> calcula saldo a favor y monto
//      de devolución -> prepara la solicitud.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "../src/cierre-mensual/templates.ts";
import { autoCheckTareas, completarTarea, evaluarCierre, cerrarPeriodo, estaPeriodoCerrado } from "../src/cierre-mensual/engine.ts";
import { CierreValidacionError } from "../src/errors.ts";
import { predecirCategoria, necesitaRevisionHumana } from "../src/bookkeeping/clasificador.ts";
import { generatePoliza, validatePoliza } from "../src/bookkeeping/rules-engine.ts";
import type { CfdiClassification } from "../src/bookkeeping/types.ts";
import { generarDiotDevolucionIva, conciliarDiotDeclaracion, calcularSaldoFavor, calcularMontoDevolucion, prepararSolicitud } from "../src/devolucion-iva/calculo.ts";
import type { DeclaracionMensualIva, FacturaCfdiIva } from "../src/devolucion-iva/types.ts";

describe("integración e2e (Fase 6): cierre mensual completo, con bloqueo real de re-cierre", () => {
  it("abre, auto-completa lo posible, bloquea el cierre con tareas manuales pendientes, y cierra tras completarlas", async () => {
    const repo = new InMemoryDespachosRepository();
    const propertyId = randomUUID();

    const { periodo, tareas: tareasIniciales } = await repo.insertPeriodoCierre({ organizationId: randomUUID(), propertyId, anio: 2026, mes: 3, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    expect(estaPeriodoCerrado(periodo)).toBe(false);

    // Auto-check: todas las señales automáticas en verde salvo bancos (sin
    // auto_check_query propio — la tarea "revisar movimientos sin conciliar"
    // es manual por diseño de la plantilla).
    const { tareas: tras1 } = autoCheckTareas(
      tareasIniciales,
      {
        cfdi_pending_count: 0,
        cfdi_validacion: true,
        bank_feeds_sync_status: "ok",
        nomina_status: "timbrada",
        diot_generada: true,
        declaraciones_revisadas: true,
        contabilidad_electronica: true,
        auxiliares_actualizados: true,
        reportes_gerenciales: true,
      },
      "system",
      new Date().toISOString(),
    );
    let tareas = await repo.replaceTareasCierre(periodo.id, tras1);

    // No todas las tareas tienen auto_check_query (varias son explícitamente
    // manuales en la plantilla) -- el cierre debe seguir bloqueado.
    const { puedeCerrar: puedeCerrarAntes, faltantes } = evaluarCierre(tareas);
    expect(puedeCerrarAntes).toBe(false);
    expect(faltantes.length).toBeGreaterThan(0);
    expect(() => cerrarPeriodo(periodo, tareas, "admin-1", new Date().toISOString())).toThrow(CierreValidacionError);

    // Completa manualmente las tareas restantes (simulando al contador).
    for (const t of tareas.filter((x) => x.status === "pending" || x.status === "blocked")) {
      if (t.status === "blocked") continue; // se resuelven solas al completar sus dependencias, en orden.
      tareas = completarTarea(tareas, t.id, "contador-1", new Date().toISOString());
    }
    // Repite hasta que ya no queden bloqueadas resolubles (cascada completa).
    let pendientesOBloqueadas = tareas.filter((t) => t.status === "pending" || t.status === "blocked");
    while (pendientesOBloqueadas.length > 0) {
      const siguiente = tareas.find((t) => t.status === "pending");
      if (!siguiente) break;
      tareas = completarTarea(tareas, siguiente.id, "contador-1", new Date().toISOString());
      pendientesOBloqueadas = tareas.filter((t) => t.status === "pending" || t.status === "blocked");
    }
    tareas = await repo.replaceTareasCierre(periodo.id, tareas);

    const { puedeCerrar } = evaluarCierre(tareas);
    expect(puedeCerrar).toBe(true);

    const cerrado = cerrarPeriodo(periodo, tareas, "admin-1", new Date().toISOString());
    await repo.updatePeriodoCierre(cerrado);

    const periodoPersistido = await repo.findPeriodoCierre(propertyId, periodo.id);
    expect(periodoPersistido?.status).toBe("closed");
    expect(estaPeriodoCerrado(periodoPersistido)).toBe(true);

    // Re-cerrar el mismo período (ya persistido como closed) debe rechazarse
    // -- corrección de fidelidad de esta fase (el Python original no lo valida).
    expect(() => cerrarPeriodo(periodoPersistido!, tareas, "admin-1", new Date().toISOString())).toThrow(CierreValidacionError);
  });
});

describe("integración e2e (Fase 6): bookkeeping — clasificar -> generar póliza -> validar", () => {
  it("un CFDI de honorarios se clasifica, genera una póliza balanceada y pasa validate_poliza", () => {
    const overrides = new Map<string, string>();
    const prediccion = predecirCategoria("Honorarios por servicios de consultoría profesional", "I", "PROV010101AAA", overrides);
    expect(prediccion.categoria).toBe("servicios_profesionales");
    expect(necesitaRevisionHumana(prediccion.confidence)).toBe(false); // 0.5+2*0.15=0.8 >= CONFIDENCE_MEDIUM (0.6)

    const classification: CfdiClassification = {
      cfdiUuid: randomUUID(),
      rfcEmisor: "PROV010101AAA",
      rfcReceptor: "DESP010101AB1",
      descripcion: "Honorarios por servicios de consultoría profesional",
      subtotal: 10000,
      iva: 1600,
      total: 11600,
      tasaIva: 0.16,
      tipoCfdi: "I",
      categoria: prediccion.categoria,
      confidence: prediccion.confidence,
      needsHumanReview: necesitaRevisionHumana(prediccion.confidence),
    };
    const poliza = generatePoliza(classification, "tenant-1");
    expect(poliza).not.toBeNull();
    const conFecha = { ...poliza!, fecha: "2026-03-15" };
    expect(conFecha.cuadrada).toBe(true);
    expect(validatePoliza(conFecha)).toEqual([]);
  });
});

describe("integración e2e (Fase 6): devolución de IVA — facturas -> DIOT -> saldo -> solicitud", () => {
  it("dos facturas del mismo proveedor producen una solicitud lista para envío (monto bajo umbral)", () => {
    const facturas: FacturaCfdiIva[] = [
      { uuid: randomUUID(), rfcEmisor: "PROV010101AAA", nombreEmisor: "Proveedor SA", rfcReceptor: "DESP010101AB1", fecha: "2026-03-05", subtotal: 5000, iva: 800, total: 5800, tipo: "Ingreso", categoria: "acreditable_100", proporcionalidad: 1.0 },
      { uuid: randomUUID(), rfcEmisor: "PROV010101AAA", nombreEmisor: "Proveedor SA", rfcReceptor: "DESP010101AB1", fecha: "2026-03-20", subtotal: 3000, iva: 480, total: 3480, tipo: "Ingreso", categoria: "acreditable_100", proporcionalidad: 1.0 },
    ];
    const diot = generarDiotDevolucionIva(facturas);
    expect(diot).toHaveLength(1);
    expect(diot[0]!.ivaAcreditable).toBe(1280);

    const declaraciones: DeclaracionMensualIva[] = [{ mes: 3, año: 2026, ivaCobrado: 0, ivaPagado: 1280, saldoFavor: 1280, saldoContra: 0 }];
    const conciliacion = conciliarDiotDeclaracion(diot, declaraciones);
    expect(conciliacion[0]!.status).toBe("match");

    const saldoFavor = calcularSaldoFavor(declaraciones);
    const monto = calcularMontoDevolucion(saldoFavor, declaraciones);
    expect(monto.montoDevolucionSugerido).toBe(1280);

    const solicitud = prepararSolicitud("2026-03", monto, { clabe: "014180655208094807", now: new Date().toISOString(), solicitudId: randomUUID(), facturas, diotEntries: diot, declaraciones });
    expect(solicitud.estado).toBe("lista_para_envio"); // bajo el umbral de $10,001 -> nunca corre congruencia obligatoria
    expect(solicitud.montoSolicitado).toBe(1280);
  });
});
