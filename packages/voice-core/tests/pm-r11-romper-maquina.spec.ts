// R11 romper -- VOZ: la maquina de estados de la llamada contra secuencias hostiles. Determinista: generador pseudoaleatorio con semilla (sin Math.random).
// Lo que el cliente puede provocar por voz (ruido, silencio, DTMF, colgar a medias, herramientas lentas, proveedor que cae y vuelve) llega a la
// maquina como eventos; ninguna secuencia debe lanzar, colgar dos veces, reabrir una llamada cerrada ni dejar un pedido creado como "abandonado".
import { describe, expect, it } from "vitest";
import { CallStateMachine, LIMITES_POR_DEFECTO } from "../src/llamada/maquina.ts";
import type { AccionLlamada, EventoLlamada } from "../src/llamada/maquina.ts";

const REGLAS = { herramientaObjetivo: "crear_pedido", resultadoObjetivo: "pedido_creado", herramientaEscalar: "escalar_a_humano" } as const;

/** LCG de 32 bits (mismos numeros en cualquier maquina). */
function prng(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function eventoAlAzar(r: () => number): EventoLlamada {
  const elige = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const tipo = elige(["conectada", "agente_empieza", "agente_termina", "usuario_habla", "usuario_dijo", "ruido", "no_entendido", "silencio", "dtmf", "tool_resultado", "despedida_dicha", "costo", "tick", "proveedor_cae", "proveedor_vuelve", "cliente_cuelga", "escalada_forzada"] as const);
  switch (tipo) {
    case "usuario_dijo":
      return { tipo, inteligible: elige([true, false, undefined]) };
    case "silencio":
      return { tipo, ms: elige([0, 1000, 6999, 7000, 60_000, Number.NaN, -5]) };
    case "dtmf":
      return { tipo, digito: elige(["0", "*", "1", "#", "", "99", "💥"]) };
    case "tool_resultado":
      return {
        tipo,
        nombre: elige(["crear_pedido", "escalar_a_humano", "cotizar_pedido", "inexistente", ""]),
        ok: elige([true, false]),
        entidadId: elige(["p1", null, undefined, ""]),
        timeout: elige([true, false, undefined]),
        retenido: elige([true, false, undefined]),
        incierto: elige([true, false, undefined]),
      };
    case "costo":
      return { tipo, microUsd: elige([0, 1, 50_000, 1_000_000, Number.NaN, Number.POSITIVE_INFINITY, -100]) };
    case "tick":
      return { tipo, segundos: elige([0, 30, 419, 420, 479, 480, 600, 3600, Number.NaN, -1]) };
    default:
      return { tipo } as EventoLlamada;
  }
}

describe("R11-V1 secuencias hostiles de eventos de la llamada (500 llamadas x hasta 120 eventos, semilla fija)", () => {
  it("nunca lanza, cuelga a lo mucho una vez, no reabre una llamada cerrada y un pedido creado no termina 'abandonado' salvo cierre forzado", () => {
    const r = prng(20261015);
    for (let llamada = 0; llamada < 500; llamada += 1) {
      const m = new CallStateMachine(REGLAS);
      const colgadas: AccionLlamada[] = [];
      let creado = false;
      let forzada = false;
      let cerroAntes = false;
      const largo = 1 + Math.floor(r() * 120);
      for (let i = 0; i < largo; i += 1) {
        const ev = eventoAlAzar(r);
        let acciones: readonly AccionLlamada[] = [];
        expect(() => {
          acciones = m.recibir(ev);
        }, `llamada ${llamada} evento ${i}: ${JSON.stringify(ev)}`).not.toThrow();
        if (cerroAntes) expect(acciones, `llamada ${llamada}: acciones despues de cerrada`).toEqual([]);
        if (ev.tipo === "tool_resultado" && ev.ok && ev.entidadId && ev.nombre === "crear_pedido" && !cerroAntes) creado = true;
        if (ev.tipo === "escalada_forzada" && !cerroAntes) forzada = true;
        colgadas.push(...acciones.filter((a) => a.tipo === "colgar"));
        if (m.estadoActual === "cerrada") cerroAntes = true;
      }
      expect(colgadas.length, `llamada ${llamada}`).toBeLessThanOrEqual(1);
      if (m.estadoActual === "cerrada" && creado && !forzada) expect(m.resultado, `llamada ${llamada}: pedido creado`).toBe("pedido_creado");
    }
  });
});

describe("R11-V2 limites duros de la llamada", () => {
  const conectada = () => {
    const m = new CallStateMachine(REGLAS);
    m.recibir({ tipo: "conectada" });
    return m;
  };

  it("a los 480 s (8 min) la llamada se corta y deja a una persona; ni un segundo mas de margen en la maquina", () => {
    const m = conectada();
    expect(m.recibir({ tipo: "tick", segundos: LIMITES_POR_DEFECTO.duracionMaxS - 1 }).some((a) => a.tipo === "colgar")).toBe(false);
    const acciones = m.recibir({ tipo: "tick", segundos: LIMITES_POR_DEFECTO.duracionMaxS });
    expect(acciones.some((a) => a.tipo === "colgar")).toBe(true);
    expect(m.estadoActual).toBe("cerrada");
    expect(m.resultado).toBe("escalado");
  });

  it("aunque el cliente siga hablando y haya ruido constante, el tick de duracion maxima manda (un cliente no alarga la llamada)", () => {
    const m = conectada();
    for (let i = 0; i < 200; i += 1) {
      m.recibir({ tipo: "usuario_habla" });
      m.recibir({ tipo: "usuario_dijo", inteligible: true });
      if (m.estadoActual === "cerrada") break;
    }
    m.recibir({ tipo: "tick", segundos: 9 * 60 });
    expect(m.estadoActual).toBe("cerrada");
  });

  it("el costo acumulado corta la llamada al tope aunque lleguen valores raros (NaN, infinito, negativos) en medio", () => {
    const m = conectada();
    m.recibir({ tipo: "costo", microUsd: Number.NaN });
    m.recibir({ tipo: "costo", microUsd: -1_000_000 });
    expect(m.estadoActual).toBe("activa");
    m.recibir({ tipo: "costo", microUsd: LIMITES_POR_DEFECTO.costoMaxMicroUsd });
    expect(m.estadoActual).toBe("cerrada");
  });

  it("con el pedido ya creado, el limite de duracion solo se despide: el resultado sigue siendo pedido_creado", () => {
    const m = conectada();
    m.recibir({ tipo: "tool_resultado", nombre: "crear_pedido", ok: true, entidadId: "p1" });
    const acciones = m.recibir({ tipo: "tick", segundos: 10 * 60 });
    expect(acciones.some((a) => a.tipo === "escalar")).toBe(false);
    expect(m.resultado).toBe("pedido_creado");
  });

  it("3 ruidos seguidos son un malentendido y 2 malentendidos pasan a una persona; el DTMF '0' pide persona; teclas raras no hacen nada", () => {
    const a = conectada();
    for (let i = 0; i < 6; i += 1) a.recibir({ tipo: "ruido" });
    expect(a.estadoActual).toBe("cerrada");
    const b = conectada();
    for (const digito of ["1", "#", "", "99", "💥"]) expect(b.recibir({ tipo: "dtmf", digito })).toEqual([]);
    expect(b.recibir({ tipo: "dtmf", digito: "0" }).some((x) => x.tipo === "escalar")).toBe(true);
  });

  it("el proveedor cae dos veces: una reconexion y luego a una persona (sin bucle de reconexion)", () => {
    const m = conectada();
    expect(m.recibir({ tipo: "proveedor_cae" }).some((a) => a.tipo === "reconectar")).toBe(true);
    m.recibir({ tipo: "proveedor_vuelve" });
    const segunda = m.recibir({ tipo: "proveedor_cae" });
    expect(segunda.some((a) => a.tipo === "reconectar")).toBe(false);
    expect(m.estadoActual).toBe("cerrada");
  });
});
