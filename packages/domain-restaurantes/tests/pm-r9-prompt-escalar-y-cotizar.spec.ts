// QA-PM-R9 (causas P2 y P3): el prompt no debe mandar a escalar "cualquier otro cambio" (choca con H4 y 5b) y debe cotizar temprano.
// Pruebas deterministas sobre el TEXTO del prompt; el efecto en el comportamiento del LLM solo se mide con una ronda real (ronda 10).
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { COMPORTAMIENTO_VOZ_MAX, comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";

const sucursal = { propertyId: "p7", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null };
const wa = buildPmSystemPrompt({
  businessName: "Los Taquitos de PM",
  agentName: PM_AGENT_NAME_POR_OMISION,
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: [sucursal],
  entryBranch: { name: sucursal.name, slug: sucursal.slug },
  customer: { isNew: true },
  fechaHoraLocal: "6 de octubre de 2026, 13:00",
  diaSemana: "martes",
});
const voz = comportamientoVozPm({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: PM_AGENT_NAME_POR_OMISION,
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  branches: [sucursal],
});

/** Texto de un paso numerado del flujo, desde "\nN. " hasta el siguiente paso. */
const paso = (p: string, n: string, sig: string) => {
  const i = p.indexOf(`\n${n}. `);
  const j = p.indexOf(`\n${sig}. `, i + 1);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThan(i);
  return p.slice(i, j);
};

describe("P2: producto o cambio inexistente = 'no lo manejamos', alternativa y seguir", () => {
  it("WhatsApp: el paso 6 ya no dice 'Cualquier otro cambio, escale'", () => {
    expect(wa).not.toMatch(/Cualquier otro cambio, escale/);
    const p6 = paso(wa, "6", "7");
    expect(p6).toMatch(/buscar_producto sin resultado/);
    expect(p6).toMatch(/no lo manejamos/);
    expect(p6).toMatch(/alternativa más cercana/);
    expect(p6).toMatch(/y siga con el resto del pedido sin escalar/);
    expect(p6).toMatch(/Escale solo si el cliente insiste/);
    expect(p6).toMatch(/modificacion_platillo si es una receta, H4/);
  });
  it("voz: el paso 6 tampoco manda a escalar 'otro cambio' y cabe en el tope", () => {
    expect(voz).not.toMatch(/otro cambio: escale/);
    expect(voz).toMatch(/6\. Cambios:[^\n]*no lo manejamos[^\n]*siga; escale solo si insiste\./);
    expect(voz.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
  });
  it("coherente con H4 y 5b: la resta no escala, lo no manejado se dice y se sigue", () => {
    expect(wa).toMatch(/H4\. [^\n]*SIN escalar/);
    expect(wa).toMatch(/H4\. [^\n]*"No lo manejamos/);
    expect(paso(wa, "5b", "6")).toMatch(/sushi no lo manejamos[^\n]*siga con lo demás/);
  });
  it("no queda ninguna regla de escalación abierta para 'cualquier' cambio o producto raro", () => {
    for (const p of [wa, voz]) {
      expect(p).not.toMatch(/(cualquier|todo) (otro )?(cambio|producto)[^.\n]{0,40}escale/i);
    }
  });
});

describe("P3: cotizar temprano y el 'confirmo' sin resumen no ofrece promociones", () => {
  it("5b y el paso 9 piden cotizar con canal, producto y tortilla aunque falten nombre, pago y hora", () => {
    expect(paso(wa, "5b", "6")).toMatch(/llame cotizar_pedido en cuanto tenga canal, producto y tortilla, aunque falten nombre, pago y hora/);
    expect(paso(wa, "9", "10")).toMatch(/en cuanto tenga canal, producto y tortilla \(5b\)/);
    expect(voz).toMatch(/9\. cotizar_pedido[^\n]*ya con canal, producto y tortilla\./);
  });
  it("el paso 10 cotiza y muestra el resumen ante 'confirmo/sí' sin resumen, sin promociones ni crear_pedido", () => {
    const p10 = paso(wa, "10", "11");
    expect(p10).toMatch(/Un "confirmo" o "sí" sin resumen con total mostrado/);
    expect(p10).toMatch(/cotice y muestre el resumen en ese turno, sin promociones/);
    expect(p10).toMatch(/ni confirmar_resumen ni crear_pedido/);
    expect(voz).toMatch(/"Confirmo" sin resumen: cotice y resuma, sin promos/);
  });
  it("sigue en pie: promo UNA vez ANTES del resumen y el 'sí' se cierra solo si ya hubo resumen (paso 11)", () => {
    expect(paso(wa, "10", "11")).toMatch(/ofrézcalas UNA sola vez, ANTES del resumen/);
    expect(paso(wa, "11", "12")).toMatch(/^\n11\. Con el sí a un resumen ya mostrado/);
    expect(paso(wa, "10", "11")).toMatch(/Nunca llame confirmar_resumen en el mismo mensaje en que cotizó/);
  });
  it("no queda una frase que pida juntar todos los datos antes de cotizar", () => {
    expect(wa).not.toMatch(/cotice (solo )?(cuando|después de) (tenga )?(nombre|pago|hora)/i);
    expect(wa).not.toMatch(/(?<!no )(espere|hasta) (a )?(tener|juntar) todos los datos/i);
  });
  it("la cotizacion temprana es PRELIMINAR (no es resumen mostrado) y el 'confirmo' de mas tras crear lo atiende H12", () => {
    const p10 = paso(wa, "10", "11");
    expect(p10).toMatch(/Una cotización temprana \(5b\) es PRELIMINAR/);
    expect(p10).toMatch(/un "sí" a otra pregunta \(número, "¿algo más\?"\) no es el sí al resumen/);
    expect(p10).toMatch(/tras "Su pedido ya quedó registrado", un "confirmo" o "sí" de más lo atiende H12/);
  });
});

describe("la version de voz recortada (tope de 8000 caracteres) conserva sus reglas duras", () => {
  // El tope de 8000 deja ~3 caracteres de margen: las frases recortadas ("Lista vacía: no existe ahí", "Alcohol: solo en sucursal", "no lo afirme de memoria", "sin exigir referencias")
  // no caben; lo duro que cubrian sigue escrito en otros puntos y se fija aqui para que un recorte futuro no lo pierda en silencio.
  it("el alcohol se retira a domicilio (9); el horario lo da la herramienta (H16); lo inexistente se dice y se sigue (6); la direccion pide calle, numero y colonia (4)", () => {
    expect(voz).toMatch(/4\. [^\n]*dirección escrita \(calle, número y colonia\)/);
    expect(voz).toMatch(/9\. cotizar_pedido[^\n]*Alcohol a domicilio: retírelo/);
    expect(voz).toMatch(/Horario: lo da consultar_sucursal \(H16\)/);
    expect(voz).toMatch(/Si no existe: "no lo manejamos"/);
    expect(voz.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
  });
  // El tope con las 7 sucursales reales lo cubre seed-pm-demo.spec.ts (buildPmSeedPlan lanza RangeError si se pasa de 8000).
});
