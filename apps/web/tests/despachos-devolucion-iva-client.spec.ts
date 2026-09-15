import { describe, expect, it, vi } from "vitest";
import {
  fetchFacturasPeriodoDevolucionIva,
  postCongruenciaDevolucionIva,
  postConciliacionDevolucionIva,
  postDiotDevolucionIva,
  postPapelTrabajoDevolucionIva,
  postPlazoResolucionDevolucionIva,
  postSaldoFavorDevolucionIva,
  postSolicitudDevolucionIva,
} from "../src/verticals/despachos/lib/devolucion-iva-client.ts";
import type {
  ClasificacionIvaResultado,
  CongruenciaDiotCfdiDeclaracion,
  ConciliacionDeclaracionSaldo,
  DeclaracionMensualIva,
  DiotEntryIva,
  FacturaCfdiIva,
  MontoDevolucion,
  PapelTrabajoDevolucionIva,
  SolicitudDevolucion,
} from "../src/verticals/despachos/lib/devolucion-iva-client.ts";

const FACTURA: FacturaCfdiIva = {
  uuid: "uuid-1",
  rfcEmisor: "AAA010101AAA",
  nombreEmisor: "Proveedor SA",
  rfcReceptor: "BBB020202BBB",
  fecha: "2026-03-05",
  subtotal: 1000,
  iva: 160,
  total: 1160,
  tipo: "Ingreso",
  categoria: "acreditable_100",
  proporcionalidad: 1,
  referenciaComplementoPago: "uuid-rep-1",
};

const DIOT_ENTRY: DiotEntryIva = {
  rfcTercero: "AAA010101AAA",
  nombre: "Proveedor SA",
  tipoOperacion: "03",
  montoNeto: 1000,
  ivaTrasladado: 160,
  ivaAcreditable: 160,
  foliosFiscales: ["uuid-1"],
  facturasDetalle: [{ folioFiscal: "uuid-1", folioFactura: null, concepto: null, fechaPago: null, bancoPago: null }],
};

const DECLARACION: DeclaracionMensualIva = { mes: 3, año: 2026, ivaCobrado: 500, ivaPagado: 160, saldoFavor: 0, saldoContra: 340 };

