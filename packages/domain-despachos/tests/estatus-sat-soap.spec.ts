// D-27: adaptador SOAP de ConsultaCFDIService con fixtures XML (SIN llamadas al SAT).
import { describe, expect, it } from "vitest";
import { ConsultaCfdiSatSoap, construirExpresionImpresa, interpretarRespuestaSat } from "../src/index.ts";

const ENTRADA = { rfcEmisor: "AAA010101AA1", rfcReceptor: "RRR010101RR1", total: 116, folioFiscal: "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c3d" };

function sobre(estado: string, extra = ""): string {
  return (
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ConsultaResponse xmlns="http://tempuri.org/">` +
    `<ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi.Negocio.ConsultaCfdi.Servicio" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
    `<a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus>${extra}<a:Estado>${estado}</a:Estado>` +
    `<a:ValidacionEFOS>200</a:ValidacionEFOS></ConsultaResult></ConsultaResponse></s:Body></s:Envelope>`
  );
}

function adaptadorConRespuesta(cuerpo: string, status = 200) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return new Response(cuerpo, { status });
  }) as unknown as typeof fetch;
  return { adaptador: new ConsultaCfdiSatSoap({ fetchImpl, timeoutMs: 500 }), llamadas };
}

describe("ConsultaCfdiSatSoap", () => {
  it("vigente: parsea Estado, EsCancelable y EstatusCancelacion y envia la expresion impresa validada", async () => {
    const { adaptador, llamadas } = adaptadorConRespuesta(sobre("Vigente", "<a:EsCancelable>Cancelable sin aceptación</a:EsCancelable><a:EstatusCancelacion/>"));
    const r = await adaptador.consultar(ENTRADA);
    expect(r).toEqual({ consultado: true, estado: "vigente", esCancelable: "Cancelable sin aceptación", estatusCancelacion: null, codigoEstatus: "S - Comprobante obtenido satisfactoriamente.", validacionEfos: "200" });
    expect(llamadas).toHaveLength(1);
    expect(String(llamadas[0]!.init.body)).toContain("<![CDATA[?re=AAA010101AA1&rr=RRR010101RR1&tt=116.000000&id=6129984C-4F5E-4A0F-9B7E-0D4D8A1B2C3D]]>");
    expect((llamadas[0]!.init.headers as Record<string, string>).SOAPAction).toBe("http://tempuri.org/IConsultaCFDIService/Consulta");
  });

  it("cancelado con estatus de cancelacion", async () => {
    const { adaptador } = adaptadorConRespuesta(sobre("Cancelado", "<a:EsCancelable>No cancelable</a:EsCancelable><a:EstatusCancelacion>Cancelado sin aceptación</a:EstatusCancelacion>"));
    expect(await adaptador.consultar(ENTRADA)).toMatchObject({ consultado: true, estado: "cancelado", esCancelable: "No cancelable", estatusCancelacion: "Cancelado sin aceptación" });
  });

  it("parsea CodigoEstatus y ValidacionEFOS (antes se descartaban) y la cancelacion «En proceso»", async () => {
    const { adaptador } = adaptadorConRespuesta(sobre("Vigente", "<a:EsCancelable>Cancelable con aceptación</a:EsCancelable><a:EstatusCancelacion>En proceso</a:EstatusCancelacion>"));
    expect(await adaptador.consultar(ENTRADA)).toEqual({
      consultado: true,
      estado: "vigente",
      esCancelable: "Cancelable con aceptación",
      estatusCancelacion: "En proceso",
      codigoEstatus: "S - Comprobante obtenido satisfactoriamente.",
      validacionEfos: "200",
    });
  });

  it("no encontrado", async () => {
    const { adaptador } = adaptadorConRespuesta(sobre("No Encontrado"));
    expect(await adaptador.consultar(ENTRADA)).toMatchObject({ consultado: true, estado: "no_encontrado" });
  });

  it("XML malformado, estado desconocido o cuerpo vacio -> pendiente sin concluir (jamas vigente)", async () => {
    for (const cuerpo of ["<html>mantenimiento</html>", "", sobre("Algo Raro"), "<s:Envelope><s:Body><ConsultaResult><a:Estado>Vigente"]) {
      const { adaptador } = adaptadorConRespuesta(cuerpo);
      const r = await adaptador.consultar(ENTRADA);
      expect(r).toMatchObject({ consultado: false, estado: "pendiente", motivo: "respuesta_invalida" });
    }
  });

  it("HTTP 500 -> pendiente (motivo http)", async () => {
    const { adaptador } = adaptadorConRespuesta(sobre("Vigente"), 500);
    expect(await adaptador.consultar(ENTRADA)).toMatchObject({ consultado: false, estado: "pendiente", motivo: "http" });
  });

  it("timeout: el SAT no responde -> pendiente (motivo timeout), nunca vigente", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const r = await new ConsultaCfdiSatSoap({ fetchImpl, timeoutMs: 20 }).consultar(ENTRADA);
    expect(r).toMatchObject({ consultado: false, estado: "pendiente", motivo: "timeout" });
  });

  it("red caida -> pendiente (motivo red)", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await new ConsultaCfdiSatSoap({ fetchImpl }).consultar(ENTRADA)).toMatchObject({ consultado: false, estado: "pendiente", motivo: "red" });
  });

  it("respuesta gigante -> pendiente sin interpretarla", async () => {
    const { adaptador } = adaptadorConRespuesta(sobre("Vigente") + " ".repeat(70 * 1024));
    expect(await adaptador.consultar(ENTRADA)).toMatchObject({ consultado: false, motivo: "respuesta_invalida" });
  });

  it("datos que no forman una expresion valida no llegan a la red (RFC/UUID/total invalidos o con intento de cerrar el CDATA)", async () => {
    const { adaptador, llamadas } = adaptadorConRespuesta(sobre("Vigente"));
    for (const malo of [
      { ...ENTRADA, rfcEmisor: "X" },
      { ...ENTRADA, folioFiscal: "no-es-uuid" },
      { ...ENTRADA, total: Number.NaN },
      { ...ENTRADA, rfcReceptor: "RRR010101RR1]]><x/>" },
    ]) {
      expect(await adaptador.consultar(malo)).toMatchObject({ consultado: false, estado: "pendiente", motivo: "datos_insuficientes" });
    }
    expect(llamadas).toHaveLength(0);
  });
});

describe("expresion impresa e interpretacion", () => {
  it("formato del total con 6 decimales y mayusculas", () => {
    expect(construirExpresionImpresa({ ...ENTRADA, rfcEmisor: "aaa010101aa1", total: 1234.5 })).toBe("?re=AAA010101AA1&rr=RRR010101RR1&tt=1234.500000&id=6129984C-4F5E-4A0F-9B7E-0D4D8A1B2C3D");
  });
  it("interpretarRespuestaSat tolera otro prefijo de namespace", () => {
    const xml = `<soap:Envelope><soap:Body><ConsultaResult><b:Estado>Vigente</b:Estado></ConsultaResult></soap:Body></soap:Envelope>`;
    expect(interpretarRespuestaSat(xml)).toMatchObject({ consultado: true, estado: "vigente" });
  });
});
