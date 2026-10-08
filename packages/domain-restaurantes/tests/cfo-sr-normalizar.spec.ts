// CFO-04 · normalizador de exportaciones de SoftRestaurant (alias INFERIDOS hasta tener un export real).
import { describe, expect, it } from "vitest";
import {
  ALIAS_SR_INFERIDOS, aFilasSrResumen, aFilasSrTicket, derivarResumenDeCuentas, diaDeNegocio, esColumnaPersonal, normalizarEncabezado, normalizarExportSr, normalizarFormaPago,
  normalizarTipoServicio, parsearCsvSr, parsearFechaSr, parsearMontoCentavos, renglonesSqlCuentas, renglonesSqlResumen,
} from "../src/cfo/sr-normalizar.ts";
import { consolidar } from "../src/cfo/consolidar.ts";
import { CSV_SR_SINTETICO, ETIQUETA_SINTETICO, filasXlsxSrSintetico, RESUMEN_SR_SINTETICO_ESPERADO, SUCURSALES_PM_SINTETICAS, TICKETS_SR_ESPERADOS } from "./fixtures/cfo-pm-sintetico.ts";

const T2 = SUCURSALES_PM_SINTETICAS[1]!;

describe("los alias están marcados como INFERIDOS", () => {
  it("la constante exportada lo declara", () => {
    expect(ALIAS_SR_INFERIDOS.inferidos).toBe(true);
    expect(ALIAS_SR_INFERIDOS.aviso).toContain("inferidos");
    expect(ALIAS_SR_INFERIDOS.aviso).toContain("export real");
  });
  it("cubre los alias pedidos: folio/cuenta/ticket, fechas, servicio, total/importe, subtotal, descuento, propina, forma de pago, cancelada/estatus, impuesto/IVA", () => {
    const c = ALIAS_SR_INFERIDOS.cuentas;
    expect(c.folio).toEqual(expect.arrayContaining(["folio", "cuenta", "ticket"]));
    expect(c.fecha).toEqual(expect.arrayContaining(["fecha", "fecha apertura", "fecha cierre"]));
    expect(c.servicio).toEqual(expect.arrayContaining(["servicio", "tipo de servicio"]));
    expect(c.total).toEqual(expect.arrayContaining(["total", "importe"]));
    expect(c.subtotal).toContain("subtotal");
    expect(c.descuento).toContain("descuento");
    expect(c.propina).toContain("propina");
    expect(c.forma_pago).toContain("forma de pago");
    expect(c.cancelada).toEqual(expect.arrayContaining(["cancelada", "estatus"]));
    expect(c.impuesto).toEqual(expect.arrayContaining(["impuesto", "iva"]));
  });
  it("el resultado de una normalización repite el aviso y el mapeo aplicado", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total"], ["A-1", "14/09/2026", "100.00"]], corte: "01:00" });
    expect(r.ok && r.inferido).toBe(true);
    if (r.ok) {
      expect(r.avisoAlias).toBe(ALIAS_SR_INFERIDOS.aviso);
      expect(r.mapeo).toEqual({ folio: "Folio", fecha: "Fecha", total: "Total" });
    }
  });
});

describe("montos -> centavos enteros", () => {
  it.each([
    ["$1,234.50", 123450],
    ["1234,50", 123450],
    ["1234.50", 123450],
    ["1.234,50", 123450],
    ["1,234,567.89", 123456789],
    ["$ 312.00", 31200],
    ["312", 31200],
    ["0.5", 50],
    ["0,05", 5],
    ["MXN 1,000", 100000],
    ["1,234", 123400], // coma de millares: exactamente 3 dígitos tras la coma
    ["12,5", 1250],
    ["1234,567", 123457], // 3 decimales: redondea half-up
    ["10.005", 1001],
    ["10.004", 1000],
    ["(12.50)", -1250],
    ["-$12.50", -1250],
    ["12.50-", -1250],
    ["0", 0],
    ["$0.00", 0],
    ["  45.10  ", 4510],
  ])("%s -> %i", (entrada, esperado) => {
    expect(parsearMontoCentavos(entrada)).toBe(esperado);
  });
  it("números ya numéricos (XLSX) sin errores de flotante", () => {
    expect(parsearMontoCentavos(312)).toBe(31200);
    expect(parsearMontoCentavos(1.005)).toBe(101); // 1.005 -> $1.01 (tercer decimal 5 sube)
    expect(parsearMontoCentavos(19.99)).toBe(1999);
    expect(parsearMontoCentavos(0.1 + 0.2)).toBe(30);
    expect(parsearMontoCentavos(1234567.89)).toBe(123456789);
  });
  it("lo que no es monto da null", () => {
    for (const x of ["", "abc", "12a", "--5", "$", null, undefined, Number.NaN, "1,2,3x"]) expect(parsearMontoCentavos(x as never)).toBeNull();
  });
});