describe("fetchFacturasPeriodoDevolucionIva", () => {
  it("manda GET .../devolucion-iva/facturas/:periodo y devuelve facturas + clasificación tal cual", async () => {
    const clasificacion: ClasificacionIvaResultado = { acreditable_100: [FACTURA], acreditable_proporcional: [], no_acreditable: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/facturas/2026-03");
      expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
      return new Response(JSON.stringify({ facturas: [FACTURA], clasificacion }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchFacturasPeriodoDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03");
    expect(result.facturas).toEqual([FACTURA]);
    expect(result.clasificacion).toEqual(clasificacion);
  });
});

describe("postDiotDevolucionIva", () => {
  it("manda POST .../diot con facturas+periodo y devuelve diotEntries+errores", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/diot");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ facturas: [FACTURA], periodo: "2026-03" });
      return new Response(JSON.stringify({ diotEntries: [DIOT_ENTRY], errores: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postDiotDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", [FACTURA], "2026-03");
    expect(result.diotEntries).toEqual([DIOT_ENTRY]);
    expect(result.errores).toEqual([]);
  });

  it("sin periodo manda solo {facturas}", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ facturas: [FACTURA] });
      return new Response(JSON.stringify({ diotEntries: [], errores: ["No hay entradas DIOT para validar."] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postDiotDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", [FACTURA]);
    expect(result.errores).toEqual(["No hay entradas DIOT para validar."]);
  });

  it("400 (validación) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "facturas[0].uuid: se esperaba un texto no vacío." }), { status: 400 })) as unknown as typeof fetch;
    await expect(postDiotDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", [])).rejects.toThrow("se esperaba un texto no vacío");
  });
});

describe("postConciliacionDevolucionIva", () => {
  it("manda POST .../conciliacion con facturas+diotEntries+declaraciones", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/conciliacion");
      expect(JSON.parse(init?.body as string)).toEqual({ facturas: [FACTURA], diotEntries: [DIOT_ENTRY], declaraciones: [DECLARACION] });
      return new Response(
        JSON.stringify({
          facturasVsDiot: [{ facturaUuid: "uuid-1", diotMatch: true, status: "match", detalles: "Conciliación correcta" }],
          diotVsDeclaracion: [{ diotIvaTotal: 160, declaracionIvaAcreditable: 160, diferencia: 0, status: "match" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await postConciliacionDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", [FACTURA], [DIOT_ENTRY], [DECLARACION]);
    expect(result.facturasVsDiot[0]!.status).toBe("match");
    expect(result.diotVsDeclaracion[0]!.status).toBe("match");
  });
});

describe("postSaldoFavorDevolucionIva", () => {
  it("manda POST .../saldo-favor con declaraciones y devuelve saldoFavor+montoDevolucion+verificacion", async () => {
    const montoDevolucion: MontoDevolucion = {
      saldoFavorOriginal: 500,
      totalSaldoFavorDeclaraciones: 500,
      factorActualizacion: 1,
      montoActualizado: 500,
      montoDevolucionSugerido: 500,
      periodoMasAntiguo: "2026-01",
      prescripcionVerificada: true,
    };
    const verificacion: ConciliacionDeclaracionSaldo = {
      totalSaldoFavorDeclared: 500,
      totalSaldoContraDeclared: 0,
      saldoNetoDeclaraciones: 500,
      saldoAFavorSolicitado: 500,
      diferencia: 0,
      consistente: true,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/saldo-favor");
      expect(JSON.parse(init?.body as string)).toEqual({ declaraciones: [DECLARACION] });
      return new Response(JSON.stringify({ saldoFavor: 500, montoDevolucion, verificacion }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postSaldoFavorDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", [DECLARACION]);
    expect(result.saldoFavor).toBe(500);
    expect(result.montoDevolucion).toEqual(montoDevolucion);
    expect(result.verificacion).toEqual(verificacion);
  });
});

describe("postCongruenciaDevolucionIva", () => {
  it("manda POST .../congruencia con periodo+facturas+diotEntries+declaraciones (sin tolerancia)", async () => {
    const congruencia: CongruenciaDiotCfdiDeclaracion = {
      periodo: "2026-03",
      diotExiste: true,
      declaracionExiste: true,
      totalCfdiIvaAcreditable: 160,
      totalDiotIvaAcreditable: 160,
      totalDeclaracionIvaPagado: 160,
      diferenciaCfdiDiot: 0,
      diferenciaDiotDeclaracion: 0,
      diferenciaMaxima: 0,
      tolerancia: 1,
      congruente: true,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/congruencia");
      expect(JSON.parse(init?.body as string)).toEqual({ periodo: "2026-03", facturas: [FACTURA], diotEntries: [DIOT_ENTRY], declaraciones: [DECLARACION] });
      return new Response(JSON.stringify(congruencia), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postCongruenciaDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", [FACTURA], [DIOT_ENTRY], [DECLARACION]);
    expect(result).toEqual(congruencia);
  });

  it("con tolerancia la incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ tolerancia: 5 });
      return new Response(
        JSON.stringify({
          periodo: "2026-03",
          diotExiste: true,
          declaracionExiste: true,
          totalCfdiIvaAcreditable: 0,
          totalDiotIvaAcreditable: 0,
          totalDeclaracionIvaPagado: 0,
          diferenciaCfdiDiot: 0,
          diferenciaDiotDeclaracion: 0,
          diferenciaMaxima: 0,
          tolerancia: 5,
          congruente: true,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await postCongruenciaDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", [], [], [], 5);
  });
});

describe("postSolicitudDevolucionIva", () => {
  it("manda POST .../solicitud con periodo+saldo+opciones y devuelve la solicitud", async () => {
    const solicitud: SolicitudDevolucion = {
      solicitudId: "sol-1",
      periodo: "2026-03",
      montoSolicitado: 500,
      tenantId: null,
      cuentaBanco: "BBVA",
      clabe: null,
      documentos: ["cfdi.zip"],
      status: "pendiente",
      estado: "lista_para_envio",
      motivoAclaracion: null,
      createdAt: "2026-03-10T00:00:00.000Z",
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/solicitud");
      expect(JSON.parse(init?.body as string)).toEqual({
        periodo: "2026-03",
        saldo: { montoDevolucionSugerido: 500 },
        cuentaBanco: "BBVA",
        documentos: ["cfdi.zip"],
      });
      return new Response(JSON.stringify(solicitud), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postSolicitudDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", { montoDevolucionSugerido: 500 }, {
      cuentaBanco: "BBVA",
      documentos: ["cfdi.zip"],
    });
    expect(result).toEqual(solicitud);
  });

  it("400 (monto <= 0) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El monto de devolución (0) debe ser mayor a cero. No hay saldo a favor suficiente." }), { status: 400 })) as unknown as typeof fetch;
    await expect(postSolicitudDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", { montoDevolucionSugerido: 0 })).rejects.toThrow("debe ser mayor a cero");
  });
});

describe("postPlazoResolucionDevolucionIva", () => {
  it("manda POST .../plazo-resolucion con fechaPresentacion y devuelve fechaLimite", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/plazo-resolucion");
      expect(JSON.parse(init?.body as string)).toEqual({ fechaPresentacion: "2026-03-10" });
      return new Response(JSON.stringify({ fechaPresentacion: "2026-03-10", fechaLimite: "2026-05-06" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postPlazoResolucionDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03-10");
    expect(result.fechaLimite).toBe("2026-05-06");
  });

  it("con hayDictamenOGarantia lo incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ fechaPresentacion: "2026-03-10", hayDictamenOGarantia: true });
      return new Response(JSON.stringify({ fechaPresentacion: "2026-03-10", fechaLimite: "2026-04-08" }), { status: 200 });
    }) as unknown as typeof fetch;
    await postPlazoResolucionDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03-10", true);
  });
});

describe("postPapelTrabajoDevolucionIva", () => {
  it("manda POST .../papel-trabajo con periodo+facturas+diotEntries+declaraciones+opciones", async () => {
    const papel: PapelTrabajoDevolucionIva = {
      periodo: "2026-03",
      tenantId: null,
      secciones: {
        "1_resumen_periodo": {
          periodo: "2026-03",
          resumenFacturas: { totalFacturas: 1, acreditable100Count: 1, acreditableProporcionalCount: 0, noAcreditableCount: 0, totalSubtotal: 1000, totalIvaTrasladado: 160, totalGravado: 1160 },
          resumenDiot: { totalEntradas: 1, totalIvaTrasladado: 160, totalIvaAcreditable: 160 },
          resumenDeclaraciones: { totalDeclaraciones: 1, totalIvaCobrado: 500, totalIvaPagado: 160, totalSaldoFavor: 0, totalSaldoContra: 340 },
        },
        "2_diot_por_proveedor": { proveedores: [], totalProveedores: 0, totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0 },
        "3_conciliacion_cfdi_diot": { totalFacturas: 1, matches: 1, mismatches: 0, missing: 0, tasaConciliacion: 100, detalleMismatches: [], detalleMissing: [] },
        "4_conciliacion_diot_declaracion": { totalDeclaraciones: 1, matches: 1, mismatches: 0, tasaConciliacion: 100, detalle: [] },
        "5_calculo_saldo": {
          saldoAFavor: 0,
          montoDevolucion: { saldoFavorOriginal: 0, totalSaldoFavorDeclaraciones: 0, factorActualizacion: 1, montoActualizado: 0, montoDevolucionSugerido: 0, periodoMasAntiguo: "2026-03", prescripcionVerificada: true },
          verificacion: { totalSaldoFavorDeclared: 0, totalSaldoContraDeclared: 340, saldoNetoDeclaraciones: -340, saldoAFavorSolicitado: 0, diferencia: 340, consistente: false },
        },
        "6_documentos_soporte": { documentos: [], totalDocumentos: 0, checklist: { cfdiCompra: false, diot: false, declaraciones: false, estadosCuenta: false, balanza: false } },
        "7_no_discrepancia_fiscal_depositos": {
          disponible: false,
          mensaje: "No se proporcionó papel de conciliación de ingresos/egresos (depósitos bancarios) para este período; sección informativa sin datos.",
          totalDepositosClasificados: 0,
          clasificacionesDepositos: [],
          resumenPorClasificacion: {},
          requiereRevisionHumana: false,
          advertenciaFiscal: "Ninguna clasificación de depósito de esta sección es una determinación fiscal firme.",
        },
      },
      metadata: { generadoPor: "atiende-fusion - Devolución de IVA", version: "1.0", totalFacturas: 1, totalDiotEntries: 1, totalDeclaraciones: 1 },
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/devolucion-iva/papel-trabajo");
      expect(JSON.parse(init?.body as string)).toEqual({ periodo: "2026-03", facturas: [FACTURA], diotEntries: [DIOT_ENTRY], declaraciones: [DECLARACION], documentosSoporte: ["cfdi.zip"] });
      return new Response(JSON.stringify(papel), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postPapelTrabajoDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", [FACTURA], [DIOT_ENTRY], [DECLARACION], { documentosSoporte: ["cfdi.zip"] });
    expect(result).toEqual(papel);
  });

  it("sin diotEntries no lo manda en el body (el servidor las regenera)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.diotEntries).toBeUndefined();
      expect(body).toEqual({ periodo: "2026-03", facturas: [FACTURA], declaraciones: [] });
      return new Response(
        JSON.stringify({
          periodo: "2026-03",
          tenantId: null,
          secciones: {
            "1_resumen_periodo": { periodo: "2026-03", resumenFacturas: { totalFacturas: 1, acreditable100Count: 1, acreditableProporcionalCount: 0, noAcreditableCount: 0, totalSubtotal: 1000, totalIvaTrasladado: 160, totalGravado: 1160 }, resumenDiot: { totalEntradas: 1, totalIvaTrasladado: 160, totalIvaAcreditable: 160 }, resumenDeclaraciones: { totalDeclaraciones: 0, totalIvaCobrado: 0, totalIvaPagado: 0, totalSaldoFavor: 0, totalSaldoContra: 0 } },
            "2_diot_por_proveedor": { proveedores: [], totalProveedores: 0, totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0 },
            "3_conciliacion_cfdi_diot": { totalFacturas: 1, matches: 0, mismatches: 1, missing: 0, tasaConciliacion: 0, detalleMismatches: [], detalleMissing: [] },
            "4_conciliacion_diot_declaracion": { totalDeclaraciones: 0, matches: 0, mismatches: 0, tasaConciliacion: 0, detalle: [] },
            "5_calculo_saldo": { saldoAFavor: 0, montoDevolucion: { saldoFavorOriginal: 0, totalSaldoFavorDeclaraciones: 0, factorActualizacion: 1, montoActualizado: 0, montoDevolucionSugerido: 0, periodoMasAntiguo: null, prescripcionVerificada: true }, verificacion: { totalSaldoFavorDeclared: 0, totalSaldoContraDeclared: 0, saldoNetoDeclaraciones: 0, saldoAFavorSolicitado: 0, diferencia: 0, consistente: true } },
            "6_documentos_soporte": { documentos: [], totalDocumentos: 0, checklist: { cfdiCompra: false, diot: false, declaraciones: false, estadosCuenta: false, balanza: false } },
            "7_no_discrepancia_fiscal_depositos": { disponible: false, mensaje: "sin datos", totalDepositosClasificados: 0, clasificacionesDepositos: [], resumenPorClasificacion: {}, requiereRevisionHumana: false, advertenciaFiscal: "aviso" },
          },
          metadata: { generadoPor: "atiende-fusion - Devolución de IVA", version: "1.0", totalFacturas: 1, totalDiotEntries: 0, totalDeclaraciones: 0 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await postPapelTrabajoDevolucionIva(fetchImpl, "http://api.local", "tok", "prop-1", "2026-03", [FACTURA], undefined, []);
    expect(result.metadata.totalDeclaraciones).toBe(0);
  });
});
