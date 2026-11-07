// Cerebro v2: recorte del prompt base de PM (~63k caracteres) quitando lo que el SERVIDOR ya hace cumplir de forma determinista con la bandera, o lo que
// POLÍTICAS DE LA CASA v2 ya dice (una sola fuente). Solo con cerebro_v2 (adaptarPromptPmV2); sin la bandera el prompt queda idéntico. Lista antes/después en el PR.
//   R1. H4 «Las alergias siguen escalando siempre» y H8 «alergias»: la alergia la decide el servidor antes del modelo (decidirAntesDelModelo, aviso URGENTE) y en
//       crear_pedido (bloqueo 120 min + nota).
//   R2. H9 segunda frase y H14 (no decir registrado / folio / en cocina sin crear_pedido): guardiaTextoFinal (afirma registro sin pedido, clase del rechazo,
//       por aprobar dado por confirmado).
//   R3. Paso 7: propina (el servidor descarta propina/propina_porcentaje con v2) y transferencia (POLÍTICAS «Pago»; la ya realizada la escala el servidor).
//   R4. H16 largo: el servidor valida horario, programado_para y hora de recoger (y omite ahora+30 / revalida 25 min); queda lo que el modelo decide y POLÍTICAS «Horarios».
//   R5. Paso 13 (cambios después de confirmar): la guarda del pedido en la sesión rechaza el segundo crear_pedido como cambio y la cancelación la decide el
//       servidor antes del modelo; rige POLÍTICAS «Cambiar o agregar algo a un pedido YA creado» (antes se contradecían: escalar_a_humano vs registrar_contacto).
//   R7. Paso 8, párrafo de pedido grande: el servidor lo marca al crear y rechaza escalar_a_humano con pedido_grande (POLÍTICAS «Pedido grande»).
//   R6. Datos: «Cancelar o cambiar un pedido ya hecho: … escale» (contradice POLÍTICAS v2) y la frase repetida de programado_para del paso 8.
import { describe, expect, it } from "vitest";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";

const base = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-10-06T13:00:00-06:00"), null, "", "", false, true);
const v2 = adaptarPromptPmV2(base);

describe("prompt base recortado con cerebro v2", () => {
  it("R1: sin las reglas de alergia del prompt (las hace cumplir el servidor)", () => {
    expect(base).toContain("Las alergias siguen escalando siempre (alergia_salud).");
    expect(v2).not.toContain("Las alergias siguen escalando siempre");
    expect(v2).toContain("H8. No decida usted: quejas, reposiciones, descuentos, cancelaciones o cambios de un pedido ya confirmado, tiempos de entrega fuera de lo normal. Todo eso se escala");
  });

  it("R2: H9 conserva el «repita y espere el sí»; fuera la frase de registro y H14 (guardia del texto final)", () => {
    expect(v2).toContain('H9. Nunca registre un pedido sin repetirlo completo al cliente y recibir su "sí".');
    expect(v2).not.toContain("Nunca diga que el pedido está registrado si crear_pedido no respondió con éxito.");
    expect(v2).not.toContain("H14. Nunca invente un folio");
  });

  it("R3: paso 7 sin propina ni transferencia (POLÍTICAS v2 + servidor); se queda el efectivo y la terminal", () => {
    expect(v2).not.toContain("ignore preguntar_propina");
    expect(v2).not.toContain("Transferencia: NO se acepta (no la escale)");
    expect(v2).toContain("Efectivo: pregunte SIEMPRE con cuánto paga");
  });

  it("R4: H16 corto que remite a POLÍTICAS «Horarios» (sin la contradicción de programar con la sucursal ya cerrada por hoy)", () => {
    expect(base).toContain("TOME el pedido y PROGRÁMELO");
    expect(v2).not.toContain("TOME el pedido y PROGRÁMELO");
    expect(v2).toMatch(/H16\. Horario: SOLO los datos de la sucursal/);
  });

  it("R5: paso 13 remite a POLÍTICAS v2 (cambios a un pedido ya creado) y conserva el cambio de hora antes de crear", () => {
    expect(base).toContain('motivo "cancelacion_modificacion", dígale al gerente exactamente qué cambió');
    expect(v2).not.toContain('motivo "cancelacion_modificacion", dígale al gerente exactamente qué cambió');
    expect(v2).toMatch(/13\. CAMBIOS DESPUÉS DE CONFIRMAR: siga POLÍTICAS DE LA CASA/);
    expect(v2).toContain("CAMBIO DE HORA de recogida");
  });

  it("R6: sin la línea de cancelar de los datos ni la frase repetida de programado_para", () => {
    expect(v2).not.toContain("- Cancelar o cambiar un pedido ya hecho: lo confirma una persona; escale.");
    const frase = 'Nunca mande programado_para vacío ni para "en 20 minutos"';
    expect(base.split(frase).length - 1).toBe(2);
    expect(v2.split(frase).length - 1).toBe(1);
  });

  it("R7: sin el párrafo de pedido grande del paso 8 (lo marca el servidor al crear y rechaza escalarlo)", () => {
    expect(base).toContain("NO llame escalar_a_humano con motivo pedido_grande");
    expect(v2).not.toContain("NO llame escalar_a_humano con motivo pedido_grande");
    expect(v2).toContain("Una cantidad exagerada");
  });

  it("el prompt v2 es al menos 3800 caracteres más corto", () => {
    expect(base.length - v2.length).toBeGreaterThanOrEqual(3800);
    // Visible en la salida de la prueba para la lista antes/después del PR.
    console.info(`[prompt-v2] base ${base.length} caracteres -> v2 ${v2.length} (${base.length - v2.length} menos)`);
  });
});
