// Latencia (E2E r3, 8-nov-2026): la respuesta con contenido tardaba 6.8-10 s p50 porque Luna gasta una vuelta (~2.5 s) solo en pedir lecturas (buscar_producto,
// consultar_sucursal, buscar_cliente: ~3.4 por llamada) antes de cotizar o contestar. La vertical puede PRECARGAR esas lecturas: la sesion las corre antes de la
// primera vuelta y se las entrega al modelo como si ya las hubiera pedido (mismo patron que `whatsapp/contexto-precargado.ts`). Solo resultados utiles; nada que escriba.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "../../src/index.ts";
import type { AperturaLlamada } from "../../src/index.ts";
import { SttFalso, TtsFalso, llmFalso, manejadoresFalsos } from "./dobles.ts";

const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [], vocabulario: [] };

async function armar(precargar: ((texto: string, turno: number) => { nombre: string; args: Record<string, unknown> }[]) | undefined, salidas: Record<string, unknown>) {
  const orden: string[] = [];
  const llm = llmFalso([async (_p, dice) => (orden.push("llm"), dice("Claro, son tres de pastor."), { texto: "Claro, son tres de pastor.", toolCalls: [] })]);
  const stt = new SttFalso();
  const m = manejadoresFalsos({ ejecutarTool: async (l) => (orden.push(`tool:${l.nombre}`), salidas[l.nombre] ?? { error: "x" }) });
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), ahora: () => 1_700_000_000_000 });
  await prov.abrirSesion(APERTURA, { ...m.h, ...(precargar ? { precargar } : {}) });
  stt.eventos!.turnoFinal("quiero tres tacos de pastor");
  await prov.inactivo();
  return { llm, orden };
}

describe("precarga de lecturas de la vertical antes de la primera vuelta", () => {
  it("corre las lecturas ANTES del modelo y le entrega llamada + resultado en el historial", async () => {
    const { llm, orden } = await armar(() => [{ nombre: "buscar_producto", args: { query: "tacos de pastor", branch_slug: "t7" } }], { buscar_producto: { productos: [{ id: "p1", name: "Taco al pastor", price: 42 }] } });
    expect(orden).toEqual(["tool:buscar_producto", "llm"]);
    const msgs = llm.peticiones[0]!.mensajes as unknown as { role: string; toolCalls?: { nombre: string; argsJson: string }[]; content?: string }[];
    const asist = msgs.find((x) => x.role === "assistant" && x.toolCalls?.length);
    expect(asist?.toolCalls?.[0]?.nombre).toBe("buscar_producto");
    expect(msgs.some((x) => x.role === "tool" && String(x.content).includes("Taco al pastor"))).toBe(true);
  });

  it("un resultado con error no entra al historial (el modelo lo pide si lo necesita)", async () => {
    const { llm } = await armar(() => [{ nombre: "buscar_cliente", args: {} }], { buscar_cliente: { error: "telefono_pendiente" } });
    const msgs = llm.peticiones[0]!.mensajes as unknown as { role: string }[];
    expect(msgs.some((x) => x.role === "tool")).toBe(false);
  });

  it("sin precarga de la vertical nada cambia", async () => {
    const { orden } = await armar(undefined, {});
    expect(orden).toEqual(["llm"]);
  });
});
