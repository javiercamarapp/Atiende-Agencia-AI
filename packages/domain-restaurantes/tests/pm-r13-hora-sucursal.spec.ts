// PM Ronda 13 (T7-026, hallazgo de la hora): Luna ON r2 guardo 18:00 cuando el cliente pidio 7 pm. El servidor aceptaba CUALQUIER offset en `programado_para` / `hora_recogida`:
// "19:00-05:00" (horario de verano que Merida ya no usa) se guardaba como 18:00 hora de la sucursal y nadie lo notaba. Regla (agent-tools/registry.ts, `invokeAgentTool`):
// si el modelo manda una hora ISO cuyo offset NO es el de la zona de la sucursal en ese instante, el servidor RECHAZA con un error que dice el offset esperado y como
// reenviarla; no adivina (reinterpretar en silencio puede cambiar el instante correcto). Reloj fijo: martes 2026-10-06 13:00 America/Merida (UTC-06:00, sin horario de verano).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CIERRE_MAQUINA_ENV } from "../src/agent-tools/cierre-maquina.ts";
import { executeAgentToolSafely, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13_MERIDA = new Date("2026-10-06T13:00:00-06:00");

function entorno(maquina: boolean, ahora: Date = MARTES_13_MERIDA): void {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ahora);
  vi.stubEnv(CIERRE_MAQUINA_ENV, maquina ? "1" : "");
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Opciones {
  readonly canal?: "whatsapp" | "voz";
  readonly zona?: string;
  readonly pedido?: "recoger" | "domicilio";
  /** Simula la base sin migrar: el flujo no se puede leer ni escribir (camino anterior). */
  readonly sinMigrar?: boolean;
}

function sesion(opts: Opciones = {}) {
  const canal = opts.canal ?? "whatsapp";
  const pedido = opts.pedido ?? "recoger";
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, opts.zona ?? "America/Merida");
  if (opts.sinMigrar) {
    f.repo.readOrderFlow = async () => null;
    f.repo.writeOrderFlow = async () => ({ ok: false, reason: "unavailable" }) as never;
  }
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel: canal, phone: "9991234567", flow: { key: `k:${canal}`, turn: String(turn), now: () => Date.now() } });
  const base = {
    branch_slug: "fco-montejo",
    canal: pedido,
    ...(pedido === "domicilio" ? { colonia_entrega: "Centro" } : {}),
    items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }],
  };
  return {
    f,
    quote: (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra }),
    quoteSafe: (extra: Record<string, unknown>) => executeAgentToolSafely(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra }),
    confirm: async () => {
      turn += 1;
      return invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
    },
    create: (extra: Record<string, unknown>) =>
      invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", customer_address: pedido === "domicilio" ? "Calle 5 #10, Centro" : undefined, ...extra }),
  };
}

const quoteDe = (o: { result: unknown }) => (o.result as { quote: { programado_para?: string } }).quote;

