// D-28: adaptador HTTP de la lista 69-B con CSV fixture, archivo gigante rechazado y decodificacion latin1 (SIN llamadas al SAT).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { Efos69bDescargaError, HttpEfos69bSource, runEfos69bIngestion } from "../src/index.ts";

const RUTA_CSV = fileURLToPath(new URL("../../../packages/domain-despachos/tests/fixtures/efos-69b-muestra.csv", import.meta.url));
const CSV = readFileSync(RUTA_CSV, "utf8");

function fuenteCon(respuesta: () => Response, opciones: { maxBytes?: number; timeoutMs?: number; url?: string } = {}) {
  const llamadas: string[] = [];
  const fetchImpl = (async (url: URL | string) => {
    llamadas.push(String(url));
    return respuesta();
  }) as unknown as typeof fetch;
  return { fuente: new HttpEfos69bSource({ fetchImpl, ...opciones }), llamadas };
}

describe("HttpEfos69bSource", () => {
  it("baja el CSV, lo decodifica y la ingesta por runEfos69bIngestion es idempotente por SHA-256 y periodo", async () => {
    const { fuente, llamadas } = fuenteCon(() => new Response(CSV, { status: 200 }), { url: "https://sat.example/listado.csv" });
    const repo = new InMemoryDespachosRepository();
    const withRepo = <T>(fn: (r: InMemoryDespachosRepository) => Promise<T>) => fn(repo);
    const a = await runEfos69bIngestion(withRepo, fuente, "2026-07");
    expect(a).toMatchObject({ periodo: "2026-07", resultado: "insertada", filas: 4 });
    expect((await runEfos69bIngestion(withRepo, fuente, "2026-07")).resultado).toBe("sin_cambios");
    expect(llamadas).toEqual(["https://sat.example/listado.csv", "https://sat.example/listado.csv"]);
  });

  it("decodifica Windows-1252 cuando el archivo no es UTF-8 valido (no pierde acentos)", async () => {
    const latin1 = new Uint8Array([...Buffer.from(CSV.replace("Situación", "Situación"), "latin1")]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(latin1)).toThrow();
    const { fuente } = fuenteCon(() => new Response(latin1, { status: 200 }));
    expect(await fuente.obtenerListado("2026-07")).toContain("Situación del contribuyente");
  });

  it("rechaza un archivo gigante por Content-Length sin leer el cuerpo", async () => {
    const { fuente } = fuenteCon(() => new Response("x", { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } }), { maxBytes: 1024 });
    await expect(fuente.obtenerListado("2026-07")).rejects.toMatchObject({ name: "Efos69bDescargaError", motivo: "demasiado_grande" });
  });

  it("rechaza un archivo gigante que MIENTE sobre su tamano: cancela el streaming al pasar el tope", async () => {
    let cancelado = false;
    let enviados = 0;
    const cuerpo = new ReadableStream<Uint8Array>({
      pull(controller) {
        enviados += 1;
        controller.enqueue(new Uint8Array(400));
        if (enviados > 1000) controller.close();
      },
      cancel() {
        cancelado = true;
      },
    });
    const { fuente } = fuenteCon(() => new Response(cuerpo, { status: 200 }), { maxBytes: 1000 });
    await expect(fuente.obtenerListado("2026-07")).rejects.toMatchObject({ motivo: "demasiado_grande" });
    expect(cancelado).toBe(true);
    expect(enviados).toBeLessThan(10);
  });

  it("HTTP no 2xx, cuerpo vacio y red caida se reportan con su motivo", async () => {
    await expect(fuenteCon(() => new Response("no", { status: 503 })).fuente.obtenerListado("2026-07")).rejects.toMatchObject({ motivo: "http" });
    await expect(fuenteCon(() => new Response("", { status: 200 })).fuente.obtenerListado("2026-07")).rejects.toMatchObject({ motivo: "vacio" });
    const caida = new HttpEfos69bSource({ fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(caida.obtenerListado("2026-07")).rejects.toMatchObject({ motivo: "red" });
  });

  it("timeout: el SAT no responde -> motivo timeout", async () => {
    const fetchImpl = ((_u: URL, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(new HttpEfos69bSource({ fetchImpl, timeoutMs: 20 }).obtenerListado("2026-07")).rejects.toMatchObject({ motivo: "timeout" });
  });

  it("una URL que no es http(s) se rechaza sin llamar a la red", async () => {
    const { fuente, llamadas } = fuenteCon(() => new Response(CSV), { url: "file:///etc/passwd" });
    await expect(fuente.obtenerListado("2026-07")).rejects.toBeInstanceOf(Efos69bDescargaError);
    expect(llamadas).toHaveLength(0);
  });

  it("sin URL configurada usa la oficial por defecto (marcada NO VERIFICADO en el codigo)", async () => {
    const { fuente, llamadas } = fuenteCon(() => new Response(CSV), { url: "  " });
    await fuente.obtenerListado("2026-07");
    expect(llamadas[0]).toMatch(/^https:\/\/omawww\.sat\.gob\.mx\//);
  });
});