describe("fechas y día de negocio", () => {
  it("dd/mm/aaaa y aaaa-mm-dd, con y sin hora", () => {
    expect(parsearFechaSr("14/09/2026")).toEqual({ fecha: "2026-09-14", hora: null });
    expect(parsearFechaSr("14-09-2026")).toEqual({ fecha: "2026-09-14", hora: null });
    expect(parsearFechaSr("2026-09-14")).toEqual({ fecha: "2026-09-14", hora: null });
    expect(parsearFechaSr("4/9/2026")).toEqual({ fecha: "2026-09-04", hora: null });
    expect(parsearFechaSr("14/09/26")).toEqual({ fecha: "2026-09-14", hora: null });
    expect(parsearFechaSr("14/09/2026 13:05")).toEqual({ fecha: "2026-09-14", hora: "13:05" });
    expect(parsearFechaSr("2026-09-14T00:30:00")).toEqual({ fecha: "2026-09-14", hora: "00:30" });
    expect(parsearFechaSr("14/09/2026 01:05 p. m.")).toEqual({ fecha: "2026-09-14", hora: "13:05" });
    expect(parsearFechaSr("14/09/2026 12:10 a.m.")).toEqual({ fecha: "2026-09-14", hora: "00:10" });
  });
  it("es dd/mm: 03/04/2026 es el 3 de abril, no el 4 de marzo", () => {
    expect(parsearFechaSr("03/04/2026")?.fecha).toBe("2026-04-03");
  });
  it("serie de Excel", () => {
    expect(parsearFechaSr(46279)).toEqual({ fecha: "2026-09-14", hora: null });
    expect(parsearFechaSr(46279.5)).toEqual({ fecha: "2026-09-14", hora: "12:00" });
    expect(parsearFechaSr("46279")).toEqual({ fecha: "2026-09-14", hora: null });
  });
  it("inválidas dan null", () => {
    for (const x of ["", "31/02/2026", "2026-13-01", "ayer", "14/09/2026 25:00", "14/09/2026 xx", null, 12]) expect(parsearFechaSr(x as never)).toBeNull();
  });
  it("corte 01:00: 00:30 cuenta en el día anterior; 01:00 y 01:05 en el día nuevo; sin hora, el día tal cual", () => {
    expect(diaDeNegocio("2026-09-14", "00:30", "01:00")).toBe("2026-09-13");
    expect(diaDeNegocio("2026-09-14", "00:59", "01:00")).toBe("2026-09-13");
    expect(diaDeNegocio("2026-09-14", "01:00", "01:00")).toBe("2026-09-14");
    expect(diaDeNegocio("2026-09-14", "01:05", "01:00")).toBe("2026-09-14");
    expect(diaDeNegocio("2026-09-14", null, "01:00")).toBe("2026-09-14");
    expect(diaDeNegocio("2026-03-01", "00:10", "01:00")).toBe("2026-02-28");
    expect(diaDeNegocio("2026-09-14", "00:30", "00:00")).toBe("2026-09-14");
  });
});

describe("tipo de servicio y forma de pago", () => {
  it.each([
    ["Comedor", "comedor"], ["MESA", "comedor"], ["Mesa 4", "comedor"],
    ["Para llevar", "para_llevar"], ["llevar", "para_llevar"], ["Mostrador", "para_llevar"],
    ["Domicilio", "domicilio"], ["A domicilio", "domicilio"], ["Delivery", "domicilio"],
    ["Rápido", "rapido"], ["rapido", "rapido"],
    ["Drive thru", "otro"], ["Evento especial", "otro"], ["", "otro"],
  ] as const)("%s -> %s", (entrada, esperado) => {
    expect(normalizarTipoServicio(entrada)).toBe(esperado);
  });
  it("null/undefined -> otro", () => {
    expect(normalizarTipoServicio(null)).toBe("otro");
    expect(normalizarTipoServicio(undefined)).toBe("otro");
  });
  it("forma de pago en minúsculas, sin espacios dobles y máximo 40 caracteres", () => {
    expect(normalizarFormaPago("  Tarjeta   de CRÉDITO ")).toBe("tarjeta de crédito");
    expect(normalizarFormaPago("")).toBeNull();
    expect(normalizarFormaPago("x".repeat(60))).toHaveLength(40);
  });
});

