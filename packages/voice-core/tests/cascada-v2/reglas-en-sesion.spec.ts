// Reglas condicionales del prompt de voz (dieta, fase 4): la sesion v2 las agrega a la conversacion SOLO cuando el cliente toca el tema, una vez por llamada y
// sin cambiar la instruccion (el prefijo estable conserva el cache del proveedor).
import { describe, expect, it } from "vitest";
import { TITULO_REGLAS_CONDICIONALES, crearProveedorCascadaV2 } from "../../src/index.ts";
import { SttFalso, TtsFalso, escribe, llmFalso, manejadoresFalsos } from "./dobles.ts";

const REGLAS = [
  { id: "kilos", patron: "\\bkilo|cuarto", texto: "KILOS: un cuarto es el producto de 250 g." },
  { id: "combo_martes", patron: "nachos|martes", texto: "COMBO DEL MARTES: dos aguas por orden completa." },
];

describe("reglas condicionales en la sesion v2", () => {
  it("solo entra la regla del tema que el cliente toco, una sola vez, y la instruccion no cambia", async () => {
    const llm = llmFalso([escribe(["Claro."])]);
    const stt = new SttFalso();
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso() });
    await prov.abrirSesion({ instruccion: "BASE", voiceId: "Kore", herramientas: [], reglasCondicionales: REGLAS }, manejadoresFalsos().h);
    stt.eventos!.turnoFinal("quiero tres tacos de pastor");
    await prov.inactivo();
    stt.eventos!.turnoFinal("y un cuarto de kilo de bistec");
    await prov.inactivo();
    stt.eventos!.turnoFinal("mejor medio kilo");
    await prov.inactivo();
    const ultima = JSON.stringify(llm.peticiones.at(-1)!.mensajes);
    expect(llm.peticiones.every((p) => p.system === "BASE")).toBe(true);
    expect(JSON.stringify(llm.peticiones[0]!.mensajes)).not.toContain("KILOS");
    expect(ultima.split("KILOS").length - 1).toBe(1);
    expect(ultima).toContain(JSON.stringify(TITULO_REGLAS_CONDICIONALES).slice(1, -1));
    expect(ultima).not.toContain("COMBO DEL MARTES");
  });
});
