// Ola 4 (H1): gasto del agente de WhatsApp de restaurantes por organizacion.
//
// Decision de Omar (9-nov): «no hay techo, es lo que necesite PM o el cliente». Por omision NO se corta nunca: el agente sigue atendiendo
// y solo se AVISA (notificacion in-app al dueño y al superadmin) al cruzar umbrales informativos de gasto del mes. Los umbrales se
// configuran por organizacion; el CORTE existe solo si un superadmin lo configura explicitamente para esa organizacion.
// Base sin la migracion 0102 o error al leer: el agente atiende igual (`sin_medir`).
import { describe, expect, it } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import {
  TEXTO_CORTE_GASTO,
  UMBRALES_AVISO_POR_OMISION_USD,
  conTechoDeGastoWhatsApp,
  evaluarGastoWhatsApp,
  lectorTechoPostgres,
  type AvisoGasto,
  type EstadoGasto,
} from "../src/costos/techo-whatsapp.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const USD = 1_000_000;

describe("evaluarGastoWhatsApp (pura)", () => {
  const umbrales = [50 * USD, 100 * USD, 250 * USD];
  it("por debajo del primer umbral: nada", () => {
    expect(evaluarGastoWhatsApp(49 * USD, { umbralesMicroUsd: umbrales, corteMicroUsd: null })).toEqual({ umbralMicroUsd: null, corta: false });
  });
  it("devuelve el umbral MAS ALTO cruzado (los umbrales pueden venir desordenados)", () => {
    expect(evaluarGastoWhatsApp(120 * USD, { umbralesMicroUsd: [250 * USD, 50 * USD, 100 * USD], corteMicroUsd: null })).toEqual({ umbralMicroUsd: 100 * USD, corta: false });
  });
  it("sin corte configurado NUNCA corta, por alto que sea el gasto", () => {
    expect(evaluarGastoWhatsApp(1_000_000 * USD, { umbralesMicroUsd: umbrales, corteMicroUsd: null }).corta).toBe(false);
  });
  it("con corte configurado corta desde ese monto", () => {
    expect(evaluarGastoWhatsApp(299 * USD, { umbralesMicroUsd: umbrales, corteMicroUsd: 300 * USD }).corta).toBe(false);
    expect(evaluarGastoWhatsApp(300 * USD, { umbralesMicroUsd: umbrales, corteMicroUsd: 300 * USD }).corta).toBe(true);
  });
  it("umbrales informativos por omision (sin fila): 50, 100, 250 y 500 USD", () => {
    expect(UMBRALES_AVISO_POR_OMISION_USD).toEqual([50, 100, 250, 500]);
  });
});

function setup(estado: EstadoGasto | Error) {
  const llamadas: string[] = [];
  const avisos: AvisoGasto[] = [];
  const interno: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      llamadas.push(args.organizationId);
      return { reply: "respuesta del modelo", orderId: null, propertyId: null };
    },
  };
  const handler = conTechoDeGastoWhatsApp(interno, {
    leer: async () => {
      if (estado instanceof Error) throw estado;
      return estado;
    },
    avisar: async (a) => {
      avisos.push(a);
    },
  });
  const turno = (modo?: "real" | "preview") =>
    handler.handleInboundMessage({ organizationId: ORG, phone: "+529990000000", messages: [], customer: { isNew: true } as never, ...(modo ? { modo } : {}) });
  return { llamadas, avisos, turno };
}

const medido = (gastoUsd: number, extra: Partial<Extract<EstadoGasto, { estado: "medido" }>> = {}): EstadoGasto => ({
  estado: "medido",
  gastoMicroUsd: gastoUsd * USD,
  umbralesMicroUsd: [50 * USD, 100 * USD, 250 * USD, 500 * USD],
  corteMicroUsd: null,
  periodo: "2026-11",
  slug: "org-a",
  ...extra,
});

