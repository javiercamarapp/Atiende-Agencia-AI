// Tecleo: generador de clics y orquestador dirigido por el reloj de muestras, con herramientas FALSAS (sin reloj real, sin red).
import { describe, expect, it } from "vitest";
import { OrquestadorTecleo, TECLEO_VOLUMEN_MAX, TECLEO_VOLUMEN_POR_DEFECTO, crearClic, esVolumenTecleo } from "../src/index.ts";
import { crearAzar } from "../src/azar-determinista.ts";
import { pico, rms } from "../src/analisis-audio.ts";

const HZ = 24_000;
const ms = (m: number): number => Math.round((m / 1000) * HZ);
const hayAudio = (x: Float64Array): boolean => x.some((v) => Math.abs(v) > 1e-6);
/** Avanza `m` ms y devuelve lo generado. */
const avanzar = (o: OrquestadorTecleo, m: number): Float64Array => o.siguiente(ms(m));
const crear = (extra: Partial<ConstructorParameters<typeof OrquestadorTecleo>[0]> = {}) => new OrquestadorTecleo({ volumen: 12, semilla: 5, ...extra });

describe("clic de tecla", () => {
  it("es determinista por la semilla y de pico 1 (normalizado)", () => {
    const a = crearClic("tecla", crearAzar(3), HZ);
    const b = crearClic("tecla", crearAzar(3), HZ);
    const c = crearClic("tecla", crearAzar(4), HZ);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(pico(a)).toBeCloseTo(1, 6);
  });

  it("dura pocos ms (una tecla, no un golpe largo) y la barra y el enter son mas largos", () => {
    expect(crearClic("tecla", crearAzar(1), HZ).length).toBeLessThanOrEqual(ms(80));
    expect(crearClic("barra", crearAzar(1), HZ).length).toBeGreaterThan(crearClic("tecla", crearAzar(1), HZ).length);
  });
});

