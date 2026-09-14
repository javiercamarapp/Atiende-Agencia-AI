// Cierre de gap de auditoría "Motor de contabilidad electrónica SAT
// (catálogo/balanza/pólizas, XML Anexo 24)" — pruebas de
// `src/contabilidad-electronica/`. Puerto de
// `b2b_ai/services/catalogo_cuentas.py` + `b2b_ai/services/balanza.py` +
// `b2b_ai/services/contabilidad_electronica.py`. El caso de la balanza con
// dos cuentas (1101 Bancos / 4100 Ingresos por servicios) reproduce EXACTAMENTE
// el ejemplo de `b2b_ai/templates/balanza_comprobacion.xml` (RFC
// "DESP820101AB1", período 2026-01, Debe/Haber 1000.00 en ambas cuentas).
import { describe, expect, it } from "vitest";
import {
  CATALOGO_ANEXO24_BASE,
  crearCatalogoBase,
  findCuenta,
  erroresCatalogo,
  validarCatalogo,
  mergeCuentas,
  asignarAutomatico,
  generarXmlCatalogo,
} from "../src/contabilidad-electronica/catalogo-cuentas.ts";
import { acumularAsientos, generarBalanza, validarCuadratura, detectarSaldosAnomalos, generarXmlBalanza } from "../src/contabilidad-electronica/balanza.ts";
import {
  calcularHashSha1,
  generarPaqueteContabilidadElectronica,
  generarResumenMensual,
  marcarListoParaTimbrar,
  marcarTimbrado,
  marcarEnviado,
} from "../src/contabilidad-electronica/paquete.ts";
import { TransicionPaqueteContabilidadInvalidaError } from "../src/errors.ts";
import type { AsientoContable, CuentaAnexo24 } from "../src/contabilidad-electronica/types.ts";

const FECHA_MOD = "2026-01-31T23:59:59";

// ---------------------------------------------------------------------------
// Catálogo de cuentas
// ---------------------------------------------------------------------------

