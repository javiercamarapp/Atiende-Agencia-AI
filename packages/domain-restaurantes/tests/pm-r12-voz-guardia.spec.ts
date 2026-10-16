// R11-17 / R12 voz: la guardia determinista de la llamada escala por riesgo (alergia, cobro doble, ARCO, queja, urgencia) aunque el cliente NO pida una persona.
// Modelo guionado y nucleo real de voice-core: sin LLM, sin red, sin base real.
import { describe, expect, it } from "vitest";
import { classifyHighRiskIntent } from "../src/whatsapp/guards.ts";
import { evaluarPersonaVoz, MOTIVO_PERSONA_VOZ } from "../src/voz/guardia-persona.ts";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import type { GuionLlamada, PasoAgente } from "../src/voz/simulador/tipos.ts";

const dice = (texto: string): PasoAgente => ({ dice: texto });

const CASOS: ReadonlyArray<readonly [string, string, string]> = [
  ["alergia es", "Tengo alergia severa al cacahuate, ¿sus tacos son seguros para mí?", "alergia_salud"],
  ["alergia mezclada es/en", "Hola, soy alergico al cacahuate, I need to know si es seguro", "alergia_salud"],
  ["intoxicacion", "Ayer me intoxiqué después de comer sus tacos", "alergia_salud"],
  ["cobro doble", "Ayer me cobraron dos veces en la terminal el mismo pedido", "cobro_duplicado"],
  ["ARCO", "Quiero ejercer mis derechos ARCO, borren mis datos personales", "privacidad_arco"],
  ["queja", "Tengo una queja, el pedido llegó frío", "queja"],
  ["urgencia con espera", "Llevo dos horas esperando mi pedido", "urgencia"],
];

describe("R12 voz: evaluarPersonaVoz sin que el cliente pida una persona", () => {
  for (const [nombre, frase, motivo] of CASOS) {
    it(`${nombre} escala con su motivo y su texto fijo`, () => {
      const d = evaluarPersonaVoz(frase);
      expect(d?.motivo).toBe(motivo);
      expect(d?.texto).toBe(classifyHighRiskIntent(frase)?.reply);
      expect(d?.resumen).not.toContain(frase);
    });
  }

  it("alergia en ingles: escala en cuanto el clasificador la reconoce (los patrones en ingles viven en el carril fix/pm-r12-dinero-y-riesgo; aqui no se duplican)", () => {
    const frase = "I have a severe peanut allergy, is this dish safe for me?";
    if (classifyHighRiskIntent(frase) === null) {
      // Base sin patrones en ingles: la guardia no inventa su propia lista, queda a la espera del clasificador.
      expect(evaluarPersonaVoz(frase)).toBeNull();
      return;
    }
    expect(evaluarPersonaVoz(frase)?.motivo).toBe("alergia_salud");
  });

  it("pedir una persona sigue funcionando y un motivo especifico gana sobre cliente_lo_pide", () => {
    expect(evaluarPersonaVoz("quiero una persona")?.motivo).toBe(MOTIVO_PERSONA_VOZ);
    expect(evaluarPersonaVoz("Quiero hablar con una persona, soy alérgico al gluten")?.motivo).toBe("alergia_salud");
  });

  it("cancelacion_modificacion NO escala por si sola (necesita contexto de pedido), pero no tapa una queja posterior", () => {
    expect(evaluarPersonaVoz("cancela mi pedido por favor")).toBeNull();
    expect(evaluarPersonaVoz("cancela mi pedido, tengo una queja")?.motivo).toBe("queja");
  });

  it("texto vacio, solo espacios, ininteligible o no-cadena: null y sin lanzar", () => {
    for (const t of ["", "   ", "\n\t", "ehh... mmm", "💥💥💥", "1234567890", "a".repeat(100_000)]) expect(() => evaluarPersonaVoz(t), t.slice(0, 10)).not.toThrow();
    for (const t of ["", "   ", "ehh... mmm", "💥💥💥"]) expect(evaluarPersonaVoz(t), t).toBeNull();
    expect(evaluarPersonaVoz(undefined as unknown as string)).toBeNull();
    expect(evaluarPersonaVoz(null as unknown as string)).toBeNull();
    expect(evaluarPersonaVoz(42 as unknown as string)).toBeNull();
  });

  it("es pura e idempotente: la misma frase da la misma decision", () => {
    for (const [, frase] of CASOS) expect(evaluarPersonaVoz(frase)).toEqual(evaluarPersonaVoz(frase));
  });

  it("corpus negativo: pedidos y frases normales de una llamada NO escalan", () => {
    const NEGATIVO = [
      "quiero seis tacos de bistec",
      "hablo desde el centro",
      "sí, a nombre de Juan Pérez",
      "a domicilio, calle 60 número 400",
      "pago con tarjeta",
      "¿me cobran cargo doble si pago con tarjeta?",
      "lo necesito urgente, medio kilo de pastor",
      "me falta pedir otra coca",
      "¿cuánto es el envío?",
      "gracias, hasta luego",
      "llevo diez minutos esperando en la sucursal",
      "el habanero me cayó mal, sin habanero por favor",
      "me enfermé y no puedo salir, mándelo a domicilio",
    ];
    for (const t of NEGATIVO) expect(evaluarPersonaVoz(t), t).toBeNull();
  });
});

