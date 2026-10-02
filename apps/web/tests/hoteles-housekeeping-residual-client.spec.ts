// H-26/H-29 -- clientes de housekeeping residual y mensajeria: URLs, metodos y cuerpos reales contra
// apps/api/.../hoteles/{housekeeping-residual,mensajeria-config}.ts.
import { describe, expect, it, vi } from "vitest";
import {
  archivoABase64,
  asignacionAutomatica,
  descargarFoto,
  fetchBlancos,
  fetchConfigHk,
  fetchFotos,
  fetchOptOuts,
  guardarBlancos,
  registrarOptOut,
  retirarFoto,
  revertirOptOut,
  saveConfigHk,
  subirFoto,
} from "../src/verticals/hoteles/lib/housekeeping-residual-client.ts";
import { cambiarVoz, fetchMensajeria, guardarWhatsApp, rotarSecretoVoz } from "../src/verticals/hoteles/lib/mensajeria-client.ts";

function recorder(body: unknown = { ok: true }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const B = "http://api.local";
const H = `${B}/hoteles/prop-1/housekeeping`;
const M = `${B}/hoteles/prop-1/mensajeria`;

describe("housekeeping residual", () => {
  it("lecturas y escrituras llaman a la ruta correcta", async () => {
    const r = recorder();
    await fetchConfigHk(r.impl, B, "t", "prop-1");
    await saveConfigHk(r.impl, B, "t", "prop-1", { asignacionAutomatica: true, minutosPorTipo: { salida: 50 } });
    await asignacionAutomatica(r.impl, B, "t", "prop-1", "2026-03-10");
    await fetchFotos(r.impl, B, "t", "prop-1", "t1");
    await subirFoto(r.impl, B, "t", "prop-1", "t1", "AAAA", "bano");
    await retirarFoto(r.impl, B, "t", "prop-1", "t1", "f1");
    await fetchBlancos(r.impl, B, "t", "prop-1", "2026-03-10");
    await guardarBlancos(r.impl, B, "t", "prop-1", { fecha: "2026-03-10", articulo: "sabanas", limpias: 5, sucias: 1, enLavanderia: 0, danadas: 0 });
    await fetchOptOuts(r.impl, B, "t", "prop-1", "2026-03-10");
    await registrarOptOut(r.impl, B, "t", "prop-1", { roomId: "r1", fecha: "2026-03-10", origen: "huesped" });
    await revertirOptOut(r.impl, B, "t", "prop-1", "o1");
    expect(r.calls.map((c) => [c.method, c.url.replace(H, "")])).toEqual([
      ["GET", "/configuracion"],
      ["PUT", "/configuracion"],
      ["POST", "/asignacion-automatica"],
      ["GET", "/tareas/t1/fotos"],
      ["POST", "/tareas/t1/fotos"],
      ["DELETE", "/tareas/t1/fotos/f1"],
      ["GET", "/blancos?fecha=2026-03-10"],
      ["PUT", "/blancos"],
      ["GET", "/opt-out?fecha=2026-03-10"],
      ["POST", "/opt-out"],
      ["POST", "/opt-out/o1/revertir"],
    ]);
    expect(r.calls[1]!.body).toEqual({ asignacionAutomatica: true, minutosPorTipo: { salida: 50 } });
    expect(r.calls[4]!.body).toEqual({ imagen: "AAAA", descripcion: "bano" });
  });

  it("descargarFoto devuelve el binario con el token", async () => {
    const impl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const blob = await descargarFoto(impl, B, "tok", "prop-1", "t1", "f1");
    expect(blob.size).toBe(3);
    expect((impl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].headers).toEqual({ authorization: "Bearer tok" });
  });

  it("archivoABase64 rechaza lo que pasa de 1.5 MB sin leerlo y codifica lo demas", async () => {
    await expect(archivoABase64(new Blob([new Uint8Array(1_572_865)]))).rejects.toThrow(/1.5 MB/);
    expect(await archivoABase64(new Blob([new Uint8Array([104, 105])]))).toBe(Buffer.from("hi").toString("base64"));
  });

  it("un error del servidor se propaga", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Sin permiso" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(saveConfigHk(impl, B, "t", "prop-1", { asignacionAutomatica: true })).rejects.toThrow();
  });
});

describe("mensajeria", () => {
  it("estado, canal, voz y rotacion llaman a la ruta correcta; la rotacion devuelve el secreto una vez", async () => {
    const r = recorder({ secreto: "abc", secretoConfigurado: true });
    await fetchMensajeria(r.impl, B, "t", "prop-1");
    await guardarWhatsApp(r.impl, B, "t", "prop-1", { phoneNumberId: "12345", habilitado: true });
    await cambiarVoz(r.impl, B, "t", "prop-1", true);
    const rot = await rotarSecretoVoz(r.impl, B, "t", "prop-1");
    expect(rot.secreto).toBe("abc");
    expect(r.calls.map((c) => [c.method, c.url.replace(M, "")])).toEqual([
      ["GET", ""],
      ["PUT", "/whatsapp"],
      ["PUT", "/voz"],
      ["POST", "/voz/rotar-secreto"],
    ]);
    expect(r.calls[1]!.body).toEqual({ phoneNumberId: "12345", habilitado: true });
  });
});