describe("conTechoDeGastoWhatsApp", () => {
  it("por debajo del primer umbral delega al modelo y no avisa", async () => {
    const { llamadas, avisos, turno } = setup(medido(10));
    expect((await turno()).reply).toBe("respuesta del modelo");
    expect(llamadas).toEqual([ORG]);
    expect(avisos).toEqual([]);
  });

  it("al cruzar un umbral AVISA (con el umbral, el gasto y el periodo para la dedupe) y sigue atendiendo", async () => {
    const { llamadas, avisos, turno } = setup(medido(130));
    expect((await turno()).reply).toBe("respuesta del modelo");
    expect(llamadas).toHaveLength(1);
    expect(avisos).toEqual([{ tipo: "umbral", organizationId: ORG, slug: "org-a", periodo: "2026-11", montoUsd: 100, gastoUsd: 130 }]);
  });

  it("por omision (sin corte) un gasto enorme NO corta: atiende y solo avisa", async () => {
    const { llamadas, avisos, turno } = setup(medido(100_000));
    expect((await turno()).reply).toBe("respuesta del modelo");
    expect(llamadas).toHaveLength(1);
    expect(avisos.map((a) => a.tipo)).toEqual(["umbral"]);
  });

  it("con corte configurado por la organizacion: no llama al modelo, contesta el texto fijo, escala y avisa del corte", async () => {
    const { llamadas, avisos, turno } = setup(medido(320, { corteMicroUsd: 300 * USD }));
    const r = await turno();
    expect(llamadas).toEqual([]);
    expect(r.reply).toBe(TEXTO_CORTE_GASTO);
    expect(r.escalacion).toEqual({ motivo: "corte_gasto_whatsapp" });
    expect(avisos).toEqual([{ tipo: "corte", organizationId: ORG, slug: "org-a", periodo: "2026-11", montoUsd: 300, gastoUsd: 320 }]);
  });

  it("base sin la 0102 (sin_medir) o error al leer: atiende igual y no avisa", async () => {
    for (const e of [{ estado: "sin_medir", motivo: "funcion_no_migrada" } as const, new Error("boom")]) {
      const { llamadas, avisos, turno } = setup(e);
      expect((await turno()).reply).toBe("respuesta del modelo");
      expect(llamadas).toHaveLength(1);
      expect(avisos).toEqual([]);
    }
  });

  it("un aviso que falla no tumba el turno", async () => {
    const interno: WhatsAppTurnHandler = { handleInboundMessage: async () => ({ reply: "ok", orderId: null, propertyId: null }) };
    const h = conTechoDeGastoWhatsApp(interno, { leer: async () => medido(600), avisar: async () => Promise.reject(new Error("sin base")) });
    expect((await h.handleInboundMessage({ organizationId: ORG, phone: "+52", messages: [], customer: { isNew: true } as never })).reply).toBe("ok");
  });

  it("la vista previa del panel no se corta ni avisa (no es trafico de clientes)", async () => {
    const { llamadas, avisos, turno } = setup(medido(500, { corteMicroUsd: 100 * USD }));
    await turno("preview");
    expect(llamadas).toHaveLength(1);
    expect(avisos).toEqual([]);
  });
});

describe("lectorTechoPostgres", () => {
  function engine(respuesta: () => unknown[]) {
    const claims: Array<string | null> = [];
    const sqls: string[] = [];
    return {
      claims,
      sqls,
      async withAppSession<T>(c: { userId: string | null }, fn: (s: { query: <R>(sql: string, p?: unknown[]) => Promise<{ rows: R[] }>; exec: () => Promise<void> }) => Promise<T>): Promise<T> {
        claims.push(c.userId);
        return fn({
          query: async <R>(sql: string) => {
            sqls.push(sql);
            return { rows: respuesta() as R[] };
          },
          exec: async () => undefined,
        });
      },
    };
  }

  it("sin fila de la organizacion (umbrales null) usa los umbrales por omision y no corta", async () => {
    const e = engine(() => [{ gasto_micro_usd: "3500000", umbrales_aviso_micro_usd: null, corte_micro_usd: null, periodo: "2026-11", slug: "org-a" }]);
    expect(await lectorTechoPostgres(e as never)(ORG)).toEqual({
      estado: "medido",
      gastoMicroUsd: 3_500_000,
      umbralesMicroUsd: [50 * USD, 100 * USD, 250 * USD, 500 * USD],
      corteMicroUsd: null,
      periodo: "2026-11",
      slug: "org-a",
    });
    expect(e.claims).toEqual([null]);
    expect(e.sqls[0]).toContain("core.whatsapp_agente_techo_estado_for_system");
  });

  it("con fila: umbrales y corte de la organizacion", async () => {
    const e = engine(() => [{ gasto_micro_usd: 1, umbrales_aviso_micro_usd: ["20000000", "40000000"], corte_micro_usd: "90000000", periodo: "2026-11", slug: "org-a" }]);
    const r = await lectorTechoPostgres(e as never)(ORG);
    expect(r).toMatchObject({ umbralesMicroUsd: [20 * USD, 40 * USD], corteMicroUsd: 90 * USD });
  });

  it("base sin la 0102 (42883) -> sin_medir/funcion_no_migrada; otro error -> sin_medir/error", async () => {
    const no = engine(() => {
      throw Object.assign(new Error("function core.whatsapp_agente_techo_estado_for_system(uuid) does not exist"), { code: "42883" });
    });
    expect(await lectorTechoPostgres(no as never)(ORG)).toEqual({ estado: "sin_medir", motivo: "funcion_no_migrada" });
    const roto = engine(() => {
      throw Object.assign(new Error("timeout"), { code: "57014" });
    });
    expect(await lectorTechoPostgres(roto as never)(ORG)).toEqual({ estado: "sin_medir", motivo: "error" });
  });
});