describe("datos personales: el archivo se rechaza completo", () => {
  const base = (extra: string): string[][] => [["Folio", "Fecha", extra, "Total"], ["A-1", "14/09/2026", "dato", "100.00"]];
  it.each(["Teléfono", "TELEFONO", "Tel.", "Celular", "Nombre", "Nombre del cliente", "Cliente", "Correo", "Correo electrónico", "E-mail", "Dirección", "Calle", "Colonia", "RFC", "CURP", "WhatsApp"])(
    "la columna «%s» se rechaza",
    (col) => {
      const r = normalizarExportSr({ tabla: base(col), corte: "01:00" });
      expect(r.ok).toBe(false);
      if (!r.ok && r.motivo === "columnas_personales") expect(r.columnas).toEqual([col]);
      else throw new Error("debía rechazar por columnas personales");
    },
  );
  it("lista todas las columnas personales, no solo la primera", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total", "Teléfono", "Nombre"], ["A-1", "14/09/2026", "1", "5551234", "x"]], corte: "01:00" });
    expect(!r.ok && r.motivo === "columnas_personales" && r.columnas).toEqual(["Teléfono", "Nombre"]);
  });
  it("detector de columnas", () => {
    expect(esColumnaPersonal("Teléfono del cliente")).toBe(true);
    expect(esColumnaPersonal("Tipo de servicio")).toBe(false);
    expect(esColumnaPersonal("Forma de pago")).toBe(false);
    expect(esColumnaPersonal("Domicilio")).toBe(false); // «domicilio» es un tipo de servicio, no la dirección
    expect(esColumnaPersonal("Total")).toBe(false);
  });
  it("el rechazo no se salta aunque la columna personal esté bajo un título", () => {
    const r = normalizarExportSr({ tabla: [["Reporte"], ...base("Teléfono")], corte: "01:00" });
    expect(r.ok).toBe(false);
  });
});

describe("layout «cuentas» (CSV sintético)", () => {
  const tabla = parsearCsvSr(CSV_SR_SINTETICO);
  const r = normalizarExportSr({ tabla, corte: "01:00" });
  it("el CSV sintético dice que no es un export real", () => {
    expect(CSV_SR_SINTETICO.split("\r\n")[0]).toContain(ETIQUETA_SINTETICO);
    expect(ETIQUETA_SINTETICO).toBe("SINTÉTICO – no es un export real de SoftRestaurant");
    expect(CSV_SR_SINTETICO).not.toMatch(/tel[eé]fono|nombre|correo|direcci[oó]n|rfc/i);
  });
  it("detecta el encabezado bajo el renglón de título y el layout", () => {
    expect(tabla[0]).toEqual([ETIQUETA_SINTETICO]);
    expect(r.ok).toBe(true);
    if (!r.ok || r.tipo !== "cuentas") throw new Error("debía ser cuentas");
    expect(r.mapeo).toMatchObject({ folio: "Folio", fecha: "Fecha", hora: "Hora", servicio: "Tipo de servicio", total: "Total", descuento: "Descuento", propina: "Propina", forma_pago: "Forma de pago", cancelada: "Cancelada", subtotal: "Subtotal" });
    expect(r.ignoradas).toEqual([]);
  });
  it("las cuentas normalizadas coinciden con la verdad del generador (corte 01:00 incluido)", () => {
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.errores).toEqual([]);
    expect(r.rechazados).toBe(0);
    expect(r.aceptados).toBe(TICKETS_SR_ESPERADOS.length);
    expect(aFilasSrTicket(T2.propertyId, r.renglones)).toEqual(TICKETS_SR_ESPERADOS);
    expect(r.renglones.some((x) => x.horaLocal?.startsWith("00:"))).toBe(true); // hay cuentas después de la medianoche
    expect(r.fechaMin).toBe("2026-09-21");
    expect(r.fechaMax).toBe("2026-09-27");
  });
  it("las cuentas de la 00:xx se asignan al día de negocio anterior", () => {
    const antesDelCorte = TICKETS_SR_ESPERADOS.filter((t) => t.horaLocal?.startsWith("00:"));
    expect(antesDelCorte.length).toBeGreaterThan(0);
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    for (const t of antesDelCorte) {
      const fila = tabla.find((f) => f[0] === t.folio)!;
      const calendario = fila[1]!; // dd/mm/aaaa del día calendario
      expect(`${calendario.slice(6)}-${calendario.slice(3, 5)}-${calendario.slice(0, 2)}`).not.toBe(t.diaNegocio); // el calendario es el día siguiente
    }
  });
  it("sin llaves de cliente: el SQL recibe solo las columnas permitidas", () => {
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    const sql = renglonesSqlCuentas(r.renglones);
    expect(Object.keys(sql[0]!).sort()).toEqual(["cancelado", "descuento_centavos", "dia_negocio", "folio", "forma_pago", "hora_local", "propina_centavos", "tipo_servicio", "total_centavos"]);
  });
  it("derivar el resumen desde cuentas: Σ por día, servicio y forma de pago, y cuadra con el total de las cuentas no canceladas", () => {
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    const resumen = derivarResumenDeCuentas(T2.propertyId, r.renglones);
    const noCanceladas = r.renglones.filter((c) => !c.cancelado);
    expect(resumen.reduce((s, f) => s + f.netaCentavos, 0)).toBe(noCanceladas.reduce((s, c) => s + c.totalCentavos, 0));
    expect(resumen.reduce((s, f) => s + f.tickets, 0)).toBe(noCanceladas.length);
    expect(resumen.reduce((s, f) => s + f.canceladoCentavos, 0)).toBe(r.renglones.filter((c) => c.cancelado).reduce((s, c) => s + c.totalCentavos, 0));
    const c = consolidar(resumen, { propertyId: "propertyId" }, ["tickets", "netaCentavos", "descuentoCentavos"]);
    expect(c.total.valores.netaCentavos).toBe(resumen.reduce((s, f) => s + f.netaCentavos, 0));
  });
});

