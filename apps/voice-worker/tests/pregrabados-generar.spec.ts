// Generador de los 15 pregrabados: sin llave no genera nada, respeta el tope de gasto ANTES de pedir el primer audio, no pisa lo que ya existe y no
// deja archivos a medias. Con `fetch` falso (no se probo contra la API real).
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_PREGRABADOS } from "@atiende/domain-restaurantes";
import { MENSAJE_IDS } from "@atiende/voice-core";
import { escribirWav, leerWav, muestrasABytes } from "../src/audio/pcm.ts";
import { PregrabadosError, generarPregrabados } from "../src/pregrabados-generar.ts";
import { cargarPregrabados, verificarPregrabados } from "../src/pregrabados.ts";
import { tono } from "./support/audio.ts";

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});
async function carpeta(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "voz-gen-"));
  return dir;
}

const audio1s = (): Uint8Array => muestrasABytes(tono(24_000, 1000, 400));
const base = (d: string, extra: Record<string, unknown> = {}) => ({ apiKey: "llave-de-prueba", textos: MENSAJES_PREGRABADOS, dir: d, voz: "Kore", topeUsd: 1, ...extra });

describe("generarPregrabados", () => {
  it("sin llave falla con un mensaje claro y NO escribe ni un archivo ni hace una peticion", async () => {
    const d = await carpeta();
    const f = vi.fn();
    await expect(generarPregrabados({ ...base(d), apiKey: null, fetchFn: f as unknown as typeof fetch })).rejects.toThrow(/Falta OPENROUTER_API_KEY/);
    await expect(generarPregrabados({ ...base(d), apiKey: "  ", fetchFn: f as unknown as typeof fetch })).rejects.toBeInstanceOf(PregrabadosError);
    expect(f).not.toHaveBeenCalled();
    expect(await readdir(d)).toEqual([]);
  });

  it("genera los 15 WAV (PCM16 mono, 24 kHz) con la forma de peticion de la cascada y sin filtrar la llave al resultado", async () => {
    const d = await carpeta();
    const peticiones: Array<{ url: string; cuerpo: Record<string, unknown>; auth: string | null }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      peticiones.push({ url, cuerpo: JSON.parse(String(init.body)) as Record<string, unknown>, auth: new Headers(init.headers).get("authorization") });
      return new Response(audio1s(), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await generarPregrabados({ ...base(d), fetchFn });
    expect(r.generados).toHaveLength(15);
    expect(r.fallidos).toEqual([]);
    expect(peticiones).toHaveLength(15);
    expect(peticiones[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/audio/speech", auth: "Bearer llave-de-prueba" });
    expect(peticiones[0]?.cuerpo).toMatchObject({ model: "google/gemini-3.8-flash-tts", voice: "Kore", response_format: "pcm" });
    // Cada peticion lleva el TEXTO de su mensaje, uno por id.
    expect(new Set(peticiones.map((p) => p.cuerpo.input))).toEqual(new Set(MENSAJE_IDS.map((id) => MENSAJES_PREGRABADOS[id])));
    expect(JSON.stringify(r)).not.toContain("llave-de-prueba");
    // Y el worker los carga completos.
    const cargados = await cargarPregrabados(d);
    expect(cargados.faltantes).toEqual([]);
    expect(leerWav(new Uint8Array(await readFile(join(d, "handoff.wav")))).hz).toBe(24_000);
    expect(r.costoEstimadoMicroUsd).toBeGreaterThan(0);
  });

  it("el tope se aplica ANTES del primer audio: si el estimado lo pasa, no se pide nada", async () => {
    const d = await carpeta();
    const f = vi.fn();
    await expect(generarPregrabados({ ...base(d, { topeUsd: 0.001 }), fetchFn: f as unknown as typeof fetch })).rejects.toThrow(/pasa el tope/);
    expect(f).not.toHaveBeenCalled();
    expect(await readdir(d)).toEqual([]);
  });

  it("un tope invalido (0, negativo o no numerico) se rechaza", async () => {
    const d = await carpeta();
    for (const topeUsd of [0, -1, Number.NaN]) await expect(generarPregrabados({ ...base(d, { topeUsd }), fetchFn: vi.fn() as unknown as typeof fetch })).rejects.toBeInstanceOf(PregrabadosError);
  });

  it("se genera UNA sola vez: lo que ya existe se omite (y no se gasta), salvo --forzar", async () => {
    const d = await carpeta();
    await writeFile(join(d, "handoff.wav"), new Uint8Array([1, 2, 3]));
    const f = vi.fn(async () => new Response(audio1s(), { status: 200 }));
    const r = await generarPregrabados({ ...base(d), fetchFn: f as unknown as typeof fetch });
    expect(r.omitidos).toEqual(["handoff"]);
    expect(f).toHaveBeenCalledTimes(14);
    expect(Array.from(new Uint8Array(await readFile(join(d, "handoff.wav"))))).toEqual([1, 2, 3]);
    const f2 = vi.fn(async () => new Response(audio1s(), { status: 200 }));
    const forzada = await generarPregrabados({ ...base(d, { forzar: true }), fetchFn: f2 as unknown as typeof fetch });
    expect(forzada.generados).toHaveLength(15);
    expect(f2).toHaveBeenCalledTimes(15);
  });

  it("una respuesta con error HTTP o un audio demasiado corto es un fallo reportado (no un archivo) y no detiene a los demas", async () => {
    const d = await carpeta();
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 2) return new Response("{}", { status: 402 });
      if (n === 3) return new Response(new Uint8Array(100), { status: 200 });
      return new Response(audio1s(), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await generarPregrabados({ ...base(d), fetchFn });
    expect(r.fallidos.map((f) => f.motivo)).toEqual(["http_402", "audio_demasiado_corto"]);
    expect(r.generados).toHaveLength(13);
    const archivos = await readdir(d);
    expect(archivos.filter((a) => a.endsWith(".tmp"))).toEqual([]);
    expect(archivos).toHaveLength(13);
  });

  it("un fallo de red se reporta con un codigo corto: nunca el mensaje del error (puede traer la URL o cabeceras)", async () => {
    const d = await carpeta();
    const fetchFn = (async () => {
      throw new Error("fallo con Authorization: Bearer llave-de-prueba");
    }) as unknown as typeof fetch;
    const r = await generarPregrabados({ ...base(d), fetchFn });
    expect(r.generados).toEqual([]);
    expect(new Set(r.fallidos.map((f) => f.motivo))).toEqual(new Set(["red"]));
    expect(JSON.stringify(r)).not.toContain("llave-de-prueba");
  });
});

describe("verificarPregrabados (npm run voz:pregrabados -- --verificar)", () => {
  it("una carpeta vacia: los 15 faltan y no es valida", async () => {
    const d = await carpeta();
    const v = await verificarPregrabados(d);
    expect(v.ok).toBe(false);
    expect(v.reportes).toHaveLength(MENSAJE_IDS.length);
    expect(v.reportes.every((r) => r.problema === "falta el archivo")).toBe(true);
  });

  it("con los 15 WAV de 1 s a 24 kHz mono es valida y reporta frecuencia y duracion", async () => {
    const d = await carpeta();
    for (const id of MENSAJE_IDS) await writeFile(join(d, `${id}.wav`), escribirWav(tono(24_000, 1000, 400), 24_000));
    const v = await verificarPregrabados(d);
    expect(v.ok).toBe(true);
    expect(v.reportes[0]).toMatchObject({ ok: true, hz: 24_000, duracionS: 1, problema: null });
  });

  it("detecta un WAV ilegible, uno demasiado corto, uno de frecuencia no soportada y uno estereo", async () => {
    const d = await carpeta();
    for (const id of MENSAJE_IDS) await writeFile(join(d, `${id}.wav`), escribirWav(tono(24_000, 1000, 400), 24_000));
    await writeFile(join(d, "handoff.wav"), "esto no es un wav");
    await writeFile(join(d, "despedida.wav"), escribirWav(tono(24_000, 100, 400), 24_000));
    await writeFile(join(d, "tool_timeout.wav"), escribirWav(tono(44_100, 1000, 400), 44_100));
    const estereo = Buffer.from(escribirWav(tono(24_000, 1000, 400), 24_000));
    estereo.writeUInt16LE(2, 22);
    await writeFile(join(d, "pedir_repetir.wav"), estereo);
    const v = await verificarPregrabados(d);
    const por = Object.fromEntries(v.reportes.map((r) => [r.id, r.problema]));
    expect(v.ok).toBe(false);
    expect(por.handoff).toBe("no es un WAV PCM16 mono valido");
    expect(por.despedida).toContain("demasiado corto");
    expect(por.tool_timeout).toContain("44100 Hz no soportada");
    expect(por.pedir_repetir).toBe("no es un WAV PCM16 mono valido");
    expect(v.reportes.filter((r) => r.ok)).toHaveLength(MENSAJE_IDS.length - 4);
  });
});
