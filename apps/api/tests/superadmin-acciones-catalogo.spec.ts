// Catálogo cerrado de acciones -- ver `../src/superadmin-acciones/catalogo.ts`.
// Este test es el que hace CUMPLIR la regla dura del punto 5 del encargo:
// ningún tipo de acción disponible puede saltarse el flujo de intent +
// confirmación, salvo las dos automatizaciones internas declaradas.
import { describe, expect, it } from "vitest";
import {
  ACCIONES_CON_INTENT,
  ACCIONES_NO_DISPONIBLES,
  AUTOMATIZACIONES_INTERNAS,
  CATALOGO_ACCIONES,
  catalogoRespetaReglaDeConfirmacion,
  esTipoIntentEjecutable,
  TIPOS_INTENT_EJECUTABLES,
  type CatalogoAccionEntry,
} from "../src/superadmin-acciones/catalogo.ts";

describe("catálogo de acciones", () => {
  it("todo tipo disponible, salvo las dos automatizaciones internas, requiere confirmación", () => {
    expect(catalogoRespetaReglaDeConfirmacion()).toBe(true);
  });

  it("falla si un tipo NUEVO 'disponible' se registra sin requiereConfirmacion (salvo automatización interna declarada)", () => {
    const catalogoRoto: readonly CatalogoAccionEntry[] = [
      ...CATALOGO_ACCIONES,
      { tipo: "reprocesar_webhook_billing_sin_confirmar", categoria: "no_disponible", disponible: true, requiereConfirmacion: false, descripcion: "hallazgo: esto NUNCA debe poder registrarse así" },
    ];
    expect(catalogoRespetaReglaDeConfirmacion(catalogoRoto)).toBe(false);
  });

  it("las 3 acciones ejecutables con intent tienen requiereConfirmacion: true", () => {
    for (const accion of ACCIONES_CON_INTENT) {
      expect(accion.disponible).toBe(true);
      expect(accion.requiereConfirmacion).toBe(true);
    }
    expect(ACCIONES_CON_INTENT.map((a) => a.tipo).sort()).toEqual(["cerrar_prospecto", "ejecutar_mantenimiento_ahora", "reencolar_mensaje_muerto"]);
  });

  it("las dos automatizaciones internas están disponibles pero SIN confirmación (corren solas por diseño)", () => {
    expect(AUTOMATIZACIONES_INTERNAS.map((a) => a.tipo).sort()).toEqual(["desatascar_outbox_colgados", "marcar_prospectos_sin_movimiento"]);
    for (const automatizacion of AUTOMATIZACIONES_INTERNAS) {
      expect(automatizacion.disponible).toBe(true);
      expect(automatizacion.requiereConfirmacion).toBe(false);
    }
  });

  it("toda acción 'no disponible' (las categorías que NUNCA se automatizan) tiene disponible: false", () => {
    expect(ACCIONES_NO_DISPONIBLES.length).toBeGreaterThan(0);
    for (const accion of ACCIONES_NO_DISPONIBLES) {
      expect(accion.disponible).toBe(false);
      expect(accion.categoria).toBe("no_disponible");
    }
  });

  it("ninguna categoría vetada (LLM/topes/dinero/accesos/datos de tenant/publicar) aparece disponible en ninguna parte del catálogo", () => {
    const patronesVetados = [/llm/i, /tope.*gasto/i, /reembols/i, /webhook.*billing/i, /suscripcion/i, /break.?glass/i, /rol.*staff/i, /credencial/i, /datos.*negocio.*tenant/i, /publicar|desplegar/i];
    for (const entry of CATALOGO_ACCIONES) {
      const esVetado = patronesVetados.some((p) => p.test(entry.tipo) || p.test(entry.descripcion));
      if (esVetado) {
        expect(entry.disponible, `"${entry.tipo}" coincide con una categoría vetada pero está disponible`).toBe(false);
      }
    }
  });

  it("esTipoIntentEjecutable/TIPOS_INTENT_EJECUTABLES reflejan exactamente el catálogo cerrado", () => {
    expect(TIPOS_INTENT_EJECUTABLES.size).toBe(3);
    expect(esTipoIntentEjecutable("reencolar_mensaje_muerto")).toBe(true);
    expect(esTipoIntentEjecutable("cerrar_prospecto")).toBe(true);
    expect(esTipoIntentEjecutable("ejecutar_mantenimiento_ahora")).toBe(true);
    expect(esTipoIntentEjecutable("ajustar_tope_gasto_llm")).toBe(false);
    expect(esTipoIntentEjecutable("cualquier_cosa_inventada")).toBe(false);
  });

  it("CATALOGO_ACCIONES no tiene tipos duplicados", () => {
    const tipos = CATALOGO_ACCIONES.map((a) => a.tipo);
    expect(new Set(tipos).size).toBe(tipos.length);
  });
});