describe("layout «resumen por tipo de servicio» (filas de XLSX sintéticas)", () => {
  const r = normalizarExportSr({ tabla: filasXlsxSrSintetico, corte: "01:00" });
  it("normaliza montos con coma decimal y fechas aaaa-mm-dd, y coincide con la verdad del generador", () => {
    expect(filasXlsxSrSintetico[0]![0]).toBe(ETIQUETA_SINTETICO);
    expect(r.ok).toBe(true);
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("debía ser resumen_servicio");
    expect(r.errores).toEqual([]);
    expect(aFilasSrResumen(T2.propertyId, r.renglones)).toEqual(RESUMEN_SR_SINTETICO_ESPERADO.map((f) => ({ ...f, formaPago: null })));
    expect(r.mapeo).toMatchObject({ fecha: "Fecha", servicio: "Tipo de servicio", tickets: "Cuentas", subtotal: "Subtotal", total: "Total" });
  });
  it("SQL con las llaves de sr_resumen_dia", () => {
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("x");
    expect(Object.keys(renglonesSqlResumen(r.renglones)[0]!).sort()).toEqual(["bruta_centavos", "cancelado_centavos", "descuento_centavos", "dia_negocio", "forma_pago", "iva_centavos", "neta_centavos", "propina_centavos", "tickets", "tipo_servicio"]);
  });
  it("el domicilio SR queda separado del presencial", () => {
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("x");
    const servicios = new Set(r.renglones.map((x) => x.tipoServicio));
    expect(servicios.has("domicilio")).toBe(true);
    expect(servicios.has("comedor") || servicios.has("para_llevar") || servicios.has("rapido")).toBe(true);
  });
});

