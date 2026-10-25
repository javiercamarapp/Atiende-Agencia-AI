// ds3 / 0.3: fuentes autoalojadas (Hanken Grotesk 400/500/600 e IBM Plex Mono 400/500, OFL). Verifica que existan, su peso total,
// su licencia y origen, que cubran los glifos del sistema de diseno (leyendo la tabla cmap del woff2 real) y que todavia NO se usen
// (sin precarga, el @import de Google sigue en pie: eso es el flip).
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "../../..");
const FUENTES = join(RAIZ, "apps/web/public/fonts");
const CSS_FUENTES = join(RAIZ, "apps/web/src/fuentes-ds3.css");
const SANS = ["hankengrotesk-400.woff2", "hankengrotesk-500.woff2", "hankengrotesk-600.woff2"];
const MONO = ["ibmplexmono-400.woff2", "ibmplexmono-500.woff2"];

// Orden fijo de las etiquetas conocidas del directorio de tablas WOFF2 (especificacion W3C, tabla 1).
const ETIQUETAS = "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".split(" ").map((t) => t.replace("_", " "));

/** Conjunto de puntos de codigo de la tabla cmap (formatos 4 y 12) de un woff2. */
function codigosDeFuente(archivo: string): Set<number> {
  const b = readFileSync(join(FUENTES, archivo));
  expect(b.toString("latin1", 0, 4)).toBe("wOF2");
  const numTablas = b.readUInt16BE(12);
  const comprimido = b.readUInt32BE(20);
  let o = 48;
  const base128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const x = b[o++]!;
      v = v * 128 + (x & 0x7f);
      if (!(x & 0x80)) break;
    }
    return v;
  };
  const tablas: Array<{ tag: string; largo: number }> = [];
  for (let i = 0; i < numTablas; i++) {
    const flags = b[o++]!;
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) {
      tag = b.toString("latin1", o, o + 4);
      o += 4;
    } else tag = ETIQUETAS[idx]!;
    const original = base128();
    const version = flags >> 6;
    const transformada = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    tablas.push({ tag, largo: transformada ? base128() : original });
  }
  const datos = brotliDecompressSync(b.subarray(o, o + comprimido));
  let pos = 0;
  let cmap: Buffer | undefined;
  for (const t of tablas) {
    if (t.tag === "cmap") cmap = datos.subarray(pos, pos + t.largo);
    pos += t.largo;
  }
  expect(cmap, `${archivo} tiene cmap`).toBeDefined();
  const c = cmap!;
  const codigos = new Set<number>();
  const n = c.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const off = c.readUInt32BE(4 + i * 8 + 4);
    const formato = c.readUInt16BE(off);
    if (formato === 4) {
      const segs = c.readUInt16BE(off + 6) / 2;
      const fin = off + 14;
      const ini = fin + segs * 2 + 2;
      for (let s = 0; s < segs; s++) {
        const a = c.readUInt16BE(ini + s * 2);
        const z = c.readUInt16BE(fin + s * 2);
        if (a !== 0xffff) for (let k = a; k <= z; k++) codigos.add(k);
      }
    } else if (formato === 12) {
      const grupos = c.readUInt32BE(off + 12);
      for (let g = 0; g < grupos; g++) {
        const a = c.readUInt32BE(off + 16 + g * 12);
        const z = c.readUInt32BE(off + 20 + g * 12);
        for (let k = a; k <= z; k++) codigos.add(k);
      }
    }
  }
  return codigos;
}

// Glifos exigidos por el sistema de diseno (§2.2): vocales acentuadas, ñ, ü, signos de apertura, comillas angulares, rayas,
// puntos suspensivos, moneda/porcentaje y menos tipografico.
const OBLIGATORIOS = "áéíóúÁÉÍÓÚñÑüÜ¿¡«»—…$%−";
// El subconjunto latin de la fuente oficial no trae estos dos: caen a la fuente del sistema. Si cambia, el spec avisa.
const SIN_GLIFO_PROPIO = "≥₂";

describe("fuentes autoalojadas ds3", () => {
  it("existen los 5 woff2 y pesan 120 KB o menos en total", () => {
    let total = 0;
    for (const f of [...SANS, ...MONO]) {
      expect(existsSync(join(FUENTES, f)), f).toBe(true);
      total += statSync(join(FUENTES, f)).size;
    }
    expect(total).toBeLessThanOrEqual(120 * 1024);
  });

  it.each([...SANS, ...MONO])("%s cubre los glifos obligatorios", (f) => {
    const cm = codigosDeFuente(f);
    const faltan = [...OBLIGATORIOS].filter((ch) => !cm.has(ch.codePointAt(0)!));
    expect(faltan.join("")).toBe("");
    const sinPropio = [...SIN_GLIFO_PROPIO].filter((ch) => !cm.has(ch.codePointAt(0)!));
    expect(sinPropio.join("")).toBe(SIN_GLIFO_PROPIO);
  });

  it("incluye licencia OFL y origen documentado", () => {
    for (const l of ["OFL-HankenGrotesk.txt", "OFL-IBMPlexMono.txt"]) {
      expect(readFileSync(join(FUENTES, l), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
    const origen = readFileSync(join(FUENTES, "ORIGEN-ds3.txt"), "utf8");
    expect(origen).toContain("@fontsource/hanken-grotesk");
    expect(origen).toContain("@fontsource/ibm-plex-mono");
  });

  it("fuentes-ds3.css declara las 5 caras con font-display swap y cada url apunta a un archivo existente", () => {
    const css = readFileSync(CSS_FUENTES, "utf8");
    expect(readFileSync(join(RAIZ, "apps/web/src/index.css"), "utf8")).toContain('@import "./fuentes-ds3.css"');
    const urls = [...css.matchAll(/url\("\/fonts\/((?:hankengrotesk|ibmplexmono)-\d+\.woff2)"\)/g)].map((m) => m[1]!);
    expect(urls.sort()).toEqual([...SANS, ...MONO].sort());
    const caras = css.split("@font-face").slice(1).filter((c) => /hankengrotesk|ibmplexmono/.test(c));
    expect(caras).toHaveLength(5);
    for (const c of caras) expect(c).toContain("font-display: swap");
  });

  it("todavia no se usan: sin precarga en index.html y el @import de Google sigue (eso es el flip)", () => {
    const html = readFileSync(join(RAIZ, "apps/web/index.html"), "utf8");
    expect(html).not.toMatch(/rel="preload"[^>]*(hankengrotesk|ibmplexmono)/);
    const css = readFileSync(join(RAIZ, "packages/ui/src/index.css"), "utf8");
    expect(css.split("\n")[0]).toContain("fonts.googleapis.com");
  });
});