describe("catálogo de cuentas Anexo 24", () => {
  it("trae el catálogo base por defecto con 31 cuentas, mismos códigos que el origen", () => {
    expect(CATALOGO_ANEXO24_BASE.length).toBe(31);
    expect(findCuenta(CATALOGO_ANEXO24_BASE, "1101")).toEqual({ codigo: "1101", descripcion: "BANCOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO" });
    expect(findCuenta(CATALOGO_ANEXO24_BASE, "4100")).toEqual({ codigo: "4100", descripcion: "INGRESOS POR SERVICIOS", nivel: 2, naturaleza: "A", grupo: "INGRESOS" });
    expect(findCuenta(CATALOGO_ANEXO24_BASE, "9999")).toBeNull();
  });

  it("erroresCatalogo detecta código duplicado, descripción faltante, nivel < 1 y naturaleza inválida", () => {
    const malo: CuentaAnexo24[] = [
      { codigo: "1000", descripcion: "A", nivel: 1, naturaleza: "D", grupo: "" },
      { codigo: "1000", descripcion: "B", nivel: 1, naturaleza: "D", grupo: "" }, // duplicado
      { codigo: "1001", descripcion: "", nivel: 1, naturaleza: "D", grupo: "" }, // sin descripción
      { codigo: "1002", descripcion: "C", nivel: 0, naturaleza: "D", grupo: "" }, // nivel < 1
      { codigo: "1003", descripcion: "D", nivel: 1, naturaleza: "X" as never, grupo: "" }, // naturaleza inválida
    ];
    const errs = erroresCatalogo(malo);
    expect(errs).toContain("Código duplicado: 1000");
    expect(errs).toContain("Cuenta 1001 sin descripción.");
    expect(errs).toContain("Cuenta 1002 con nivel < 1.");
    expect(errs.some((e) => e.includes('Cuenta 1003 con naturaleza inválida'))).toBe(true);
  });

  it("validarCatalogo lanza con el catálogo por defecto válido y no lanza", () => {
    expect(() => validarCatalogo(CATALOGO_ANEXO24_BASE)).not.toThrow();
  });

  it("validarCatalogo lanza Error con el detalle cuando el catálogo es inválido", () => {
    const malo: CuentaAnexo24[] = [{ codigo: "", descripcion: "x", nivel: 1, naturaleza: "D", grupo: "" }];
    expect(() => validarCatalogo(malo)).toThrow(/Catálogo inválido: Cuenta sin código\./);
  });

  it("mergeCuentas (REQ-MIG-017) actualiza cuentas existentes in-place y agrega nuevas, sin borrar ninguna", () => {
    const base = crearCatalogoBase();
    const nuevas: CuentaAnexo24[] = [
      { codigo: "1101", descripcion: "BANCOS ACTUALIZADO", nivel: 3, naturaleza: "D", grupo: "ACTIVO" }, // actualiza
      { codigo: "9000", descripcion: "CUENTA NUEVA DEL CLIENTE", nivel: 1, naturaleza: "A", grupo: "CUSTOM" }, // agrega
    ];
    const fusionado = mergeCuentas(base, nuevas);

    // Ninguna cuenta preexistente se elimina.
    expect(fusionado.length).toBe(base.length + 1);
    expect(findCuenta(fusionado, "1101")?.descripcion).toBe("BANCOS ACTUALIZADO");
    expect(findCuenta(fusionado, "9000")?.descripcion).toBe("CUENTA NUEVA DEL CLIENTE");
    // El resto del catálogo sigue intacto.
    expect(findCuenta(fusionado, "1000")?.descripcion).toBe("ACTIVO");
    // La cuenta actualizada mantiene su posición original (in-place, no pop+append).
    const idxOriginal = base.findIndex((c) => c.codigo === "1101");
    expect(fusionado[idxOriginal]!.codigo).toBe("1101");

    // El catálogo base pasado por parámetro no se muta.
    expect(findCuenta(base, "1101")?.descripcion).toBe("BANCOS");
  });

  it("asignarAutomatico usa la cuenta pedida si existe en el catálogo, y el mapeo por defecto si no", () => {
    const asign = asignarAutomatico(CATALOGO_ANEXO24_BASE, {
      gasto_operativo: null, // sin cuenta -> default
      nomina: "9999", // cuenta inexistente -> default
      ingreso: "4200", // cuenta existente -> se respeta
    });
    expect(asign).toEqual({ gasto_operativo: "6102", nomina: "6101", ingreso: "4200" });
  });

  it("generarXmlCatalogo produce el XML del catálogo conforme al XSD del SAT (namespace, atributos Cta)", () => {
    const xml = generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: "DESP820101AB1", ejercicio: 2026, mes: 1, fechaModificacion: FECHA_MOD });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:Cat="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas"');
    expect(xml).toContain('Version="1.3" RFC="DESP820101AB1" Anio="2026" Mes="01"');
    expect(xml).toContain(`FechaModificacion="${FECHA_MOD}"`);
    expect(xml).toContain('<Cat:Cta NumCta="1101" Desc="BANCOS" Nivel="3" Natur="D"/>');
    expect(xml).toContain('<Cat:Cta NumCta="4100" Desc="INGRESOS POR SERVICIOS" Nivel="2" Natur="A"/>');
  });

  it("generarXmlCatalogo lanza si el catálogo es inválido (valida antes de generar)", () => {
    const malo: CuentaAnexo24[] = [{ codigo: "1000", descripcion: "", nivel: 1, naturaleza: "D", grupo: "" }];
    expect(() => generarXmlCatalogo(malo, { ejercicio: 2026, mes: 1, fechaModificacion: FECHA_MOD })).toThrow(/Catálogo inválido/);
  });

  it("generarXmlCatalogo escapa atributos con caracteres especiales XML", () => {
    const conAmpersand: CuentaAnexo24[] = [{ codigo: "1000", descripcion: 'Gastos "raros" & <especiales>', nivel: 1, naturaleza: "D", grupo: "" }];
    const xml = generarXmlCatalogo(conAmpersand, { ejercicio: 2026, mes: 1, fechaModificacion: FECHA_MOD });
    expect(xml).toContain("Gastos &quot;raros&quot; &amp; &lt;especiales&gt;");
  });
});

// ---------------------------------------------------------------------------
// Balanza de comprobación
// ---------------------------------------------------------------------------

