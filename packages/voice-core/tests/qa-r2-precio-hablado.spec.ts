// QA adversarial R2 (lente AGENTES, restaurantes) -- voz: re-verificacion del cierre de R1-13 (precio HABLADO vs cotizado).
// El cierre agrego el grader G_PRECIO_HABLADO (red de deteccion del simulador y de los evals reales; no hay guardia previa al TTS). Se ataca con
// llamadas guionadas de PM: 3 tacos de pastor a $42 ($126) + 1 Coca-Cola $53 = $179; minimo a domicilio $200.
// Convencion: `it.fails` = comportamiento ESPERADO que hoy falla (defecto QA-restaurantes-R2-agentes-NN); `it` = correcto confirmado.
import { describe, expect, it } from "vitest";
import { G_PRECIO_HABLADO, importesDeTotalHablado } from "../src/simulador/index.ts";
import type { LlamadaGradeable } from "../src/simulador/index.ts";

const COTIZACION = { quote: { total: 179, subtotal: 179, lines: [{ name: "Taco Al Pastor", price: 42, quantity: 3, line_total: 126 }, { name: "Coca-Cola", price: 53, quantity: 1, line_total: 53 }] } };
const SUCURSAL = { pedido_minimo_domicilio: 200, distancia_km: 3 };

function llamada(dice: string, tools: readonly { nombre: string; resultado: unknown }[]): LlamadaGradeable {
  return { tools: tools.map((t) => ({ ...t, args: {} })), transcripcion: [{ rol: "agente", texto: dice }] } as unknown as LlamadaGradeable;
}

describe("R2 G_PRECIO_HABLADO: el TOTAL dicho tiene que ser el total cotizado", () => {
  // QA-restaurantes-R2-agentes-09 (P2, R1-13 reabierto en parte): el grader acepta CUALQUIER numero que haya devuelto CUALQUIER herramienta en la
  // llamada (precio unitario, importe de un renglon, minimo de la sucursal). Un agente que dice como TOTAL el precio de un taco o el minimo pasa.
  it("R2-09a 'su total es de cuarenta y dos pesos' (precio de UN taco) con total cotizado $179 se marca", async () => {
    expect((await G_PRECIO_HABLADO(llamada("Perfecto, su total es de cuarenta y dos pesos.", [{ nombre: "cotizar_pedido", resultado: COTIZACION }]))).ok).toBe(false);
  });

  it("R2-09b 'en total son doscientos pesos' (el MINIMO de la sucursal) con total cotizado $179 se marca", async () => {
    const r = await G_PRECIO_HABLADO(llamada("En total son doscientos pesos.", [{ nombre: "consultar_sucursal", resultado: SUCURSAL }, { nombre: "cotizar_pedido", resultado: COTIZACION }]));
    expect(r.ok).toBe(false);
  });

  // QA-restaurantes-R2-agentes-10 (P3): el total dicho SIN la palabra "pesos" (como se dice por telefono: "son ciento ochenta") no se revisa.
  it("R2-10 'su total queda en ciento ochenta' (sin 'pesos') con total $179 se marca", async () => {
    expect((await G_PRECIO_HABLADO(llamada("Su total queda en ciento ochenta, ¿confirma?", [{ nombre: "cotizar_pedido", resultado: COTIZACION }]))).ok).toBe(false);
  });

  it("control: el total correcto en palabras o en digitos pasa; una cifra que ninguna herramienta devolvio se marca", async () => {
    expect((await G_PRECIO_HABLADO(llamada("Su total es de ciento setenta y nueve pesos.", [{ nombre: "cotizar_pedido", resultado: COTIZACION }]))).ok).toBe(true);
    expect((await G_PRECIO_HABLADO(llamada("Son $179, ¿confirma?", [{ nombre: "cotizar_pedido", resultado: COTIZACION }]))).ok).toBe(true);
    expect((await G_PRECIO_HABLADO(llamada("Son ciento cincuenta pesos.", [{ nombre: "cotizar_pedido", resultado: COTIZACION }]))).ok).toBe(false);
  });
});

describe("R2 importesDeTotalHablado: solo cifras presentadas como total, nunca cantidades", () => {
  it.each([
    ["Su total queda en ciento ochenta, ¿confirma?", [180]],
    ["Son 179 en total.", []],
    ["El total es 179, ¿confirma?", [179]],
    ["Total: $1,500 pesos", [1500]],
    ["En total son doscientos pesos.", [200]],
    ["El total de 3 tacos es ciento veintiseis pesos", []],
    ["Total antes del descuento: ciento cuarenta y cuatro pesos. Total a pagar: setenta y dos pesos", [72]],
    ["Son tres tacos y una coca, ¿algo más?", []],
    ["Su pedido tarda en total veinte minutos", []],
  ])("%s", (texto, esperado) => {
    expect(importesDeTotalHablado(texto)).toEqual(esperado);
  });

  it("un agente que dice 'su total' y luego presenta el total real de una re-cotizacion no se marca", async () => {
    const dos = [
      { nombre: "cotizar_pedido", resultado: COTIZACION },
      { nombre: "cotizar_pedido", resultado: { quote: { total: 250 } } },
    ];
    const l = { tools: dos.map((t) => ({ ...t, args: {} })), transcripcion: [{ rol: "agente", texto: "Su total es de ciento setenta y nueve pesos." }, { rol: "agente", texto: "Ahora su total es de doscientos cincuenta pesos." }] } as unknown as LlamadaGradeable;
    expect((await G_PRECIO_HABLADO(l)).ok).toBe(true);
  });
});