describe("OrquestadorTecleo", () => {
  it("sin herramienta en vuelo NO suena nunca", () => {
    const o = crear();
    expect(hayAudio(avanzar(o, 3000))).toBe(false);
    expect(o.sonando).toBe(false);
    expect(o.teclas).toBe(0);
  });

  it("empieza a sonar al iniciar la herramienta y NO antes", () => {
    const o = crear();
    avanzar(o, 500);
    o.herramientaInicia("t1");
    expect(o.herramientasEnVuelo).toBe(1);
    const x = avanzar(o, 400);
    expect(hayAudio(x)).toBe(true);
    expect(o.teclas).toBeGreaterThan(1);
  });

  it("una herramienta rapida (100 ms) da UNA rafaga de al menos la minima (500 ms) y luego calla", () => {
    const o = crear();
    o.herramientaInicia("t1");
    avanzar(o, 100);
    o.herramientaTermina("t1", true);
    const hasta700 = avanzar(o, 600);
    expect(hayAudio(hasta700.subarray(ms(300), ms(450)))).toBe(true); // sigue tecleando pasados los 100 ms reales
    const cola = avanzar(o, 1500);
    expect(hayAudio(cola.subarray(ms(700)))).toBe(false); // y callo del todo (el pip cae justo al terminar)
  });

  it("la rafaga es proporcional a la espera: una herramienta de 6 s teclea en varias rafagas con pausas, ninguna de mas de ~2.6 s", () => {
    const o = crear({ topeEpisodioMs: 20_000 });
    o.herramientaInicia("t1");
    const x = avanzar(o, 6000);
    // Hueco de silencio >= 300 ms entre rafagas
    let maxSilencio = 0;
    let racha = 0;
    let maxSonido = 0;
    let rachaSonido = 0;
    const paso = ms(20);
    for (let i = 0; i + paso <= x.length; i += paso) {
      const sonido = hayAudio(x.subarray(i, i + paso));
      if (sonido) {
        racha = 0;
        rachaSonido += paso;
      } else {
        racha += paso;
        maxSilencio = Math.max(maxSilencio, racha);
        // el hueco entre teclas (hasta ~450 ms de duda) no corta una rafaga: solo cuenta el silencio largo
        if (racha > ms(500)) {
          maxSonido = Math.max(maxSonido, rachaSonido);
          rachaSonido = 0;
        }
      }
    }
    maxSonido = Math.max(maxSonido, rachaSonido);
    expect(maxSilencio).toBeGreaterThanOrEqual(ms(300));
    expect(maxSonido).toBeLessThanOrEqual(ms(2800));
    expect(o.gastadoMs).toBeLessThanOrEqual(6000);
  });

  it("tope por espera: una herramienta eterna no teclea mas de topeEpisodioMs", () => {
    const o = crear({ topeEpisodioMs: 3000 });
    o.herramientaInicia("t1");
    avanzar(o, 3500);
    expect(hayAudio(avanzar(o, 1000).subarray(ms(500)))).toBe(false); // ya callo (fade + colas)
    avanzar(o, 10_000);
    expect(o.gastadoMs).toBeLessThanOrEqual(3100);
  });

  it("tope por llamada: la suma de todas las esperas no pasa de topeLlamadaMs", () => {
    const o = crear({ topeLlamadaMs: 2000, topeEpisodioMs: 8000 });
    for (let i = 0; i < 5; i++) {
      o.herramientaInicia(`t${i}`);
      avanzar(o, 1500);
      o.herramientaTermina(`t${i}`, true);
      avanzar(o, 800);
    }
    expect(o.gastadoMs).toBeLessThanOrEqual(2100);
    // una herramienta nueva ya no suena
    o.herramientaInicia("ultima");
    avanzar(o, 300);
    expect(hayAudio(avanzar(o, 1500))).toBe(false);
  });

  it("barge-in: una tecla sonando se apaga en ~25 ms (reloj de muestras), no vuelve aunque la herramienta siga y la siguiente herramienta si suena", () => {
    const o = crear();
    o.herramientaInicia("t1");
    // Avanza de 10 en 10 ms hasta que acaba de dispararse una tecla (su sonido dura ~75 ms): el cliente habla JUSTO ahi.
    for (let guardia = 0; guardia < 400; guardia++) {
      const antes = o.teclas;
      avanzar(o, 10);
      if (o.teclas > antes && o.teclas >= 3) break;
    }
    o.clienteHabla();
    const corte = avanzar(o, 25);
    const despues = avanzar(o, 500);
    // dentro de los 25 ms del corte todavia se oye la tecla apagandose; pasados ~30 ms es silencio EXACTO (sin `cortado` la cola de la tecla duraria hasta ~75 ms)
    expect(hayAudio(corte)).toBe(true);
    expect(hayAudio(despues.subarray(ms(5)))).toBe(false);
    expect(o.sonando).toBe(false);
    expect(o.herramientasEnVuelo).toBe(1); // la herramienta sigue en vuelo y aun asi no vuelve a sonar
    o.herramientaTermina("t1", true);
    o.herramientaInicia("t2");
    expect(hayAudio(avanzar(o, 500))).toBe(true);
  });

  it("mientras el agente habla el tecleo se calla, y vuelve si la herramienta sigue en vuelo", () => {
    const o = crear({ topeEpisodioMs: 20_000 });
    o.herramientaInicia("t1");
    avanzar(o, 300);
    o.fijarAgenteHablando(true);
    avanzar(o, 150);
    expect(hayAudio(avanzar(o, 1000))).toBe(false);
    o.fijarAgenteHablando(false);
    let volvio = false;
    for (let i = 0; i < 12 && !volvio; i++) volvio = hayAudio(avanzar(o, 500));
    expect(volvio).toBe(true);
  });

  it("varias herramientas en paralelo comparten UNA rafaga: solo calla cuando termina la ultima", () => {
    const o = crear({ topeEpisodioMs: 20_000 });
    o.herramientaInicia("a");
    o.herramientaInicia("b");
    avanzar(o, 200);
    o.herramientaTermina("a", true);
    expect(o.herramientasEnVuelo).toBe(1);
    expect(o.sonando).toBe(true);
    o.herramientaTermina("b", true);
    expect(o.herramientasEnVuelo).toBe(0);
  });

  it("terminar una herramienta que no existe no hace nada", () => {
    const o = crear();
    o.herramientaTermina("fantasma", true);
    expect(hayAudio(avanzar(o, 500))).toBe(false);
  });

  it("el pico nunca pasa del volumen pedido y la salida es finita", () => {
    for (const v of [1, 12, TECLEO_VOLUMEN_MAX]) {
      const o = crear({ volumen: v, topeEpisodioMs: 20_000 });
      o.herramientaInicia("t");
      const x = avanzar(o, 5000);
      expect(pico(x)).toBeLessThan(v / 100 + 1e-9);
      expect(x.every((s) => Number.isFinite(s))).toBe(true);
      expect(rms(x)).toBeGreaterThan(0);
    }
  });

  it("es determinista por la semilla", () => {
    const g = (semilla: number): number[] => {
      const o = crear({ semilla });
      o.herramientaInicia("t");
      return Array.from(avanzar(o, 1500));
    };
    expect(g(9)).toEqual(g(9));
    expect(g(9)).not.toEqual(g(10));
  });

  it("volumen 0 = apagado: silencio y la herramienta no cambia nada", () => {
    const o = crear({ volumen: 0 });
    o.herramientaInicia("t");
    expect(o.herramientasEnVuelo).toBe(0);
    expect(hayAudio(avanzar(o, 1000))).toBe(false);
    expect(o.activo).toBe(false);
  });

  it("el pip de POS se agrega al terminar BIEN y no al terminar mal ni con pip apagado", () => {
    const salida = (ok: boolean, pip: boolean): number[] => {
      const o = crear({ pip, semilla: 2 });
      o.herramientaInicia("t");
      avanzar(o, 100);
      o.herramientaTermina("t", ok);
      return Array.from(avanzar(o, 2000));
    };
    const conPip = salida(true, true);
    expect(conPip).not.toEqual(salida(true, false));
    expect(salida(false, true)).toEqual(salida(false, false));
  });

  it("volumen por omision dentro del rango y contratos de entrada", () => {
    expect(esVolumenTecleo(TECLEO_VOLUMEN_POR_DEFECTO)).toBe(true);
    expect(esVolumenTecleo(0)).toBe(true);
    expect(esVolumenTecleo(TECLEO_VOLUMEN_MAX + 1)).toBe(false);
    for (const malo of ["", null, false, [], {}, 1.5, -1, Number.NaN, "5", undefined]) {
      expect(esVolumenTecleo(malo)).toBe(false);
      expect(() => new OrquestadorTecleo({ volumen: malo as number })).toThrow(RangeError);
    }
  });
});