describe("balanza de comprobación", () => {
  const asientosEjemploTemplate: AsientoContable[] = [
    { cuenta: "1101", debe: 1000, haber: 0 },
    { cuenta: "4100", debe: 0, haber: 1000 },
  ];

  it("reproduce EXACTAMENTE el ejemplo de b2b_ai/templates/balanza_comprobacion.xml", () => {
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, asientosEjemploTemplate, "2026-01");
    expect(resumen.cuentas).toBe(2);
    expect(resumen.cuadrada).toBe(true);
    expect(resumen.totalDebe).toBe("1000.00");
    expect(resumen.totalHaber).toBe("1000.00");
    expect(resumen.lineas).toEqual([
      { cuenta: "1101", descripcion: "BANCOS", nivel: 3, naturaleza: "D", saldoInicial: "0.00", debe: "1000.00", haber: "0.00", saldoFinal: "1000.00" },
      { cuenta: "4100", descripcion: "INGRESOS POR SERVICIOS", nivel: 2, naturaleza: "A", saldoInicial: "0.00", debe: "0.00", haber: "1000.00", saldoFinal: "1000.00" },
    ]);

    const xml = generarXmlBalanza(resumen.lineas, { rfc: "DESP820101AB1", ejercicio: 2026, mes: 1, fechaModificacion: FECHA_MOD });
    expect(xml).toContain('xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion"');
    expect(xml).toContain('Version="1.3" TipoEnvio="B" RFC="DESP820101AB1" Mes="01" Anio="2026"');
    expect(xml).toContain('<BCE:Cta NumCta="1101" SaldoIni="0.00" Debe="1000.00" Haber="0.00" SaldoFin="1000.00"/>');
    expect(xml).toContain('<BCE:Cta NumCta="4100" SaldoIni="0.00" Debe="0.00" Haber="1000.00" SaldoFin="1000.00"/>');
  });

  it("acumularAsientos suma debe/haber por cuenta e ignora asientos sin cuenta", () => {
    const acc = acumularAsientos([
      { cuenta: "1101", debe: 100, haber: 0 },
      { cuenta: "1101", debe: 50, haber: 10 },
      { cuenta: "", debe: 999, haber: 0 },
    ]);
    expect(acc.get("1101")).toEqual({ debe: 150, haber: 10 });
    expect(acc.has("")).toBe(false);
  });

  it("filtra asientos por período usando los primeros 7 caracteres de la fecha, y nunca excluye asientos sin fecha", () => {
    const asientos: AsientoContable[] = [
      { cuenta: "1101", debe: 100, haber: 0, fecha: "2026-01-15" },
      { cuenta: "1101", debe: 200, haber: 0, fecha: "2026-02-01" }, // fuera de período
      { cuenta: "1101", debe: 50, haber: 0 }, // sin fecha -> nunca se excluye
    ];
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, asientos, "2026-01");
    expect(resumen.lineas[0]!.debe).toBe("150.00"); // 100 + 50, el de febrero queda fuera
  });

  it("una cuenta acreedora (naturaleza A) calcula saldoFinal = saldoInicial + haber - debe", () => {
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "2101", debe: 200, haber: 500 }], null, { "2101": 100 });
    // 2101 PROVEEDORES es naturaleza A: 100 + 500 - 200 = 400
    expect(resumen.lineas[0]!.saldoFinal).toBe("400.00");
  });

  it("una cuenta no catalogada usa naturaleza D y descripción 'Cuenta {codigo}' por heurística", () => {
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "7777", debe: 300, haber: 0 }], null);
    expect(resumen.lineas[0]).toMatchObject({ descripcion: "Cuenta 7777", naturaleza: "D", nivel: 3 });
  });

  it("validarCuadratura es false cuando debe != haber", () => {
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "1101", debe: 100, haber: 0 }], null);
    expect(validarCuadratura(resumen.lineas)).toBe(false);
  });

  it("detectarSaldosAnomalos marca una cuenta deudora con saldo final negativo", () => {
    // 1101 BANCOS es deudora (D): saldoFinal = 0 + 0 - 500 = -500 (haber > debe sin saldo inicial).
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "1101", debe: 0, haber: 500 }], null);
    const anomalas = detectarSaldosAnomalos(resumen.lineas);
    expect(anomalas).toHaveLength(1);
    expect(anomalas[0]!.cuenta).toBe("1101");
    expect(anomalas[0]!.razon).toBe("saldo deudor negativo");
    expect(resumen.saldosAnomalos).toEqual(["1101"]);
  });

  it("detectarSaldosAnomalos marca una cuenta acreedora con saldo final negativo", () => {
    // 2101 PROVEEDORES es acreedora (A): saldoFinal = 0 + 0 - 300 = -300 (debe > haber sin saldo inicial).
    const resumen = generarBalanza(CATALOGO_ANEXO24_BASE, [{ cuenta: "2101", debe: 300, haber: 0 }], null);
    expect(detectarSaldosAnomalos(resumen.lineas).map((l) => l.razon)).toEqual(["saldo acreedor negativo"]);
  });
});

// ---------------------------------------------------------------------------
// Paquete de contabilidad electrónica (orquestador + estado)
// ---------------------------------------------------------------------------

