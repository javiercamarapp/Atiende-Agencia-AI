// D-P3-44: lectura del XML de catálogo y balanza del proveedor anterior (migración al libro). Incluye la defensa de la entrada: XML malicioso
// (DTD, entidades, XXE, expansión de entidades, hojas de estilo, codificación distinta de UTF-8, tamaño) se rechaza ANTES de parsear.
import { describe, expect, it } from "vitest";
import { CATALOGO_ANEXO24_BASE, generarXmlCatalogo } from "../src/contabilidad-electronica/catalogo-cuentas.ts";
import { generarBalanza, generarXmlBalanza } from "../src/contabilidad-electronica/balanza.ts";
import {
  ImportacionXmlContabilidadError,
  construirAperturaDesdeBalanza,
  fechaAperturaDe,
  importeACentavos,
  leerBalanzaXml,
  leerCatalogoXml,
} from "../src/contabilidad-electronica/importar-xml.ts";

const RFC = "DESP820101AB1";
const NS_CAT = "http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas";
const NS_BAL = "http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion";

function catalogoXml(ctas: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${extra}<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS_CAT}" Version="1.3" RFC="${RFC}" Mes="07" Anio="2026">\n${ctas}\n</catalogocuentas:Catalogo>\n`;
}
const cta = (a: Record<string, string>) => `  <catalogocuentas:Ctas ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;

describe("leerCatalogoXml", () => {
  it("lee el catálogo que genera este mismo motor (ida y vuelta) con jerarquía y códigos", () => {
    const xml = generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: RFC, ejercicio: 2026, mes: 7 });
    const r = leerCatalogoXml(xml);
    expect(r).toMatchObject({ rfc: RFC, ejercicio: 2026, mes: 7 });
    expect(r.rechazadas).toEqual([]);
    expect(r.cuentas).toHaveLength(CATALOGO_ANEXO24_BASE.length);
    expect(r.cuentas.find((c) => c.codigo === "1101")).toEqual({ codigo: "1101", descripcion: "BANCOS", naturaleza: "D", nivel: 3, cuentaPadre: "1100", codigoAgrupador: "102.01" });
    // El padre siempre va antes que sus subcuentas.
    const orden = new Map(r.cuentas.map((c, i) => [c.codigo, i] as const));
    for (const c of r.cuentas) if (c.cuentaPadre) expect(orden.get(c.cuentaPadre)!).toBeLessThan(orden.get(c.codigo)!);
  });

  it("reporta con su motivo lo que no puede importar y deja pasar el resto", () => {
    const xml = catalogoXml(
      [
        cta({ CodAgrup: "102", NumCta: "1020", Desc: "Bancos", Nivel: "1", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1-01-001", Desc: "Con guiones", Nivel: "1", Natur: "D" }),
        cta({ CodAgrup: "999.99", NumCta: "2010", Desc: "Proveedores", Nivel: "1", Natur: "A" }),
        cta({ CodAgrup: "105", NumCta: "1050", Desc: "", Nivel: "1", Natur: "D" }),
        cta({ CodAgrup: "105", NumCta: "1051", Desc: "Natur mala", Nivel: "1", Natur: "X" }),
        cta({ CodAgrup: "105", NumCta: "1052", Desc: "Nivel malo", Nivel: "0", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1021", Desc: "Hija sin padre declarado", Nivel: "2", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1022", Desc: "Hija de huérfana", Nivel: "3", SubCtaDe: "1021", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1023", Desc: "Hija de una rechazada", Nivel: "2", SubCtaDe: "1-01-001", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1024", Desc: "Nivel 1 con padre", Nivel: "1", SubCtaDe: "1020", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1025", Desc: "Salta nivel", Nivel: "3", SubCtaDe: "1020", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "1026", Desc: "Hija buena", Nivel: "2", SubCtaDe: "1020", Natur: "D" }),
        cta({ CodAgrup: "102.01", NumCta: "4026", Desc: "Otro rubro", Nivel: "2", SubCtaDe: "1020", Natur: "D" }),
      ].join("\n"),
    );
    const r = leerCatalogoXml(xml);
    expect(r.cuentas.map((c) => c.codigo)).toEqual(["1020", "2010", "1026"]);
    expect(r.cuentas.find((c) => c.codigo === "2010")?.codigoAgrupador).toBeNull(); // fuera de la lista del Anexo 24
    const motivos = new Map(r.rechazadas.map((x) => [x.numCta, x.motivo] as const));
    expect(motivos.get("1-01-001")).toMatch(/numérico de 4 a 10 dígitos/);
    expect(motivos.get("1050")).toMatch(/descripción/);
    expect(motivos.get("1051")).toMatch(/Naturaleza/);
    expect(motivos.get("1052")).toMatch(/Nivel/);
    expect(motivos.get("1021")).toMatch(/cuenta padre/);
    expect(motivos.get("1022")).toMatch(/padre/);
    expect(motivos.get("1023")).toMatch(/no está en el archivo/);
    expect(motivos.get("1024")).toMatch(/no lleva cuenta padre/);
    expect(motivos.get("1025")).toMatch(/nivel 2/);
    expect(motivos.get("4026")).toMatch(/mismo rubro/);
    expect(r.advertencias.join(" ")).toMatch(/no está en la lista del Anexo 24/);
  });

  it("una subcuenta puede colgar de una cuenta que el cliente YA tiene en el libro", () => {
    const xml = catalogoXml(cta({ CodAgrup: "102.01", NumCta: "1021", Desc: "Hija", Nivel: "2", SubCtaDe: "1020", Natur: "D" }));
    expect(leerCatalogoXml(xml, new Map([["1020", 1]])).cuentas).toHaveLength(1);
    expect(leerCatalogoXml(xml, new Map([["1020", 2]])).cuentas).toHaveLength(0);
    expect(leerCatalogoXml(xml).cuentas).toHaveLength(0);
  });

  it("una cuenta repetida se queda con la última aparición y lo avisa", () => {
    const xml = catalogoXml([cta({ CodAgrup: "102", NumCta: "1020", Desc: "Primera", Nivel: "1", Natur: "D" }), cta({ CodAgrup: "102", NumCta: "1020", Desc: "Última", Nivel: "1", Natur: "D" })].join("\n"));
    const r = leerCatalogoXml(xml);
    expect(r.cuentas).toHaveLength(1);
    expect(r.cuentas[0]!.descripcion).toBe("Última");
    expect(r.advertencias.join(" ")).toMatch(/repetida/);
  });

  it("acepta la versión 1.1 y rechaza versiones y raíces ajenas", () => {
    expect(leerCatalogoXml(catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "B", Nivel: "1", Natur: "D" })).replace('Version="1.3"', 'Version="1.1"')).cuentas).toHaveLength(1);
    expect(() => leerCatalogoXml(catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "B", Nivel: "1", Natur: "D" })).replace('Version="1.3"', 'Version="2.0"'))).toThrow(/Versión/);
    expect(() => leerCatalogoXml(`<?xml version="1.0" encoding="UTF-8"?><Otro RFC="${RFC}"/>`)).toThrow(/raíz Catalogo/);
    expect(() => leerCatalogoXml(catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "B", Nivel: "1", Natur: "D" })).replace(RFC, "no-rfc"))).toThrow(/RFC/);
    expect(() => leerCatalogoXml(catalogoXml(""))).toThrow(/no trae cuentas/);
  });

  describe("XML malicioso o fuera de límites se rechaza", () => {
    const bueno = catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "B", Nivel: "1", Natur: "D" }));
    it.each([
      ["DOCTYPE con entidad externa (XXE)", catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "&xxe;", Nivel: "1", Natur: "D" }), '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n'), /DTD ni entidades/],
      ["expansión de entidades (billion laughs)", catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "&lol2;", Nivel: "1", Natur: "D" }), '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>\n'), /DTD ni entidades/],
      ["DOCTYPE simple", `<!DOCTYPE x>\n${bueno}`, /DTD ni entidades/],
      ["hoja de estilo", `<?xml-stylesheet type="text/xsl" href="http://evil.example/x.xsl"?>\n${bueno}`.replace('<?xml-stylesheet', '<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet'), /hojas de estilo/],
      ["codificación distinta de UTF-8", bueno.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), /UTF-8/],
      ["bytes no UTF-8 (U+FFFD)", bueno.replace("B", "�"), /UTF-8/],
      ["carácter nulo", bueno.replace('Desc="B"', 'Desc="B\u0000"'), /no permitidos/],
      ["XML vacío", "   ", /vacío/],
      ["XML mal formado", "<catalogocuentas:Catalogo><a></catalogocuentas:Catalogo>", /mal formado/],
      ["más de 2 MB", bueno.replace("</catalogocuentas:Catalogo>", `<!-- ${"x".repeat(2 * 1024 * 1024 + 10)} --></catalogocuentas:Catalogo>`), /tamaño máximo/],
    ])("%s", (_n, xml, motivo) => {
      expect(() => leerCatalogoXml(xml)).toThrow(ImportacionXmlContabilidadError);
      expect(() => leerCatalogoXml(xml)).toThrow(motivo);
    });

    it("no es un texto", () => {
      expect(() => leerCatalogoXml(undefined as unknown as string)).toThrow(/vacío/);
      expect(() => leerCatalogoXml(42 as unknown as string)).toThrow(ImportacionXmlContabilidadError);
    });

    it("más de 5000 cuentas se rechaza", () => {
      const muchas = Array.from({ length: 5001 }, (_, i) => cta({ CodAgrup: "102", NumCta: String(1000 + i), Desc: "x", Nivel: "1", Natur: "D" })).join("\n");
      expect(() => leerCatalogoXml(catalogoXml(muchas))).toThrow(/más de 5000/);
    });

    it("un contenido con CDATA y comentarios sigue siendo texto inerte", () => {
      const xml = catalogoXml(`<!-- comentario -->\n${cta({ CodAgrup: "102", NumCta: "1020", Desc: "<![CDATA[Bancos & más]]>", Nivel: "1", Natur: "D" })}`);
      expect(() => leerCatalogoXml(xml)).not.toThrow();
    });
  });
});

describe("importeACentavos", () => {
  it.each([
    ["1234.56", 123456],
    ["-12.3", -1230],
    ["5", 500],
    ["0.00", 0],
    ["-0.01", -1],
    ["999999999999999.99", 99999999999999999],
  ])("%s -> %i", (entrada, esperado) => {
    expect(importeACentavos(entrada)).toBe(esperado === 99999999999999999 ? null : esperado);
  });
  it.each(["", "abc", "1.234", "1,234.50", "1e3", "--1", ".5", "1."])("rechaza %j", (v) => {
    expect(importeACentavos(v)).toBeNull();
  });
});

function balanzaXml(ctas: string, mes = "07", tipo = "N"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<BCE:Balanza xmlns:BCE="${NS_BAL}" Version="1.3" RFC="${RFC}" Mes="${mes}" Anio="2026" TipoEnvio="${tipo}">\n${ctas}\n</BCE:Balanza>\n`;
}
const bcta = (n: string, ini: string, debe = "0.00", haber = "0.00", fin = ini) => `  <BCE:Ctas NumCta="${n}" SaldoIni="${ini}" Debe="${debe}" Haber="${haber}" SaldoFin="${fin}"/>`;

