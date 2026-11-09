// Defectos sistemáticos del servidor encontrados en la medición C4 de #718 (MEDICION-718-C4.md):
//  (1) escalación por «colonia no reconocida»: el modelo manda la dirección completa («calle 9 #120 x 2 y 4 cordemex, casa amarilla…») y la colonia no se
//      reconoce; y un mensaje SIN colonia (el nombre del cliente, «Gerardo Uc», contestando «¿a nombre de quién?») contaba como el segundo intento fallido.
//  (2) «llegó frío, quiero hablar con el gerente»: el texto fijo de «pide una persona» no se disculpaba (ESC-04 0/5).
//  (3) POL-11: la sucursal asignada es la del chat y buscar_sucursal_cercana no traía su tiempo; POLÍTICAS v2 manda decir SOLO el tiempo de las herramientas,
//      así que el agente decía «la sucursal le confirma el tiempo» en vez de «de 40 a 50 minutos».
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, TEL_CLIENTE } from "./qa-viaje/arnes-viaje.ts";
import { candidatosDeColonia, executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { classifyHighRiskIntent } from "../src/whatsapp/guards.ts";
import { pareceSoloNombre } from "../src/whatsapp/contadores-agente.ts";

const T0 = new Date("2026-10-13T19:00:00-06:00");

describe("(1) colonia dentro de una dirección completa", () => {
  it("candidatosDeColonia saca la colonia de la dirección (tras el último número o «en / col.»)", () => {
    expect(candidatosDeColonia("calle 9 #120 x 2 y 4 cordemex, casa amarilla con toldo verde")).toContain("cordemex");
    expect(candidatosDeColonia("es en cordemex, calle 9 entre 2 y 4")).toContain("cordemex");
    expect(candidatosDeColonia("Calle 24 #198 x 13 y 15, Itzimná, casa azul cielo junto a la papelería")).toContain("Itzimná");
    expect(candidatosDeColonia("Itzimná")).toEqual([]);
  });

  it("con cerebro v2, buscar_sucursal_cercana con la dirección completa reconoce la colonia; sin la bandera no cambia", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const colonia = "calle 9 #120 x 2 y 4 cordemex, casa amarilla con toldo verde";
    const ctx = { organizationId: v.world.organizationId, channel: "whatsapp" as const, phone: TEL_CLIENTE, entryPropertyId: v.t7 };
    const sola = await executeAgentToolSafely(v.world.repo, { ...ctx, cerebroV2: true }, "buscar_sucursal_cercana", { colonia: "cordemex" });
    const conV2 = await executeAgentToolSafely(v.world.repo, { ...ctx, cerebroV2: true }, "buscar_sucursal_cercana", { colonia });
    // Lo mismo que con la colonia sola (en este mundo de prueba «Cordemex» es una colonia reconocida).
    expect((conV2.result as { estado?: string }).estado).toBe((sola.result as { estado?: string }).estado);
    expect((conV2.result as { estado?: string }).estado).not.toBe("no_reconocida");
    const sinV2 = await executeAgentToolSafely(v.world.repo, ctx, "buscar_sucursal_cercana", { colonia });
    expect((sinV2.result as { estado?: string }).estado).toBe("no_reconocida");
  });

  it("pareceSoloNombre: un nombre de pila y apellido sí; una colonia con dirección o una frase no", () => {
    expect(pareceSoloNombre("Gerardo Uc")).toBe(true);
    expect(pareceSoloNombre("soy María José Pech Canul")).toBe(true);
    expect(pareceSoloNombre("Calle 24 #198, Itzimná")).toBe(false);
    expect(pareceSoloNombre("en Pacabtún")).toBe(false);
    expect(pareceSoloNombre("no sé la colonia, es cerca del Oxxo")).toBe(false);
  });

  describe("contador de colonia no reconocida", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => vi.useRealTimers());

    it("el nombre del cliente (contestando «¿a nombre de quién?») no cuenta como segundo intento: no escala zona_no_reconocida", async () => {
      const v = await nuevoViaje({ cerebroV2: true });
      v.guion([
        { tools: [{ name: "buscar_sucursal_cercana", args: { colonia: "Xyzzylandia" } }] },
        { texto: "No ubico esa colonia. ¿Me comparte la colonia y calle con número? ¿A nombre de quién sería el pedido?" },
      ]);
      await v.escribe("a domicilio en Xyzzylandia");
      v.guion([
        { tools: [{ name: "buscar_sucursal_cercana", args: { colonia: "Gerardo Uc" } }] },
        { texto: "Gracias, Gerardo. ¿Me comparte la colonia y la calle con número?" },
      ]);
      const r = await v.escribe("Gerardo Uc");
      expect(v.callbacks.some((c) => String(c.reason).includes("zona_no_reconocida"))).toBe(false);
      expect(r.reply).toContain("Gerardo");
    });

    it("dos colonias que de verdad no se reconocen siguen escalando (control)", async () => {
      const v = await nuevoViaje({ cerebroV2: true });
      v.guion([{ tools: [{ name: "buscar_sucursal_cercana", args: { colonia: "Xyzzylandia" } }] }, { texto: "No ubico esa colonia, ¿me da otra referencia?" }]);
      await v.escribe("a domicilio en Xyzzylandia");
      v.guion([{ tools: [{ name: "buscar_sucursal_cercana", args: { colonia: "Qwertyville" } }] }, { texto: "Tampoco la ubico." }]);
      await v.escribe("es en Qwertyville");
      expect(v.callbacks.some((c) => String(c.reason).includes("zona_no_reconocida"))).toBe(true);
    });
  });
});

describe("(2) pide al gerente por una queja: primero la disculpa", () => {
  it("«mi pedido llegó completamente frío, quiero hablar con el gerente» escala con disculpa", () => {
    const m = classifyHighRiskIntent("Buenas noches, mi pedido llegó completamente frío, quiero hablar con el gerente");
    expect(m).not.toBeNull();
    expect(m!.reply).toMatch(/lament|disculp/i);
  });
  it("pedir una persona sin queja no cambia (sin disculpa)", () => {
    const m = classifyHighRiskIntent("quiero hablar con una persona por favor");
    expect(m?.intent).toBe("cliente_lo_pide");
    expect(m!.reply).toBe("Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.");
  });
});

describe("(3) el tiempo de la sucursal asignada viaja en buscar_sucursal_cercana (también si es la del chat)", () => {
  it("con cerebro v2 trae tiempo_entrega de esa sucursal; sin la bandera no cambia", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const ctx = { organizationId: v.world.organizationId, channel: "whatsapp" as const, phone: TEL_CLIENTE, entryPropertyId: v.t7 };
    const esperado = (await v.world.repo.findWhatsAppAgentConfig(v.world.organizationId, v.t7))?.deliveryTimeText;
    expect(esperado).toBeTruthy();
    const conV2 = (await executeAgentToolSafely(v.world.repo, { ...ctx, cerebroV2: true }, "buscar_sucursal_cercana", { colonia: "Temozón Norte" })).result as Record<string, unknown>;
    expect(conV2.estado).toBe("asignada");
    expect(conV2.tiempo_entrega).toBe(esperado);
    const sinV2 = (await executeAgentToolSafely(v.world.repo, ctx, "buscar_sucursal_cercana", { colonia: "Temozón Norte" })).result as Record<string, unknown>;
    expect(sinV2.tiempo_entrega).toBeUndefined();
  });
});
