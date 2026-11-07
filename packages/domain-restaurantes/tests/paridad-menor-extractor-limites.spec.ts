// F4c P1-C (revision de seguridad): el extractor real NO se puede activar sin limites de paginas/pixeles/bytes descomprimidos/tiempo y sin aislamiento;
// ademas se rechazan imagenes con dimensiones enormes o ilegibles y el escaner ve /ObjStm, /AA y /Encrypt.
import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_LIMITES_MAX,
  EscanerHeuristico,
  ExtractorTextoFalso,
  ExtractorTextoNoConfigurado,
  InMemoryArchivosConocimientoRepository,
  InMemoryRestaurantesRepository,
  dimensionesDeImagen,
  extractorEsSeguro,
  procesarCargaArchivo,
  validarArchivoEntrante,
} from "../src/index.ts";
import type { ExtractorTexto } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const enc = (s: string) => new TextEncoder().encode(s);
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w = 100, h = 100) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...enc("IHDR"), ...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
const jpg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 0]);
const webpX = (w: number, h: number) => Uint8Array.from([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);
const pdf = (s = "x") => enc(`%PDF-1.4\n${s}\n%%EOF`);

describe("dimensiones de imagen", () => {
  it("lee PNG, JPEG y WebP (VP8X) sin decodificar", () => {
    expect(dimensionesDeImagen(png(640, 480), "image/png")).toEqual({ ancho: 640, alto: 480 });
    expect(dimensionesDeImagen(jpg(800, 600), "image/jpeg")).toEqual({ ancho: 800, alto: 600 });
    expect(dimensionesDeImagen(webpX(1024, 768), "image/webp")).toEqual({ ancho: 1024, alto: 768 });
    expect(dimensionesDeImagen(enc("basura"), "image/png")).toBeNull();
  });
  it("una bomba de pixeles (60000x60000 en pocos bytes) o una imagen ilegible se RECHAZAN antes de llegar al extractor", () => {
    expect(validarArchivoEntrante({ nombre: "a.png", mimeDeclarado: "image/png", bytes: png(60000, 60000) })).toMatchObject({ ok: false, motivo: "dimensiones" });
    expect(validarArchivoEntrante({ nombre: "a.jpg", mimeDeclarado: "image/jpeg", bytes: jpg(30000, 30000) })).toMatchObject({ ok: false, motivo: "dimensiones" });
    expect(validarArchivoEntrante({ nombre: "a.webp", mimeDeclarado: "image/webp", bytes: webpX(20000, 20000) })).toMatchObject({ ok: false, motivo: "dimensiones" });
    expect(validarArchivoEntrante({ nombre: "a.png", mimeDeclarado: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) })).toMatchObject({ ok: false, motivo: "dimensiones" });
    expect(validarArchivoEntrante({ nombre: "a.png", mimeDeclarado: "image/png", bytes: png(2000, 1500) }).ok).toBe(true);
  });
});

describe("el extractor real exige limites y aislamiento", () => {
  it("topes documentados", () => {
    expect(EXTRACTOR_LIMITES_MAX).toMatchObject({ paginas: 20, pixeles: 25_000_000, bytesDescomprimidos: 50 * 1024 * 1024, milisegundos: 20_000 });
  });
  it("por omision no hay extractor (503); el falso de pruebas es seguro", () => {
    expect(new ExtractorTextoNoConfigurado().disponible).toBe(false);
    expect(extractorEsSeguro(new ExtractorTextoNoConfigurado())).toBe(false);
    expect(extractorEsSeguro(new ExtractorTextoFalso("x"))).toBe(true);
  });
  const casos: Array<[string, Partial<ExtractorTexto>]> = [
    ["sin aislamiento", { aislado: false }],
    ["sin limites", { limites: undefined }],
    ["pixeles por encima del tope", { limites: { ...EXTRACTOR_LIMITES_MAX, pixeles: EXTRACTOR_LIMITES_MAX.pixeles * 2 } }],
    ["paginas por encima del tope", { limites: { ...EXTRACTOR_LIMITES_MAX, paginas: 500 } }],
    ["sin tope de bytes descomprimidos", { limites: { ...EXTRACTOR_LIMITES_MAX, bytesDescomprimidos: 0 } }],
    ["sin tiempo maximo", { limites: { ...EXTRACTOR_LIMITES_MAX, milisegundos: 0 } }],
  ];
  it.each(casos)("un extractor 'disponible' %s NO se usa: la carga responde no_disponible y el extractor no se llama", async (_n, cambio) => {
    let llamadas = 0;
    const extractor = { disponible: true, aislado: true, limites: EXTRACTOR_LIMITES_MAX, ...cambio, extraer: async () => { llamadas += 1; return { ok: true as const, texto: "Aceptamos reservaciones para grupos grandes." }; } } as ExtractorTexto;
    expect(extractorEsSeguro(extractor)).toBe(false);
    const restaurantes = new InMemoryRestaurantesRepository();
    restaurantes.seedOrganization({ id: ORG, slug: "t", name: "T" });
    const r = await procesarCargaArchivo({ escaner: new EscanerHeuristico(), extractor, archivos: new InMemoryArchivosConocimientoRepository(), conocimiento: restaurantes, nombresCatalogo: [] }, { organizationId: ORG, actorId: "u1", nombre: "a.pdf", mimeDeclarado: "application/pdf", bytes: pdf() });
    expect(r.estado).toBe("no_disponible");
    expect(llamadas).toBe(0);
  });
});

describe("EscanerHeuristico: PDF opaco", () => {
  const esc = new EscanerHeuristico();
  it.each([["/ObjStm", "<< /Type /ObjStm /N 5 >>"], ["/AA", "<< /AA << /O 5 0 R >> >>"], ["/Encrypt", "<< /Encrypt 9 0 R >>"], ["ObjStm ofuscado", "<< /Obj#53tm 1 >>"]])("rechaza %s (no se puede inspeccionar lo comprimido o cifrado)", async (_n, cuerpo) => {
    expect((await esc.escanear(pdf(cuerpo), "application/pdf")).limpio).toBe(false);
  });
  it("un PDF simple sigue pasando", async () => {
    expect((await esc.escanear(pdf("1 0 obj << /Type /Catalog >> endobj"), "application/pdf")).limpio).toBe(true);
  });
});