describe("leerBalanzaXml y construirAperturaDesdeBalanza", () => {
  const naturalezas = new Map<string, "D" | "A">([["1020", "D"], ["1050", "D"], ["2010", "A"], ["3010", "A"], ["4080", "A"]]);

  it("lee la balanza que genera este mismo motor", () => {
    const lineas = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "1101", debe: 1000, haber: 0 }, { cuenta: "4100", debe: 0, haber: 1000 }], "2026-01", { "1101": "500.50" }).lineas;
    const xml = generarXmlBalanza(lineas, { rfc: RFC, ejercicio: 2026, mes: 1 });
    const b = leerBalanzaXml(xml);
    expect(b).toMatchObject({ rfc: RFC, ejercicio: 2026, mes: 1, tipoEnvio: "N" });
    expect(b.lineas[0]).toEqual({ numCta: "1101", saldoInicialCentavos: 50050, debeCentavos: 100000, haberCentavos: 0, saldoFinalCentavos: 150050 });
  });

  it("la apertura pone cada saldo del lado de su naturaleza y cuadra", () => {
    const b = leerBalanzaXml(balanzaXml([bcta("1020", "1000.00"), bcta("1050", "500.00"), bcta("2010", "300.00"), bcta("3010", "1200.00"), bcta("4080", "0.00")].join("\n")));
    const r = construirAperturaDesdeBalanza(b, naturalezas);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fecha).toBe("2026-06-30");
    expect(r.totalCentavos).toBe(150000);
    expect(r.partidas).toEqual([
      { cuenta: "1020", debeCentavos: 100000, haberCentavos: 0 },
      { cuenta: "1050", debeCentavos: 50000, haberCentavos: 0 },
      { cuenta: "2010", debeCentavos: 0, haberCentavos: 30000 },
      { cuenta: "3010", debeCentavos: 0, haberCentavos: 120000 },
    ]);
  });

  it("un saldo con signo contrario a la naturaleza se invierte de lado", () => {
    const b = leerBalanzaXml(balanzaXml([bcta("1020", "1000.00"), bcta("1050", "-200.00"), bcta("3010", "800.00")].join("\n")));
    const r = construirAperturaDesdeBalanza(b, naturalezas);
    expect(r.ok && r.partidas.find((p) => p.cuenta === "1050")).toMatchObject({ debeCentavos: 0, haberCentavos: 20000 });
    expect(r.ok && r.totalCentavos).toBe(100000);
  });

  it("la fecha de apertura es el último día del mes anterior (enero cae en diciembre del ejercicio previo)", () => {
    expect(fechaAperturaDe(2026, 1)).toBe("2025-12-31");
    expect(fechaAperturaDe(2026, 3)).toBe("2026-02-28");
    expect(fechaAperturaDe(2024, 3)).toBe("2024-02-29");
    expect(fechaAperturaDe(2026, 12)).toBe("2026-11-30");
  });

  it("se niega con cuentas que no están en el catálogo, balanza descuadrada, mes 13, sin saldos o demasiadas cuentas", () => {
    const sinCatalogo = construirAperturaDesdeBalanza(leerBalanzaXml(balanzaXml([bcta("1020", "10.00"), bcta("9999", "10.00")].join("\n"))), naturalezas);
    expect(sinCatalogo).toMatchObject({ ok: false, cuentasFaltantes: ["9999"] });
    expect(construirAperturaDesdeBalanza(leerBalanzaXml(balanzaXml([bcta("1020", "10.00"), bcta("2010", "9.99")].join("\n"))), naturalezas)).toMatchObject({ ok: false, motivo: expect.stringMatching(/no cuadra/) });
    expect(construirAperturaDesdeBalanza(leerBalanzaXml(balanzaXml([bcta("1020", "10.00"), bcta("2010", "10.00")].join("\n"), "13")), naturalezas)).toMatchObject({ ok: false, motivo: expect.stringMatching(/mes 13/) });
    expect(construirAperturaDesdeBalanza(leerBalanzaXml(balanzaXml([bcta("1020", "0.00"), bcta("2010", "0.00")].join("\n"))), naturalezas)).toMatchObject({ ok: false, motivo: expect.stringMatching(/no trae saldos iniciales/) });
    const grandes = new Map<string, "D" | "A">();
    const lineas: string[] = [];
    for (let i = 0; i < 202; i += 1) {
      const cuenta = String(1000 + i);
      grandes.set(cuenta, i % 2 === 0 ? "D" : "A");
      lineas.push(bcta(cuenta, "1.00"));
    }
    expect(construirAperturaDesdeBalanza(leerBalanzaXml(balanzaXml(lineas.join("\n"))), grandes)).toMatchObject({ ok: false, motivo: expect.stringMatching(/hasta 200/) });
  });

  it("rechaza importes mal formados, TipoEnvio inválido y raíces ajenas", () => {
    expect(() => leerBalanzaXml(balanzaXml(bcta("1020", "1.234")))).toThrow(/importe/);
    expect(() => leerBalanzaXml(balanzaXml(bcta("1020", "1.00"), "07", "B"))).toThrow(/TipoEnvio/);
    expect(() => leerBalanzaXml(catalogoXml(cta({ CodAgrup: "102", NumCta: "1020", Desc: "B", Nivel: "1", Natur: "D" })))).toThrow(/raíz Balanza/);
    expect(() => leerBalanzaXml(balanzaXml(""))).toThrow(/no trae cuentas/);
    expect(() => leerBalanzaXml(`<!DOCTYPE x [<!ENTITY a "b">]>\n${balanzaXml(bcta("1020", "1.00"))}`)).toThrow(/DTD ni entidades/);
  });
});