describe("variantes de encabezados y casos borde", () => {
  it("encabezados con acentos, mayúsculas y alias alternativos (Importe, Fecha cierre, No. Cuenta, Estatus)", () => {
    const r = normalizarExportSr({
      tabla: [["No. Cuenta", "FECHA CIERRE", "Servicio", "Importe", "Descuento", "Propina", "Forma de Pago", "Estatus"], ["T7-1", "05/10/2026", "Rápido", "$1,250.00", "$50.00", "$0.00", "Tarjeta", "Cancelada"], ["T7-2", "05/10/2026", "Comedor", "800,00", "", "", "Efectivo", "Pagada"]],
      corte: "01:00",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.renglones).toEqual([
      { folio: "T7-1", diaNegocio: "2026-10-05", horaLocal: null, tipoServicio: "rapido", totalCentavos: 125000, descuentoCentavos: 5000, propinaCentavos: 0, formaPago: "tarjeta", cancelado: true },
      { folio: "T7-2", diaNegocio: "2026-10-05", horaLocal: null, tipoServicio: "comedor", totalCentavos: 80000, descuentoCentavos: 0, propinaCentavos: 0, formaPago: "efectivo", cancelado: false },
    ]);
  });
  it("hora en columna aparte y fecha con hora en la misma celda", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Hora cierre", "Total"], ["1", "14/09/2026", "00:15", "10"], ["2", "14/09/2026 01:30", "", "20"]], corte: "01:00" });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.renglones.map((x) => x.diaNegocio)).toEqual(["2026-09-13", "2026-09-14"]);
    expect(r.renglones.map((x) => x.horaLocal)).toEqual(["00:15", "01:30"]);
  });
  it("tipo de servicio desconocido -> otro; sin columna de servicio, todo es otro con advertencia", () => {
    const r1 = normalizarExportSr({ tabla: [["Folio", "Fecha", "Tipo de servicio", "Total"], ["1", "14/09/2026", "Servicio a bordo", "10"]], corte: "01:00" });
    if (!r1.ok || r1.tipo !== "cuentas") throw new Error("x");
    expect(r1.renglones[0]!.tipoServicio).toBe("otro");
    const r2 = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total"], ["1", "14/09/2026", "10"]], corte: "01:00" });
    if (!r2.ok || r2.tipo !== "cuentas") throw new Error("x");
    expect(r2.renglones[0]!.tipoServicio).toBe("otro");
    expect(r2.advertencias.join(" ")).toContain("tipo de servicio");
  });
  it("renglones malos se reportan con número de renglón y campo, y los buenos se aceptan", () => {
    const r = normalizarExportSr({
      tabla: [["Folio", "Fecha", "Total"], ["1", "14/09/2026", "100"], ["", "14/09/2026", "100"], ["3", "31/02/2026", "100"], ["4", "14/09/2026", "abc"], ["5", "14/09/2026", "-20"], ["6", "14/09/2026", ""], ["7", "14/09/2026", "70"]],
      corte: "01:00",
    });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.aceptados).toBe(2);
    expect(r.rechazados).toBe(5);
    expect(r.errores.map((e) => [e.renglon, e.campo])).toEqual([[3, "folio"], [4, "fecha"], [5, "total"], [6, "total"], [7, "total"]]);
    expect(r.errores[3]!.motivo).toBe("monto negativo no permitido");
  });
  it("folio repetido en el archivo: se queda el primero y el repetido se reporta", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total"], ["A-1", "14/09/2026", "100"], ["A-1", "14/09/2026", "100"]], corte: "01:00" });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.aceptados).toBe(1);
    expect(r.errores[0]).toMatchObject({ campo: "folio" });
    expect(r.errores[0]!.motivo).toContain("duplicado");
  });
  it("renglones de totales y vacíos no son datos", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total"], ["1", "14/09/2026", "100"], ["", "", ""], ["Total", "", "100"], ["Suma", "", "100"]], corte: "01:00" });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.aceptados).toBe(1);
    expect(r.omitidos).toBe(2);
    expect(r.rechazados).toBe(0);
  });
  it("el resumen suma renglones que caen en la misma llave (día, servicio, forma de pago)", () => {
    const r = normalizarExportSr({
      tabla: [["Fecha", "Servicio", "Cuentas", "Subtotal", "Descuento", "Total", "Forma de pago"], ["14/09/2026", "Domicilio", "3", "300", "30", "270", "Efectivo"], ["14/09/2026", "A domicilio", "2", "200", "0", "200", "efectivo"], ["14/09/2026", "Domicilio", "1", "100", "0", "100", "Tarjeta"]],
      corte: "01:00",
    });
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("x");
    expect(r.renglones).toHaveLength(2);
    expect(r.renglones.find((x) => x.formaPago === "efectivo")).toMatchObject({ tickets: 5, brutaCentavos: 50000, descuentoCentavos: 3000, netaCentavos: 47000 });
  });
  it("sin subtotal, la bruta se estima como total + descuento y se avisa", () => {
    const r = normalizarExportSr({ tabla: [["Fecha", "Servicio", "Cuentas", "Descuento", "Total"], ["14/09/2026", "Comedor", "4", "10", "90"]], corte: "01:00" });
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("x");
    expect(r.renglones[0]!.brutaCentavos).toBe(10000);
    expect(r.advertencias.join(" ")).toContain("venta bruta");
  });
  it("IVA del archivo: se conserva (importado)", () => {
    const r = normalizarExportSr({ tabla: [["Fecha", "Servicio", "Cuentas", "Total", "IVA"], ["14/09/2026", "Comedor", "4", "116", "16"]], corte: "01:00" });
    if (!r.ok || r.tipo !== "resumen_servicio") throw new Error("x");
    expect(r.renglones[0]!.ivaCentavos).toBe(1600);
  });
  it("faltan columnas requeridas / sin encabezado reconocible", () => {
    const r1 = normalizarExportSr({ tabla: [["Folio", "Fecha"], ["1", "14/09/2026"]], corte: "01:00" });
    expect(r1).toMatchObject({ ok: false, motivo: "faltan_columnas", faltan: ["total"] });
    const r2 = normalizarExportSr({ tabla: [["foo", "bar"], ["1", "2"]], corte: "01:00" });
    expect(r2).toMatchObject({ ok: false, motivo: "sin_encabezado" });
    expect(normalizarExportSr({ tabla: [], corte: "01:00" })).toMatchObject({ ok: false, motivo: "sin_encabezado" });
  });
  it("el tipo se puede forzar; un corte inválido lanza", () => {
    const tabla = [["Folio", "Fecha", "Servicio", "Total"], ["1", "14/09/2026", "Comedor", "10"]];
    expect(normalizarExportSr({ tabla, corte: "01:00", tipo: "cuentas" })).toMatchObject({ ok: true, tipo: "cuentas" });
    expect(normalizarExportSr({ tabla, corte: "01:00", tipo: "resumen_servicio" })).toMatchObject({ ok: true, tipo: "resumen_servicio" });
    expect(normalizarExportSr({ tabla: [["Folio", "Fecha", "Total"], ["1", "14/09/2026", "10"]], corte: "01:00", tipo: "resumen_servicio" })).toMatchObject({ ok: false, motivo: "faltan_columnas", faltan: ["servicio"] });
    expect(() => normalizarExportSr({ tabla, corte: "1am" })).toThrow(RangeError);
  });
  it("máximo 50 errores detallados, pero el conteo de rechazados es total", () => {
    const tabla = [["Folio", "Fecha", "Total"], ...Array.from({ length: 80 }, (_, i) => [String(i + 1), "fecha mala", "10"])];
    const r = normalizarExportSr({ tabla, corte: "01:00" });
    if (!r.ok) throw new Error("x");
    expect(r.errores).toHaveLength(50);
    expect(r.rechazados).toBe(80);
  });
  it("celdas numéricas de XLSX (montos y series de fecha)", () => {
    const r = normalizarExportSr({ tabla: [["Folio", "Fecha", "Total", "Propina"], [101, 46279.01, 312, 31.2]], corte: "01:00" });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.renglones[0]).toMatchObject({ folio: "101", totalCentavos: 31200, propinaCentavos: 3120 });
    expect(r.renglones[0]!.diaNegocio).toBe("2026-09-13"); // 00:14 < corte 01:00
  });
});

