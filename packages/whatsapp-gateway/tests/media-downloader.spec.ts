import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaGraphMediaDownloader, WhatsAppMediaError, oggOpusDurationSeconds } from "../src/media.ts";
import { WhatsAppConfigError } from "../src/errors.ts";
import { MetaCloudSimulator } from "../src/testing/index.ts";

const TOKEN = "sim-access-token";

/** Ogg minimo: una pagina "OggS" de 27 bytes con la posicion de granulo dada (Opus cuenta a 48 kHz). */
function fakeOgg(seconds: number, padding = 100): Uint8Array {
  const page = new Uint8Array(27 + padding);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  new DataView(page.buffer).setBigUint64(6, BigInt(Math.round(seconds * 48_000)), true);
  return page;
}

describe("oggOpusDurationSeconds", () => {
  it("lee la duracion de la ultima pagina Ogg", () => {
    expect(oggOpusDurationSeconds(fakeOgg(12.5))).toBeCloseTo(12.5, 3);
  });
  it("devuelve null si no es Ogg o es demasiado corto", () => {
    expect(oggOpusDurationSeconds(new Uint8Array(10))).toBeNull();
    expect(oggOpusDurationSeconds(new Uint8Array(200))).toBeNull();
  });
});

describe("MetaGraphMediaDownloader contra el simulador de Meta", () => {
  let sim: MetaCloudSimulator;
  let downloader: MetaGraphMediaDownloader;
  beforeEach(async () => {
    sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: "1234567890" });
    await sim.start();
    downloader = new MetaGraphMediaDownloader({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
  });

  it("descarga en dos pasos (metadatos y bytes) con Bearer y devuelve mime normalizado, tamano y duracion", async () => {
    const bytes = fakeOgg(7);
    const id = sim.registerMedia({ bytes, mimeType: "audio/ogg; codecs=opus" });
    const media = await downloader.download(id);
    expect(media.mimeType).toBe("audio/ogg");
    expect(media.sizeBytes).toBe(bytes.byteLength);
    expect(media.durationSeconds).toBeCloseTo(7, 3);
    expect(Array.from(media.bytes)).toEqual(Array.from(bytes));
    expect(sim.mediaRequests.map((r) => r.step)).toEqual(["metadata", "bytes"]);
  });

  it("token invalido -> unauthorized (no reintentable)", async () => {
    const id = sim.registerMedia({ bytes: fakeOgg(2), mimeType: "audio/ogg" });
    const bad = new MetaGraphMediaDownloader({ accessToken: "otro", baseUrl: sim.baseUrl });
    await expect(bad.download(id)).rejects.toMatchObject({ code: "unauthorized", retryable: false });
  });

  it("media inexistente -> not_found", async () => {
    await expect(downloader.download("NOEXISTE")).rejects.toMatchObject({ code: "not_found", retryable: false });
  });

  it("tipo no permitido (imagen) -> unsupported_type y NO descarga los bytes", async () => {
    const id = sim.registerMedia({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" });
    await expect(downloader.download(id)).rejects.toMatchObject({ code: "unsupported_type" });
    expect(sim.mediaRequests.some((r) => r.step === "bytes")).toBe(false);
  });

  it("file_size declarado por encima del tope -> too_large sin descargar los bytes", async () => {
    const id = sim.registerMedia({ bytes: new Uint8Array(2000).fill(1), mimeType: "audio/mpeg" });
    await expect(downloader.download(id, { maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
    expect(sim.mediaRequests.some((r) => r.step === "bytes")).toBe(false);
  });

  it("duracion por encima del tope -> too_long", async () => {
    const id = sim.registerMedia({ bytes: fakeOgg(90), mimeType: "audio/ogg" });
    await expect(downloader.download(id, { maxDurationSeconds: 60 })).rejects.toMatchObject({ code: "too_long" });
  });

  it("mp3 sin duracion legible se acepta (durationSeconds null)", async () => {
    const id = sim.registerMedia({ bytes: new Uint8Array(500).fill(7), mimeType: "audio/mpeg" });
    const media = await downloader.download(id);
    expect(media.durationSeconds).toBeNull();
  });

  it("rechaza ids de media con caracteres de ruta", async () => {
    await expect(downloader.download("../x")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("MetaGraphMediaDownloader con fetch falso", () => {
  const meta = (url: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ url, mime_type: "audio/ogg", file_size: 10, id: "M1", ...extra }), { status: 200 });

  it("exige token (fail-closed)", () => {
    expect(() => new MetaGraphMediaDownloader({ accessToken: " " })).toThrow(WhatsAppConfigError);
  });

  it("no manda el token a un host que no es de Meta (blocked_host) y no llama la segunda URL", async () => {
    const fetchImpl = vi.fn(async () => meta("https://evil.example.com/steal"));
    const d = new MetaGraphMediaDownloader({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(d.download("M1")).rejects.toMatchObject({ code: "blocked_host" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("acepta URL de lookaside.fbsbx.com y manda Bearer en las dos llamadas", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return calls.length === 1 ? meta("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1&sig=SECRETA") : new Response(fakeOgg(1), { status: 200 });
    });
    const d = new MetaGraphMediaDownloader({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await d.download("M1");
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("corta la lectura por flujo al pasar el tope aunque no haya content-length ni file_size", async () => {
    const fetchImpl = vi.fn(async (_url: string) => (fetchImpl.mock.calls.length === 1 ? meta("https://lookaside.fbsbx.com/x", { file_size: undefined }) : new Response(new Uint8Array(5000), { status: 200 })));
    const d = new MetaGraphMediaDownloader({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(d.download("M1", { maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("5xx y fallo de red son reintentables; el mensaje del error nunca trae la URL firmada ni el id", async () => {
    const urlFirmada = "https://lookaside.fbsbx.com/x?sig=SECRETA123";
    const d500 = new MetaGraphMediaDownloader({ accessToken: TOKEN, fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    await expect(d500.download("M1")).rejects.toMatchObject({ code: "network", retryable: true });
    const dNet = new MetaGraphMediaDownloader({
      accessToken: TOKEN,
      fetchImpl: (async () => {
        throw new Error(`ECONNRESET ${urlFirmada}`);
      }) as unknown as typeof fetch,
    });
    const err = await dNet.download("M1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppMediaError);
    expect((err as WhatsAppMediaError).retryable).toBe(true);
    expect(String((err as Error).message)).not.toContain("SECRETA");
    expect(String((err as Error).message)).not.toContain("M1");
  });

  it("timeout -> timeout reintentable", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("abort")));
      })) as unknown as typeof fetch;
    const d = new MetaGraphMediaDownloader({ accessToken: TOKEN, fetchImpl, timeoutMs: 20 });
    await expect(d.download("M1")).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});
