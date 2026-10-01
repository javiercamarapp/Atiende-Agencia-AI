// D-08: cliente del portal del cliente final -- el token SOLO viaja por header (nunca URL/consola),
// el fragmento se lee con forma estricta y los textos usan terminologia SAT.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  avanceCierre,
  enviarMensajePortal,
  estadoCierre,
  estadoDocumento,
  estadoEnlace,
  estadoObligacion,
  fetchPortalResumen,
  nombreMes,
  PortalClienteError,
  subirDocumentoPortal,
  tokenDeFragmento,
  validarArchivoLocal,
} from "../src/verticals/despachos/lib/portal-cliente-client.ts";

const TOKEN = "A".repeat(43);

afterEach(() => vi.restoreAllMocks());

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("tokenDeFragmento", () => {
  it("lee solo la forma exacta #t=<43 caracteres base64url>", () => {
    expect(tokenDeFragmento(`#t=${TOKEN}`)).toBe(TOKEN);
    for (const malo of ["", "#", "#t=", `#t=${"A".repeat(42)}`, `#t=${TOKEN}x`, `t=${TOKEN}`, `#x=${TOKEN}`, `#t=${TOKEN}&y=1`, `#t=${"A".repeat(42)}!`]) {
      expect(tokenDeFragmento(malo)).toBeNull();
    }
  });
});

describe("llamadas publicas", () => {
  it("el token va SOLO en el header X-Portal-Token; la URL no lo contiene; sin cache ni referrer", async () => {
    const fetchMock = vi.fn(async () => respuesta(200, { cliente: { nombre: "X" }, despacho: { nombre: "D" }, expiraEn: "2026-12-01T00:00:00Z", obligaciones: [], cierres: [], documentos: [], mensajes: [] }));
    await fetchPortalResumen(fetchMock as unknown as typeof fetch, "https://api.test", TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/portal-cliente/resumen");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["x-portal-token"]).toBe(TOKEN);
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.cache).toBe("no-store");
  });

  it("subir: manda los bytes crudos con su content-type y el nombre codificado (sin multipart)", async () => {
    const fetchMock = vi.fn(async () => respuesta(201, { id: "d1", estado: "recibido", duplicado: false, nombreArchivo: "factura julio.xml" }));
    const bytes = new TextEncoder().encode("<x/>").buffer;
    const r = await subirDocumentoPortal(fetchMock as unknown as typeof fetch, "https://api.test", TOKEN, { name: "factura julio.xml", type: "application/xml", size: 4, arrayBuffer: async () => bytes });
    expect(r.estado).toBe("recibido");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/portal-cliente/documentos");
    expect(init.body).toBe(bytes);
    const h = init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/xml");
    expect(h["x-nombre-archivo"]).toBe("factura%20julio.xml");
  });

  it("errores del servidor se convierten en PortalClienteError con codigo y estado; no se loguea nada", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => respuesta(404, { code: "enlace_no_valido", message: "Este enlace no es válido." }));
    await expect(fetchPortalResumen(fetchMock as unknown as typeof fetch, "https://api.test", TOKEN)).rejects.toMatchObject({ codigo: "enlace_no_valido", status: 404 });
    await expect(enviarMensajePortal(fetchMock as unknown as typeof fetch, "https://api.test", TOKEN, "hola")).rejects.toBeInstanceOf(PortalClienteError);
    expect(consola).not.toHaveBeenCalled();
  });
});

describe("validarArchivoLocal", () => {
  it("acepta XML/PDF/PNG/JPEG coherentes y rechaza vacio, grande, ejecutables y extension cruzada", () => {
    expect(validarArchivoLocal({ name: "a.xml", type: "text/xml", size: 10 })).toBeNull();
    expect(validarArchivoLocal({ name: "a.PDF", type: "application/pdf", size: 10 })).toBeNull();
    expect(validarArchivoLocal({ name: "a.jpeg", type: "image/jpeg", size: 10 })).toBeNull();
    expect(validarArchivoLocal({ name: "a.pdf", type: "application/pdf", size: 0 })).toMatch(/vacío/);
    expect(validarArchivoLocal({ name: "a.pdf", type: "application/pdf", size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(validarArchivoLocal({ name: "a.exe", type: "application/x-msdownload", size: 10 })).toMatch(/Solo se aceptan/);
    expect(validarArchivoLocal({ name: "a.exe", type: "application/pdf", size: 10 })).toMatch(/Solo se aceptan/);
    expect(validarArchivoLocal({ name: "sin-extension", type: "application/pdf", size: 10 })).toMatch(/Solo se aceptan/);
  });
});

describe("textos y tonos (terminologia SAT)", () => {
  it("obligaciones, cierres, documentos y enlaces", () => {
    expect(estadoObligacion("completado")).toEqual({ etiqueta: "Presentada", tono: "success" });
    expect(estadoObligacion("vencido").tono).toBe("danger");
    expect(estadoObligacion("desconocido")).toEqual({ etiqueta: "desconocido", tono: "neutral" });
    expect(estadoCierre("closed").etiqueta).toBe("Cerrado");
    expect(estadoDocumento("rechazado").tono).toBe("danger");
    expect(nombreMes(6, 2026)).toBe("junio de 2026");
    expect(avanceCierre({ tareasTotal: 5, tareasListas: 2 })).toBe(40);
    expect(avanceCierre({ tareasTotal: 0, tareasListas: 0 })).toBe(0);
    const ahora = new Date("2026-08-01T00:00:00Z");
    expect(estadoEnlace({ revocadoEn: "2026-07-01T00:00:00Z", expiraEn: "2026-12-01T00:00:00Z" }, ahora).etiqueta).toBe("Revocado");
    expect(estadoEnlace({ revocadoEn: null, expiraEn: "2026-07-01T00:00:00Z" }, ahora).etiqueta).toBe("Expirado");
    expect(estadoEnlace({ revocadoEn: null, expiraEn: "2026-12-01T00:00:00Z" }, ahora).etiqueta).toBe("Vigente");
  });
});