describe("CSV", () => {
  it("separador punto y coma, comillas, comillas escapadas y BOM", () => {
    const csv = '﻿Folio;Fecha;Total;Forma de pago\r\n1;14/09/2026;"1,234.50";"Tarjeta ""Visa"""\r\n2;15/09/2026;10;Efectivo\r\n';
    const t = parsearCsvSr(csv);
    expect(t[0]).toEqual(["Folio", "Fecha", "Total", "Forma de pago"]);
    expect(t[1]).toEqual(["1", "14/09/2026", "1,234.50", 'Tarjeta "Visa"']);
    const r = normalizarExportSr({ tabla: t, corte: "01:00" });
    if (!r.ok || r.tipo !== "cuentas") throw new Error("x");
    expect(r.renglones[0]).toMatchObject({ totalCentavos: 123450, formaPago: 'tarjeta "visa"' });
  });
  it("tabuladores y saltos de línea dentro de comillas", () => {
    const t = parsearCsvSr('Folio\tFecha\tTotal\n1\t14/09/2026\t10\n');
    expect(t).toEqual([["Folio", "Fecha", "Total"], ["1", "14/09/2026", "10"]]);
    expect(parsearCsvSr('a,b\n"x\ny",2')).toEqual([["a", "b"], ["x\ny", "2"]]);
    expect(parsearCsvSr("")).toEqual([]);
  });
});

describe("normalizarEncabezado", () => {
  it("quita acentos, signos y espacios dobles", () => {
    expect(normalizarEncabezado("  Teléfono /  Celular ")).toBe("telefono celular");
    expect(normalizarEncabezado("No. de Cuenta")).toBe("no de cuenta");
    expect(normalizarEncabezado("# Cuentas")).toBe("cuentas");
  });
});