describe("R12 voz: la llamada (simulador con modelo guionado)", () => {
  it("alergia sin pedir una persona: la guardia habla antes del modelo, UN callback con motivo alergia_salud y la llamada cierra escalada", async () => {
    const g: GuionLlamada = {
      id: "R12-alergia",
      titulo: "alergia sin pedir persona",
      rasgos: [],
      turnos: [{ kind: "voz", cliente: "Tengo alergia severa al cacahuate, ¿sus tacos son seguros para mí?", agente: [dice("Claro que sí, no tienen cacahuate.")] }],
      esperado: { resultado: "escalado", sinPedido: true, callbacks: ["escalada:alergia_salud"] },
    };
    const llamada = await correrGuion(g);
    expect(llamada.resultado).toBe("escalado");
    expect(llamada.mundo.callbacks.map((c) => c.reason)).toEqual(["escalada:alergia_salud"]);
    expect(llamada.textosGuardia).toHaveLength(1);
    expect(llamada.textosGuardia?.[0]).toMatch(/no puedo asegurarle los ingredientes/);
  });

  it("idempotente: despues de escalar, nuevas hablas de riesgo (o colgar) no avisan otra vez", async () => {
    const llamada = await correrGuion({
      id: "R12-idempotente",
      titulo: "dos senales seguidas",
      rasgos: [],
      turnos: [
        { kind: "voz", cliente: "Me cobraron dos veces el mismo pedido", agente: [dice("Entiendo.")] },
        { kind: "voz", cliente: "Y además tengo alergia al cacahuate", agente: [dice("Ok.")] },
        { kind: "cuelga" },
      ],
      esperado: { resultado: "escalado", sinPedido: true, callbacks: ["escalada:cobro_duplicado"] },
    });
    expect(llamada.mundo.callbacks).toHaveLength(1);
    expect(llamada.textosGuardia).toHaveLength(1);
    expect(llamada.resultado).toBe("escalado");
  });

  it("habla ininteligible (confuso), ruido, silencio y DTMF 1 no disparan la guardia", async () => {
    const llamada = await correrGuion({
      id: "R12-ininteligible",
      titulo: "senales no inteligibles",
      rasgos: [],
      turnos: [{ kind: "confuso", cliente: "tengo alergia al cacahuate" }, { kind: "ruido" }, { kind: "silencio", ms: 1000 }, { kind: "dtmf", digito: "1" }, { kind: "cuelga" }],
      esperado: { resultado: "abandonado", sinPedido: true },
    });
    expect(llamada.textosGuardia).toEqual([]);
    expect(llamada.mundo.callbacks).toEqual([]);
  });

  it("DTMF 0 sigue escalando de forma determinista", async () => {
    const llamada = await correrGuion({ id: "R12-dtmf0", titulo: "dtmf 0", rasgos: [], turnos: [{ kind: "dtmf", digito: "0" }], esperado: { resultado: "escalado", sinPedido: true } });
    expect(llamada.resultado).toBe("escalado");
  });

  it("un pedido normal por voz no se escala (sin falsos positivos en la llamada)", async () => {
    const llamada = await correrGuion({
      id: "R12-normal",
      titulo: "frase normal",
      rasgos: [],
      turnos: [{ kind: "voz", cliente: "Quiero seis tacos de bistec, lo necesito urgente", agente: [dice("Con gusto, ¿a domicilio o para recoger?")] }, { kind: "cuelga" }],
      esperado: { resultado: "abandonado", sinPedido: true },
    });
    expect(llamada.textosGuardia).toEqual([]);
    expect(llamada.mundo.callbacks).toEqual([]);
  });
});