describe("paquete de contabilidad electrónica", () => {
  const asientos: AsientoContable[] = [
    { cuenta: "1101", debe: 1000, haber: 0 },
    { cuenta: "4100", debe: 0, haber: 1000 },
  ];

  function generar() {
    return generarPaqueteContabilidadElectronica({
      catalogo: CATALOGO_ANEXO24_BASE,
      rfc: "DESP820101AB1",
      razonSocial: "Despacho de Prueba SA de CV",
      ejercicio: 2026,
      mes: 1,
      asientos,
      generadoEn: "2026-02-01T09:00:00",
      fechaModificacionXml: FECHA_MOD,
    });
  }

  it("genera el paquete completo: período, XML de catálogo y balanza, hash SHA-1 de cada uno, estado inicial listo_para_timbrar", () => {
    const paquete = generar();
    expect(paquete.periodo).toBe("2026-01");
    expect(paquete.estado).toBe("listo_para_timbrar");
    expect(paquete.catalogo.cuentas).toBe(CATALOGO_ANEXO24_BASE.length);
    expect(paquete.balanza.cuentas).toBe(2);
    expect(paquete.balanza.cuadrada).toBe(true);
    expect(paquete.resumenBalanza.totalDebe).toBe("1000.00");

    // Hash SHA-1 verificable independientemente — mismo algoritmo que
    // `ContabilidadElectronica.calcular_hash_sha1` (hex de 40 caracteres).
    expect(paquete.catalogo.sha1).toBe(calcularHashSha1(paquete.catalogo.xml));
    expect(paquete.balanza.sha1).toBe(calcularHashSha1(paquete.balanza.xml));
    expect(paquete.catalogo.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it("calcularHashSha1 es determinista y sensible a cualquier cambio de contenido", () => {
    const h1 = calcularHashSha1("hola mundo");
    const h2 = calcularHashSha1("hola mundo");
    const h3 = calcularHashSha1("hola mundo!");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{40}$/);
  });

  it("generarResumenMensual arma el resumen a partir del paquete generado", () => {
    const paquete = generar();
    const resumen = generarResumenMensual(paquete);
    expect(resumen).toEqual({
      periodo: "2026-01",
      rfc: "DESP820101AB1",
      razonSocial: "Despacho de Prueba SA de CV",
      cuentas: 2,
      totalDebe: "1000.00",
      totalHaber: "1000.00",
      cuadrada: true,
      saldosAnomalos: [],
      estado: "listo_para_timbrar",
    });
  });

  it("generarResumenMensual acepta un estadoActual distinto al del paquete (paquete ya avanzó de estado)", () => {
    const paquete = generar();
    const resumen = generarResumenMensual(paquete, "timbrado");
    expect(resumen.estado).toBe("timbrado");
  });

  it("mes default es 1 cuando no se especifica, igual que el origen", () => {
    const paquete = generarPaqueteContabilidadElectronica({
      catalogo: CATALOGO_ANEXO24_BASE,
      ejercicio: 2026,
      asientos: [],
      generadoEn: "2026-02-01T09:00:00",
      fechaModificacionXml: FECHA_MOD,
    });
    expect(paquete.mes).toBe(1);
    expect(paquete.periodo).toBe("2026-01");
  });

  describe("ciclo de estados: borrador -> listo_para_timbrar -> timbrado -> enviado", () => {
    it("avanza en el orden correcto y cada transición es idempotente en el mismo estado", () => {
      expect(marcarListoParaTimbrar("borrador")).toBe("listo_para_timbrar");
      expect(marcarListoParaTimbrar("listo_para_timbrar")).toBe("listo_para_timbrar"); // idempotente
      expect(marcarTimbrado("listo_para_timbrar")).toBe("timbrado");
      expect(marcarTimbrado("timbrado")).toBe("timbrado"); // idempotente
      expect(marcarEnviado("timbrado")).toBe("enviado");
      expect(marcarEnviado("enviado")).toBe("enviado"); // idempotente
    });

    it("marcarTimbrado lanza si el paquete sigue en borrador (no se puede saltar listo_para_timbrar)", () => {
      expect(() => marcarTimbrado("borrador")).toThrow(TransicionPaqueteContabilidadInvalidaError);
      expect(() => marcarTimbrado("borrador")).toThrow(/No se puede timbrar desde el estado "borrador"/);
    });

    it("marcarEnviado lanza si el paquete no está timbrado", () => {
      expect(() => marcarEnviado("listo_para_timbrar")).toThrow(TransicionPaqueteContabilidadInvalidaError);
      expect(() => marcarEnviado("borrador")).toThrow(TransicionPaqueteContabilidadInvalidaError);
    });

    it("marcarListoParaTimbrar lanza si el paquete ya está timbrado o enviado (corrección de fidelidad documentada)", () => {
      expect(() => marcarListoParaTimbrar("timbrado")).toThrow(TransicionPaqueteContabilidadInvalidaError);
      expect(() => marcarListoParaTimbrar("enviado")).toThrow(TransicionPaqueteContabilidadInvalidaError);
    });
  });
});
