// Ola 4 (H1): techo DURO de gasto por organizacion para el agente de WhatsApp de restaurantes.
//
// El tope mensual de LLM de la organizacion (core.llm_org_budget) es de TODO el LLM y corta en seco al 100 %; el agente de
// WhatsApp no tenia un techo propio ni un aviso previo. Politica (configurable por organizacion, decision final de Javier):
//   * por omision: AVISAR al llegar al 100 % del techo y CORTAR al 120 % (el agente deja de llamar al modelo, contesta un texto fijo
//     y pasa la conversacion a una persona);
//   * `avisar`: solo avisa, nunca corta.
// Base sin la migracion 0102 o error al leer: el agente sigue atendiendo (nunca se deja a un cliente sin respuesta por un fallo del
// medidor) y lo dice el estado `sin_medir`.
import { describe, expect, it } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import {
  ACCION_TECHO_POR_OMISION,
  CORTE_PCT_POR_OMISION,
  TECHO_WHATSAPP_POR_OMISION_USD,
  TEXTO_TECHO_CORTE,
  conTechoDeGastoWhatsApp,
  evaluarTechoGasto,
  lectorTechoPostgres,
  type EstadoTecho,
} from "../src/costos/techo-whatsapp.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const USD = 1_000_000;

describe("evaluarTechoGasto (pura)", () => {
  const politica = { techoMicroUsd: 100 * USD, accion: "avisar_y_cortar" as const, cortePct: 120 };
  it("por debajo del techo: ok", () => {
    expect(evaluarTechoGasto(99 * USD, politica)).toEqual({ nivel: "ok", pct: 99 });
  });
  it("del 100 % al 120 %: aviso, sigue atendiendo", () => {
    expect(evaluarTechoGasto(100 * USD, politica)).toEqual({ nivel: "aviso", pct: 100 });
    expect(evaluarTechoGasto(119_999_999, politica).nivel).toBe("aviso");
  });
  it("desde el 120 %: corte", () => {
    expect(evaluarTechoGasto(120 * USD, politica)).toEqual({ nivel: "corte", pct: 120 });
  });
  it("con accion `avisar` nunca corta", () => {
    expect(evaluarTechoGasto(500 * USD, { ...politica, accion: "avisar" }).nivel).toBe("aviso");
  });
  it("por omision: 100 USD, avisar_y_cortar, corte al 120 %", () => {
    expect(TECHO_WHATSAPP_POR_OMISION_USD).toBe(100);
    expect(ACCION_TECHO_POR_OMISION).toBe("avisar_y_cortar");
    expect(CORTE_PCT_POR_OMISION).toBe(120);
  });
});

function setup(estado: EstadoTecho | Error) {
  const llamadas: string[] = [];
  const avisos: Array<{ nivel: string; organizationId: string; periodo: string }> = [];
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
      avisos.push({ nivel: a.nivel, organizationId: a.organizationId, periodo: a.periodo });
    },
  });
  const turno = (modo?: "real" | "preview") =>
    handler.handleInboundMessage({ organizationId: ORG, phone: "+529990000000", messages: [], customer: { isNew: true } as never, ...(modo ? { modo } : {}) });
  return { llamadas, avisos, turno };
}

const medido = (gastoUsd: number, extra: Partial<Extract<EstadoTecho, { estado: "medido" }>> = {}): EstadoTecho => ({
  estado: "medido",
  gastoMicroUsd: gastoUsd * USD,
  techoMicroUsd: 100 * USD,
  accion: "avisar_y_cortar",
  cortePct: 120,
  periodo: "2026-11",
  ...extra,
});

describe("conTechoDeGastoWhatsApp", () => {
  it("por debajo del techo delega al modelo y no avisa", async () => {
    const { llamadas, avisos, turno } = setup(medido(50));
    expect((await turno()).reply).toBe("respuesta del modelo");
    expect(llamadas).toEqual([ORG]);
    expect(avisos).toEqual([]);
  });

  it("al 100 %: avisa (una vez por mes, clave org+periodo) y sigue atendiendo", async () => {
    const { llamadas, avisos, turno } = setup(medido(105));
    expect((await turno()).reply).toBe("respuesta del modelo");
    expect(llamadas).toHaveLength(1);
    expect(avisos).toEqual([{ nivel: "aviso", organizationId: ORG, periodo: "2026-11" }]);
  });

  it("al 120 %: NO llama al modelo, contesta el texto fijo, escala a una persona y avisa del corte", async () => {
    const { llamadas, avisos, turno } = setup(medido(120));
    const r = await turno();
    expect(llamadas).toEqual([]);
    expect(r.reply).toBe(TEXTO_TECHO_CORTE);
    expect(r.escalacion).toEqual({ motivo: "techo_gasto_whatsapp" });
    expect(avisos.map((a) => a.nivel)).toEqual(["corte"]);
  });

  it("con accion `avisar` pasa del 120 % y sigue atendiendo", async () => {
    const { llamadas, turno } = setup(medido(300, { accion: "avisar" }));
    await turno();
    expect(llamadas).toHaveLength(1);
  });

  it("base sin la 0102 (sin_medir) o error al leer: atiende igual", async () => {
    for (const e of [{ estado: "sin_medir", motivo: "funcion_no_migrada" } as const, new Error("boom")]) {
      const { llamadas, avisos, turno } = setup(e);
      expect((await turno()).reply).toBe("respuesta del modelo");
      expect(llamadas).toHaveLength(1);
      expect(avisos).toEqual([]);
    }
  });

  it("un aviso que falla no tumba el turno", async () => {
    const interno: WhatsAppTurnHandler = { handleInboundMessage: async () => ({ reply: "ok", orderId: null, propertyId: null }) };
    const h = conTechoDeGastoWhatsApp(interno, { leer: async () => medido(110), avisar: async () => Promise.reject(new Error("sin base")) });
    expect((await h.handleInboundMessage({ organizationId: ORG, phone: "+52", messages: [], customer: { isNew: true } as never })).reply).toBe("ok");
  });

  it("la vista previa del panel no se corta ni avisa (no es trafico de clientes)", async () => {
    const { llamadas, avisos, turno } = setup(medido(500));
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

  it("lee el estado en sesion de sistema y manda el techo de omision en micro-USD", async () => {
    const e = engine(() => [{ gasto_micro_usd: "3500000", techo_micro_usd: "100000000", accion: "avisar_y_cortar", corte_pct: 120, periodo: "2026-11" }]);
    expect(await lectorTechoPostgres(e as never)(ORG)).toEqual({ estado: "medido", gastoMicroUsd: 3_500_000, techoMicroUsd: 100 * USD, accion: "avisar_y_cortar", cortePct: 120, periodo: "2026-11" });
    expect(e.claims).toEqual([null]);
    expect(e.sqls[0]).toContain("core.whatsapp_agente_techo_estado_for_system");
  });

  it("base sin la 0102 (42883) -> sin_medir/funcion_no_migrada; otro error -> sin_medir/error", async () => {
    const no = engine(() => {
      throw Object.assign(new Error("function core.whatsapp_agente_techo_estado_for_system(uuid, bigint) does not exist"), { code: "42883" });
    });
    expect(await lectorTechoPostgres(no as never)(ORG)).toEqual({ estado: "sin_medir", motivo: "funcion_no_migrada" });
    const roto = engine(() => {
      throw Object.assign(new Error("timeout"), { code: "57014" });
    });
    expect(await lectorTechoPostgres(roto as never)(ORG)).toEqual({ estado: "sin_medir", motivo: "error" });
  });
});