// ---------------------------------------------------------------------------------------------------------------------
// 1) Como se comporta cada forma de mandar "7 pm" (la hora local de la sucursal) y que pasa con las que NO son de la sucursal
// ---------------------------------------------------------------------------------------------------------------------
describe.each([
  ["maquina de cierre APAGADA", false],
  ["maquina de cierre ENCENDIDA", true],
] as const)("offset de programado_para / hora_recogida (%s)", (_n, maquina) => {
  beforeEach(() => entorno(maquina));

  describe.each(["whatsapp", "voz"] as const)("canal %s", (canal) => {
    it("19:00-06:00 (la hora local de la sucursal) se acepta y queda a las 01:00Z", async () => {
      const s = sesion({ canal });
      const r = await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
      expect(quoteDe(r).programado_para).toBe("2026-10-07T01:00:00.000Z");
    });

    it.each([
      ["19:00-05:00 (horario de verano que Merida ya no usa: guardaba 18:00)", "2026-10-06T19:00:00-05:00", "-05:00"],
      ["01:00Z (el instante correcto pero con la zona de UTC)", "2026-10-07T01:00:00Z", "Z"],
      ["19:00Z (la hora local etiquetada como UTC)", "2026-10-06T19:00:00Z", "Z"],
      ["19:00+00:00", "2026-10-06T19:00:00+00:00", "+00:00"],
      ["19:00-07:00", "2026-10-06T19:00:00-07:00", "-07:00"],
      ["19:00+01:00", "2026-10-06T19:00:00+01:00", "+01:00"],
      ["19:00-0500 (sin dos puntos)", "2026-10-06T19:00:00-0500", "-0500"],
    ])("programado_para %s se RECHAZA diciendo el offset esperado", async (_nombre, valor) => {
      const s = sesion({ canal });
      await expect(s.quote({ programado_para: valor })).rejects.toThrow(OrderValidationError);
      await expect(s.quote({ programado_para: valor })).rejects.toThrow(/-06:00/);
      await expect(s.quote({ programado_para: valor })).rejects.toThrow(/America\/Merida/);
    });

    it("hora_recogida con -05:00 tambien se rechaza (en recoger guardaba 18:00 en vez de 19:00)", async () => {
      const s = sesion({ canal });
      await expect(s.quote({ hora_recogida: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
    });

    it("hora_recogida con Z se rechaza y con -06:00 se acepta", async () => {
      const s = sesion({ canal });
      await expect(s.quote({ hora_recogida: "2026-10-07T01:00:00Z" })).rejects.toThrow(/-06:00/);
      await expect(s.quote({ hora_recogida: "2026-10-06T19:00:00-06:00" })).resolves.toBeDefined();
    });

    it("el mensaje ofrece los dos candidatos: la hora tal como se escribio con el offset correcto y el mismo instante en hora local", async () => {
      const s = sesion({ canal });
      const out = await s.quoteSafe({ programado_para: "2026-10-06T19:00:00-05:00" });
      const error = (out.result as { error: string }).error;
      expect(error).toContain("2026-10-06T19:00:00-06:00"); // lo que escribio, con el offset de la sucursal
      expect(error).toContain("2026-10-06T18:00:00-06:00"); // el instante que habria guardado, en hora local
      expect(error).toMatch(/minutos_para_recoger/);
    });

    it("sin offset ya se rechazaba y se sigue rechazando (pide la zona)", async () => {
      const s = sesion({ canal });
      await expect(s.quote({ programado_para: "2026-10-06T19:00:00" })).rejects.toThrow(/zona horaria/);
      await expect(s.quote({ hora_recogida: "2026-10-06T19:00:00" })).rejects.toThrow(/zona horaria/);
    });

    it("a domicilio tambien se valida el offset de programado_para", async () => {
      const s = sesion({ canal, pedido: "domicilio" });
      await expect(s.quote({ programado_para: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
      const ok = await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
      expect(quoteDe(ok).programado_para).toBe("2026-10-07T01:00:00.000Z");
    });

    it("crear_pedido con offset equivocado se rechaza aunque la cotizacion fuera buena (no se crea el pedido)", async () => {
      const s = sesion({ canal });
      await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
      await s.confirm();
      await expect(s.create({ programado_para: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
      const ok = await s.create({ programado_para: "2026-10-06T19:00:00-06:00" });
      expect(ok.orderId).not.toBeNull();
    });

    it("el eco de la hora YA cotizada (el servidor la devuelve en UTC) no se rechaza", async () => {
      const s = sesion({ canal });
      const q = await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
      await s.confirm();
      const eco = quoteDe(q).programado_para!; // "2026-10-07T01:00:00.000Z"
      const ok = await s.create({ programado_para: eco });
      expect(ok.orderId).not.toBeNull();
    });
  });

  it("minutos_para_recoger (hora calculada por el servidor en UTC) no pasa por la regla del offset", async () => {
    const s = sesion();
    await expect(s.quote({ minutos_para_recoger: 40 })).resolves.toBeDefined();
  });

  it("con la base SIN MIGRAR (flujo no disponible) la regla del offset igual aplica", async () => {
    const s = sesion({ sinMigrar: true });
    await expect(s.quote({ programado_para: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2) Otras zonas por sucursal (resolverZonaHorariaNegocio) y horario de verano
// ---------------------------------------------------------------------------------------------------------------------
describe("zona de la sucursal distinta de Merida", () => {
  beforeEach(() => entorno(true));

  it("Cancun (UTC-05:00): 19:00-05:00 se acepta y 19:00-06:00 se rechaza diciendo -05:00", async () => {
    const s = sesion({ zona: "America/Cancun" });
    const ok = await s.quote({ programado_para: "2026-10-06T19:00:00-05:00" });
    expect(quoteDe(ok).programado_para).toBe("2026-10-07T00:00:00.000Z");
    await expect(sesion({ zona: "America/Cancun" }).quote({ programado_para: "2026-10-06T19:00:00-06:00" })).rejects.toThrow(/-05:00[\s\S]*America\/Cancun|America\/Cancun[\s\S]*-05:00/);
  });

  it("Tijuana con horario de verano en octubre (UTC-07:00): -07:00 se acepta y -08:00 se rechaza", async () => {
    const ok = await sesion({ zona: "America/Tijuana" }).quote({ programado_para: "2026-10-06T19:00:00-07:00" });
    expect(quoteDe(ok).programado_para).toBe("2026-10-07T02:00:00.000Z");
    await expect(sesion({ zona: "America/Tijuana" }).quote({ programado_para: "2026-10-06T19:00:00-08:00" })).rejects.toThrow(/-07:00/);
  });

  it("Tijuana tras el fin del horario de verano (1-nov-2026, UTC-08:00): el offset esperado cambia a -08:00", async () => {
    vi.setSystemTime(new Date("2026-10-31T12:00:00-07:00"));
    const ok = await sesion({ zona: "America/Tijuana" }).quote({ programado_para: "2026-11-01T14:00:00-08:00" });
    expect(quoteDe(ok).programado_para).toBe("2026-11-01T22:00:00.000Z");
    await expect(sesion({ zona: "America/Tijuana" }).quote({ programado_para: "2026-11-01T14:00:00-07:00" })).rejects.toThrow(/-08:00/);
  });

  it("una zona guardada invalida cae a la de plataforma (Merida, UTC-06:00)", async () => {
    const s = sesion({ zona: "America/Merida" });
    s.f.repo.findBranchZonaHoraria = async () => ({ zonaHoraria: "Mars/Olympus" }) as never;
    await expect(s.quote({ programado_para: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
    await expect(s.quote({ programado_para: "2026-10-06T19:00:00-06:00" })).resolves.toBeDefined();
  });

  it("sin zona configurada (base sin la migracion de zona horaria) se usa la de plataforma", async () => {
    const s = sesion({ zona: "America/Merida" });
    s.f.repo.findBranchZonaHoraria = async () => ({ zonaHoraria: null }) as never;
    await expect(s.quote({ programado_para: "2026-10-06T19:00:00-05:00" })).rejects.toThrow(/-06:00/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3) Horas "como las dice el cliente" ya traducidas a ISO con el offset correcto: 7 pm, 19:00, a las 7, mediodia, medianoche, cruce de dia
// ---------------------------------------------------------------------------------------------------------------------
describe("horas locales correctas (reloj fijo martes 13:00 Merida; horario 12:00-01:00)", () => {
  beforeEach(() => entorno(false));

  it.each([
    ["«a las 7 pm» hoy", "2026-10-06T19:00:00-06:00", "2026-10-07T01:00:00.000Z"],
    ["«a las 19:00» hoy", "2026-10-06T19:00:00-06:00", "2026-10-07T01:00:00.000Z"],
    ["«mediodia» de manana", "2026-10-07T12:00:00-06:00", "2026-10-07T18:00:00.000Z"],
    ["«a las 12:30 am» (cruce de dia: sigue en el turno del martes)", "2026-10-07T00:30:00-06:00", "2026-10-07T06:30:00.000Z"],
    ["«medianoche» exacta", "2026-10-07T00:00:00-06:00", "2026-10-07T06:00:00.000Z"],
    ["justo 30 minutos adelante (14:00 es hora valida)", "2026-10-06T14:00:00-06:00", "2026-10-06T20:00:00.000Z"],
    ["dentro de 7 dias a las 3 pm", "2026-10-13T12:00:00-06:00", "2026-10-13T18:00:00.000Z"],
    ["el mismo instante con segundos y milisegundos", "2026-10-06T19:00:00.000-06:00", "2026-10-07T01:00:00.000Z"],
    ["el mismo instante sin segundos", "2026-10-06T19:00-06:00", "2026-10-07T01:00:00.000Z"],
  ])("%s -> %s", async (_n, valor, utc) => {
    const r = await sesion().quote({ programado_para: valor });
    expect(quoteDe(r).programado_para).toBe(utc);
  });

  it("«a las 7» mal resuelto a las 7 am de manana: el offset es el correcto pero la sucursal esta cerrada (otra regla, no la del offset)", async () => {
    await expect(sesion().quote({ programado_para: "2026-10-07T07:00:00-06:00" })).rejects.toThrow(/no atiende|horario/i);
  });

  it("01:30 am de manana (despues del cierre de la 1:00) tambien es horario cerrado, con el offset correcto", async () => {
    await expect(sesion().quote({ programado_para: "2026-10-07T01:30:00-06:00" })).rejects.toThrow(/no atiende|horario/i);
  });

  it("hora_recogida de hoy con el offset correcto (2 pm) se acepta en recoger", async () => {
    await expect(sesion().quote({ hora_recogida: "2026-10-06T14:00:00-06:00" })).resolves.toBeDefined();
  });

  it("programado_para y hora_recogida iguales y con el offset correcto siguen siendo la misma hora", async () => {
    const x = "2026-10-06T19:00:00-06:00";
    await expect(sesion().quote({ programado_para: x, hora_recogida: x })).resolves.toBeDefined();
  });
});
