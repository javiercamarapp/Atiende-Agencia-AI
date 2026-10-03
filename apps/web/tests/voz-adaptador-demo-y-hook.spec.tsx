// @vitest-environment jsdom
//
// Adaptador de DEMOSTRACION (sesion simulada con volumen sintetico y transcripcion
// de ejemplo) y el hook useSesionVoz que lo convierte en un VoiceSessionController.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionController } from "@atiende/ui";
import { crearFabricaDemo, SALUDO_DEMO_POR_DEFECTO, volumenSintetico } from "./support/adaptador-demo.ts";
import type { AdaptadorVoz, CallbacksAdaptador, FabricaAdaptador } from "../src/lib/voz/adaptador.ts";
import { useSesionVoz } from "../src/lib/voz/useSesionVoz.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let ctl: VoiceSessionController;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

function Probe({ fabrica }: { fabrica: FabricaAdaptador }) {
  ctl = useSesionVoz(fabrica);
  return null;
}

function montar(fabrica: FabricaAdaptador) {
  rendered = renderComponent(<Probe fabrica={fabrica} />);
}

async function avanzar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function iniciar() {
  await act(async () => {
    await ctl.iniciar();
  });
}

describe("volumenSintetico", () => {
  it("es determinista y siempre está en 0..1", () => {
    for (let t = 0; t < 500; t++) {
      const v = volumenSintetico(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(volumenSintetico(t)).toBe(v);
    }
  });
});

describe("adaptador demo + useSesionVoz", () => {
  it("arranca en reposo y al iniciar pasa a conectando con un sessionId de demo", async () => {
    montar(crearFabricaDemo());
    expect(ctl.estado.modo).toBe("reposo");
    await iniciar();
    expect(ctl.estado.modo).toBe("conectando");
    expect(ctl.estado.sessionId).toMatch(/^demo-/);
    expect(ctl.estado.volumenEntrada).toBe(0);
    expect(ctl.estado.volumenSalida).toBe(0);
  });

  it("recorre conectando -> hablando -> escuchando -> pensando -> hablando -> escuchando", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    const vistos: string[] = [ctl.estado.modo];
    for (let i = 0; i < 400; i++) {
      await avanzar(50);
      if (vistos[vistos.length - 1] !== ctl.estado.modo) vistos.push(ctl.estado.modo);
    }
    expect(vistos).toEqual(["conectando", "hablando", "escuchando", "pensando", "hablando", "escuchando"]);
  });

  it("emite la transcripción de ejemplo: saludo con aviso de asistente virtual, pedido del usuario y aclaración de simulación", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    await avanzar(20_000);
    const t = ctl.estado.transcripcion;
    expect(t.map((l) => l.rol)).toEqual(["agente", "usuario", "agente"]);
    expect(t.every((l) => !l.parcial)).toBe(true);
    expect(t[0]!.texto).toBe(SALUDO_DEMO_POR_DEFECTO);
    expect(t[0]!.texto.toLowerCase()).toContain("asistente virtual");
    expect(t[2]!.texto.toLowerCase()).toContain("demostración simulada");
  });

  it("usa el primer mensaje configurado como saludo y lo entrega por fragmentos parciales", async () => {
    montar(crearFabricaDemo({ saludo: "Buenas tardes, soy el asistente virtual de Los Taquitos" }));
    await iniciar();
    await avanzar(700 + 120 * 3 + 10);
    const linea = ctl.estado.transcripcion[0]!;
    expect(linea.parcial).toBe(true);
    expect(linea.texto.startsWith("Buenas tardes")).toBe(true);
    expect(linea.texto).not.toBe("Buenas tardes, soy el asistente virtual de Los Taquitos");
    await avanzar(5_000);
    expect(ctl.estado.transcripcion[0]!.parcial).toBe(false);
    expect(ctl.estado.transcripcion[0]!.texto).toBe("Buenas tardes, soy el asistente virtual de Los Taquitos");
    // misma línea (mismo id): se reemplaza, no se duplica
    expect(ctl.estado.transcripcion.filter((l) => l.texto.startsWith("Buenas tardes"))).toHaveLength(1);
  });

  it("cada volumen solo sube en su modo (salida al hablar, entrada al escuchar) y fuera de él solo decae", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    let maxSalidaHablando = 0;
    let maxEntradaEscuchando = 0;
    let previoEntrada = 0;
    let previoSalida = 0;
    let subioFueraDeModo = false;
    for (let i = 0; i < 300; i++) {
      await avanzar(50);
      const { modo, volumenEntrada, volumenSalida } = ctl.estado;
      if (modo === "hablando") maxSalidaHablando = Math.max(maxSalidaHablando, volumenSalida);
      if (modo === "escuchando") maxEntradaEscuchando = Math.max(maxEntradaEscuchando, volumenEntrada);
      if (modo !== "hablando" && volumenSalida > previoSalida + 1e-9) subioFueraDeModo = true;
      if (modo !== "escuchando" && volumenEntrada > previoEntrada + 1e-9) subioFueraDeModo = true;
      previoEntrada = volumenEntrada;
      previoSalida = volumenSalida;
    }
    expect(maxSalidaHablando).toBeGreaterThan(0.2);
    expect(maxEntradaEscuchando).toBeGreaterThan(0.2);
    expect(maxSalidaHablando).toBeLessThanOrEqual(1);
    expect(subioFueraDeModo).toBe(false);
  });

  it("silenciado, el volumen de entrada se queda en 0 aunque el agente esté escuchando; al activar el micrófono vuelve a moverse", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    act(() => ctl.silenciar(true));
    expect(ctl.silenciado).toBe(true);
    let escuchoMudo = 0;
    for (let i = 0; i < 100 && escuchoMudo < 8; i++) {
      await avanzar(50);
      expect(ctl.estado.volumenEntrada).toBe(0);
      if (ctl.estado.modo === "escuchando") escuchoMudo += 1;
    }
    expect(escuchoMudo).toBe(8); // llegó a escuchar y nunca hubo nivel de micrófono
    act(() => ctl.silenciar(false));
    expect(ctl.silenciado).toBe(false);
    await avanzar(300);
    expect(ctl.estado.modo).toBe("escuchando");
    expect(ctl.estado.volumenEntrada).toBeGreaterThan(0.1);
  });

  it("terminar vuelve a reposo con volumen 0, conserva la transcripción y deja de emitir", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    await avanzar(3_000);
    const lineasAntes = ctl.estado.transcripcion.length;
    expect(lineasAntes).toBeGreaterThan(0);
    await act(async () => {
      await ctl.terminar();
    });
    expect(ctl.estado.modo).toBe("reposo");
    expect(ctl.estado.volumenEntrada).toBe(0);
    expect(ctl.estado.volumenSalida).toBe(0);
    expect(ctl.estado.transcripcion).toHaveLength(lineasAntes);
    expect(vi.getTimerCount()).toBe(0);
    await avanzar(10_000);
    expect(ctl.estado.modo).toBe("reposo");
    expect(ctl.estado.transcripcion).toHaveLength(lineasAntes);
  });

  it("una llamada nueva limpia la transcripción anterior", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    await avanzar(3_000);
    await act(async () => {
      await ctl.terminar();
    });
    expect(ctl.estado.transcripcion.length).toBeGreaterThan(0);
    await iniciar();
    expect(ctl.estado.transcripcion).toHaveLength(0);
    expect(ctl.estado.modo).toBe("conectando");
  });

  it("iniciar dos veces seguidas no crea dos sesiones", async () => {
    const fabrica = vi.fn(crearFabricaDemo());
    montar(fabrica);
    await iniciar();
    await iniciar();
    expect(fabrica).toHaveBeenCalledTimes(1);
  });

  it("al desmontarse cuelga la llamada y no quedan temporizadores vivos", async () => {
    montar(crearFabricaDemo());
    await iniciar();
    await avanzar(1_000);
    rendered!.unmount();
    rendered = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useSesionVoz con un adaptador que falla", () => {
  it("si iniciar() revienta, el modo pasa a error recuperable con el mensaje, y se puede reintentar", async () => {
    let intento = 0;
    const fabrica: FabricaAdaptador = (): AdaptadorVoz => ({
      async iniciar() {
        intento += 1;
        if (intento === 1) throw new Error("No se pudo acceder al micrófono.");
      },
      async terminar() {},
      silenciar() {},
    });
    montar(fabrica);
    await iniciar();
    expect(ctl.estado.modo).toBe("error");
    expect(ctl.estado.error).toMatchObject({ mensaje: "No se pudo acceder al micrófono.", recuperable: true });
    await iniciar();
    expect(intento).toBe(2);
    expect(ctl.estado.error).toBeUndefined();
    expect(ctl.estado.modo).toBe("conectando");
  });

  it("si la fábrica lanza, el error no es recuperable", async () => {
    montar(() => {
      throw new Error("Sin configuración.");
    });
    await iniciar();
    expect(ctl.estado.modo).toBe("error");
    expect(ctl.estado.error).toMatchObject({ mensaje: "Sin configuración.", recuperable: false });
  });

  it("terminado() del adaptador cierra la sesión y callbacks tardíos de una sesión vieja se ignoran", async () => {
    let cb!: CallbacksAdaptador;
    const fabrica: FabricaAdaptador = (c) => {
      cb = c;
      return { async iniciar() {}, async terminar() {}, silenciar() {} };
    };
    montar(fabrica);
    await iniciar();
    const viejo = cb;
    act(() => viejo.cambiar({ modo: "escuchando", volumenEntrada: 0.5 }));
    expect(ctl.estado.modo).toBe("escuchando");
    act(() => viejo.terminado());
    expect(ctl.estado.modo).toBe("reposo");
    act(() => viejo.cambiar({ modo: "hablando" })); // ya terminó: se ignora
    expect(ctl.estado.modo).toBe("reposo");
    act(() => viejo.linea({ id: "x", rol: "agente", texto: "tarde", parcial: false, ts: 0 }));
    expect(ctl.estado.transcripcion).toHaveLength(0);
  });
});
