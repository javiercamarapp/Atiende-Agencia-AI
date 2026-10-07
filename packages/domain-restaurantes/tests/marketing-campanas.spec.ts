// Campanas de reactivacion (autopiloto 2): contrato TypeScript sobre la migracion 052 y degradacion contra la base SIN migrar con
// AbortAwareFakeSession (reproduce el estado abortado de Postgres: una sesion falsa plana no serviria). La regla de negocio (consentimiento,
// tope de 14 dias, control, aprobacion) se prueba contra Postgres real en scripts/verify-restaurantes-marketing-campanas.
import { describe, expect, it } from "vitest";
import {
  MarketingNoDisponibleError,
  MarketingParametrosError,
  MarketingRechazadoError,
  MarketingSinAccesoError,
  decidirCampana,
  generarBorradoresMarketing,
  guardarConfigMarketing,
  leerConfigMarketing,
  listarCampanas,
  registrarConsentimientoMarketing,
  revocarMarketingPorTelefono,
} from "../src/marketing/campanas.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const CAMP = "00000000-0000-0000-0000-00000000ca01";
const CLIENTE = "00000000-0000-0000-0000-00000000c001";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const FALTA = (fn: string) => pgError("42883", `function ${fn} does not exist`);

describe("base SIN migrar: estado honesto, la transaccion sigue utilizable", () => {
  const sesion = () =>
    new AbortAwareFakeSession([
      { match: /marketing_config_leer/, respond: () => FALTA("restaurantes.marketing_config_leer(uuid)") },
      { match: /marketing_resumen_campanas/, respond: () => FALTA("restaurantes.marketing_resumen_campanas(uuid)") },
      { match: /marketing_guardar_config/, respond: () => FALTA("restaurantes.marketing_guardar_config(uuid)") },
      { match: /marketing_decidir_campana/, respond: () => FALTA("restaurantes.marketing_decidir_campana(uuid)") },
      { match: /marketing_registrar_consentimiento/, respond: () => FALTA("restaurantes.marketing_registrar_consentimiento(uuid)") },
      { match: /marketing_revocar_por_telefono/, respond: () => FALTA("restaurantes.marketing_revocar_por_telefono(uuid)") },
      { match: /marketing_generar_borradores/, respond: () => FALTA("restaurantes.marketing_generar_borradores(timestamptz)") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);

  it("las lecturas devuelven disponible=false con vacio y las escrituras de sistema devuelven no_disponible, sin abortar nada", async () => {
    const s = sesion();
    expect(await leerConfigMarketing(s, ORG)).toEqual({ disponible: false, valor: null });
    expect(await listarCampanas(s, ORG)).toEqual({ disponible: false, valor: [] });
    expect(await registrarConsentimientoMarketing(s, { organizationId: ORG, customerId: CLIENTE, otorgar: true, fuente: "checkout_web" })).toBe("no_disponible");
    expect(await revocarMarketingPorTelefono(s, ORG, "+529991112233")).toEqual({ estado: "no_disponible", revocados: 0 });
    expect(await generarBorradoresMarketing(s, new Date("2026-10-04T15:00:00Z"))).toEqual({ disponible: false, borradores: 0, avisos: { emitidas: 0, sinNuevas: 0, errores: 0 } });
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("las acciones del panel lanzan MarketingNoDisponibleError (503) y la sesion queda utilizable", async () => {
    const s = sesion();
    await expect(decidirCampana(s, CAMP, true)).rejects.toBeInstanceOf(MarketingNoDisponibleError);
    await expect(guardarConfigMarketing(s, ORG, { activo: true, tarifaCentavos: 90, topeMensualCentavos: null, minimoSegmento: 10, plantillaNombre: null, plantillaIdioma: "es_MX" })).rejects.toBeInstanceOf(MarketingNoDisponibleError);
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });
});

describe("decidirCampana: errores de negocio de la base como errores tipados", () => {
  it.each(["requiere_tarifa", "requiere_plantilla_aprobada", "requiere_whatsapp_conectado", "tope_mensual_excedido", "campana_no_aprobable", "requiere_marketing_activo", "requiere_nuevo_borrador"] as const)("P0001 %s -> MarketingRechazadoError con su codigo", async (codigo) => {
    const s = new AbortAwareFakeSession([{ match: /marketing_decidir_campana/, respond: () => pgError("P0001", codigo) }, { match: /select 1 as despues/, respond: () => [{ despues: 1 }] }]);
    const err = await decidirCampana(s, CAMP, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketingRechazadoError);
    expect((err as MarketingRechazadoError).codigo).toBe(codigo);
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("42501 -> MarketingSinAccesoError (campana ajena o inexistente: misma respuesta) y 22023 -> MarketingParametrosError", async () => {
    const sinAcceso = new AbortAwareFakeSession([{ match: /marketing_decidir_campana/, respond: () => pgError("42501", "sin acceso") }]);
    await expect(decidirCampana(sinAcceso, CAMP, true)).rejects.toBeInstanceOf(MarketingSinAccesoError);
    const invalido = new AbortAwareFakeSession([{ match: /marketing_guardar_config/, respond: () => pgError("22023", "parametros invalidos") }]);
    await expect(guardarConfigMarketing(invalido, ORG, { activo: true, tarifaCentavos: 0, topeMensualCentavos: null, minimoSegmento: 10, plantillaNombre: null, plantillaIdioma: "es_MX" })).rejects.toBeInstanceOf(MarketingParametrosError);
  });

  it("un error inesperado (no de negocio) se repropaga tal cual: nunca se enmascara", async () => {
    const s = new AbortAwareFakeSession([{ match: /marketing_decidir_campana/, respond: () => pgError("XX000", "falla interna") }]);
    await expect(decidirCampana(s, CAMP, true)).rejects.toThrow("falla interna");
  });

  it("aprobar y rechazar devuelven el resultado de la base (encolados y control)", async () => {
    const s = new AbortAwareFakeSession([{ match: /marketing_decidir_campana/, respond: () => [{ estado: "aprobada", encolados: "21", control: 2 }] }]);
    expect(await decidirCampana(s, CAMP, true)).toEqual({ estado: "aprobada", encolados: 21, control: 2 });
    const r = new AbortAwareFakeSession([{ match: /marketing_decidir_campana/, respond: () => [{ estado: "rechazada", encolados: 0, control: 0 }] }]);
    expect(await decidirCampana(r, CAMP, false)).toEqual({ estado: "rechazada", encolados: 0, control: 0 });
  });
});

describe("lecturas con datos", () => {
  it("la configuracion trae los requisitos reales (promocion, plantilla aprobada, WhatsApp) y el gasto del mes", async () => {
    const s = new AbortAwareFakeSession([
      {
        match: /marketing_config_leer/,
        respond: () => [{ activo: true, tarifa_centavos: 80, tope_mensual_centavos: null, minimo_segmento: 10, plantilla_nombre: "reactivacion_promo", plantilla_idioma: "es_MX", hay_promocion_vigente: true, plantilla_aprobada: false, whatsapp_conectado: true, gastado_mes_centavos: "1600", consentimientos_vigentes: "42" }],
      },
    ]);
    expect(await leerConfigMarketing(s, ORG)).toEqual({
      disponible: true,
      valor: { activo: true, tarifaCentavos: 80, topeMensualCentavos: null, minimoSegmento: 10, plantillaNombre: "reactivacion_promo", plantillaIdioma: "es_MX", hayPromocionVigente: true, plantillaAprobada: false, whatsappConectado: true, gastadoMesCentavos: 1600, consentimientosVigentes: 42 },
    });
  });

  it("las campanas se mapean con numeros (bigint/numeric de pg llegan como texto)", async () => {
    const s = new AbortAwareFakeSession([
      {
        match: /marketing_resumen_campanas/,
        respond: () => [
          { campana_id: CAMP, segmento: "inactivo_30", estado: "aprobada", conteo: 23, conteo_control: 2, costo_estimado_centavos: 1840, promo_nombre: "Vuelve con 10 por ciento", promo_codigo: "VUELVE10", creada_at: new Date("2026-10-04T14:00:00Z"), decidida_at: "2026-10-04T15:00:00.000Z", encolados: 23, enviados: 20, recompra_tratados: 4, recompra_control: 0, ingreso_tratados: "1250.50", ventana_cerrada: false },
        ],
      },
    ]);
    const r = await listarCampanas(s, ORG);
    expect(r.disponible).toBe(true);
    expect(r.valor[0]).toMatchObject({ id: CAMP, segmento: "inactivo_30", conteo: 23, costoEstimadoCentavos: 1840, enviados: 20, recompraTratados: 4, ingresoTratados: 1250.5, creadaAt: "2026-10-04T14:00:00.000Z", ventanaCerrada: false });
  });
});

describe("generarBorradoresMarketing (tick)", () => {
  /** Sesion con la semantica de dedupe de core.emit_notification (misma clave = 0 filas nuevas). */
  function sesionConBorradores(filas: unknown[]) {
    const vistas = new Set<string>();
    const emisiones: unknown[][] = [];
    const generar: unknown[][] = [];
    const s = new AbortAwareFakeSession([
      { match: /marketing_generar_borradores/, respond: () => filas },
      { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
    ]);
    const original = s.query.bind(s);
    s.query = (async (sql: string, p?: unknown[]) => {
      if (/marketing_generar_borradores/.test(sql)) generar.push(p ?? []);
      if (/select core\.emit_notification/.test(sql)) {
        emisiones.push(p ?? []);
        const clave = String((p ?? [])[10]);
        if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
        vistas.add(clave);
      }
      return original(sql, p);
    }) as typeof s.query;
    return { s, emisiones, generar };
  }
  const FILAS = [{ campana_id: CAMP, organization_id: ORG, segmento: "inactivo_60", conteo: 31, costo_estimado_centavos: null }];

  it("pasa el reloj al SQL (p_now) y avisa en la campana a owner/admin SIN PII: solo conteo y dias; enlace relativo y dedupe por campana", async () => {
    const { s, emisiones, generar } = sesionConBorradores(FILAS);
    const r = await generarBorradoresMarketing(s, new Date("2026-10-04T15:00:00Z"));
    expect(r).toEqual({ disponible: true, borradores: 1, avisos: { emitidas: 1, sinNuevas: 0, errores: 0 } });
    expect(generar).toEqual([["2026-10-04T15:00:00.000Z"]]);
    const [e] = emisiones;
    expect(e![2]).toBe("restaurantes.marketing.borrador_listo");
    expect(e![5]).toBe("Hay una campaña de reactivación lista para aprobar");
    expect(e![6]).toBe("31 clientes con consentimiento llevan 60 días o más sin pedir. Revise el costo estimado y apruebe o rechace; nada se envía hasta que apruebe.");
    expect(e![7]).toBe("/restaurantes/{orgSlug}/campanas");
    expect(e![10]).toBe(`restaurantes.marketing.borrador_listo:${CAMP}`);
  });

  it("idempotente: si el tick se repite el mismo dia la base no devuelve filas nuevas y un aviso repetido cuenta sinNuevas", async () => {
    const { s } = sesionConBorradores(FILAS);
    await generarBorradoresMarketing(s);
    const segundo = await generarBorradoresMarketing(s);
    expect(segundo.avisos).toEqual({ emitidas: 0, sinNuevas: 1, errores: 0 });
    const vacio = await generarBorradoresMarketing(sesionConBorradores([]).s);
    expect(vacio).toEqual({ disponible: true, borradores: 0, avisos: { emitidas: 0, sinNuevas: 0, errores: 0 } });
  });
});

describe("escrituras de sistema (consentimiento y BAJA)", () => {
  it("el consentimiento reporta registrado / sin_cambio segun la base y nunca lanza ante un error inesperado", async () => {
    const nuevo = new AbortAwareFakeSession([{ match: /marketing_registrar_consentimiento/, respond: () => [{ cambio: true }] }]);
    expect(await registrarConsentimientoMarketing(nuevo, { organizationId: ORG, customerId: CLIENTE, otorgar: true, fuente: "checkout_web" })).toBe("registrado");
    const igual = new AbortAwareFakeSession([{ match: /marketing_registrar_consentimiento/, respond: () => [{ cambio: false }] }]);
    expect(await registrarConsentimientoMarketing(igual, { organizationId: ORG, customerId: CLIENTE, otorgar: true, fuente: "checkout_web" })).toBe("sin_cambio");
    const roto = new AbortAwareFakeSession([{ match: /marketing_registrar_consentimiento/, respond: () => pgError("XX000", "falla interna") }]);
    expect(await registrarConsentimientoMarketing(roto, { organizationId: ORG, customerId: CLIENTE, otorgar: true, fuente: "checkout_web" })).toBe("error");
  });

  it("la BAJA por telefono devuelve cuantos consentimientos revoco (0 = sin_cambio)", async () => {
    const uno = new AbortAwareFakeSession([{ match: /marketing_revocar_por_telefono/, respond: () => [{ revocados: 1 }] }]);
    expect(await revocarMarketingPorTelefono(uno, ORG, "+529991112233")).toEqual({ estado: "revocado", revocados: 1 });
    const ninguno = new AbortAwareFakeSession([{ match: /marketing_revocar_por_telefono/, respond: () => [{ revocados: 0 }] }]);
    expect(await revocarMarketingPorTelefono(ninguno, ORG, "+529991112233")).toEqual({ estado: "sin_cambio", revocados: 0 });
  });
});
