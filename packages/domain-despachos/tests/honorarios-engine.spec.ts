// D-32 -- motor de honorarios con el doble en memoria y un PAC falso con contador: generacion idempotente, timbrado concurrente (una sola llamada
// al PAC), sin PAC, sin desglose, fallos, y cancelacion con guardas.
import type { CfdiTimbrado, PacClient } from "@atiende/billing";
import { describe, expect, it } from "vitest";
import { InMemoryCarteraRepository } from "../src/cartera/index.ts";
import {
  HonorariosCancelacionPacError,
  HonorariosCancelacionPendienteError,
  HonorariosDatosInvalidosError,
  HonorariosEstadoInvalidoError,
  HonorariosNoEncontradoError,
  HonorariosNoTimbrableError,
  HonorariosPacNoConfiguradoError,
  HonorariosTimbradoFalloError,
  HonorariosTimbreNoRegistradoError,
  InMemoryHonorariosRepository,
  cancelarPrefactura,
  generarPrefacturasDelPeriodo,
  timbrarPrefactura,
  validarCancelacion,
} from "../src/honorarios/index.ts";
import type { HonorariosRepository, IgualaInput } from "../src/honorarios/index.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const PROP = "00000000-0000-0000-0000-0000000000b1";
const OTRA_PROP = "00000000-0000-0000-0000-0000000000b2";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const FICHA = { rfc: "RRR010101RR1", tipoPersona: "moral" as const, razonSocial: "Receptor Uno SA de CV", regimenesFiscales: ["601"], cpFiscal: "64000", periodicidad: "mensual" as const, responsableId: null };

const iguala = (extra: Partial<IgualaInput> = {}): IgualaInput => ({ concepto: "Iguala contable mensual", claveProdServ: "84111500", claveUnidad: "E48", montoBaseCentavos: 100_000, tasaIvaBp: 1600, retencionIsrBp: 0, retieneIvaDosTercios: false, diaEmision: 5, usoCfdi: "G03", activa: true, ...extra });

class FakePacClient implements PacClient {
  timbrados: { subtotal: number; referencia?: string; rfc: string }[] = [];
  cancelaciones: { id: string; motivo: string; folio?: string }[] = [];
  fallar: Error | null = null;
  totalExtra = 0;
  retraso = 0;
  respuestaCancelacion = "cancelado";
  fallarCancelacion = false;
  private n = 0;
  async timbrar(opts: Parameters<PacClient["timbrar"]>[0]): Promise<CfdiTimbrado> {
    this.timbrados.push({ subtotal: opts.subtotal, referencia: opts.referencia, rfc: opts.receptor.rfc });
    if (this.retraso) await new Promise((r) => setTimeout(r, this.retraso));
    if (this.fallar) throw this.fallar;
    this.n += 1;
    return { id: `pac-${this.n}`, uuid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.n).padStart(12, "0")}`, urlPdf: "https://pac.example/f.pdf", urlXml: "https://pac.example/f.xml", urlVerificacion: null, total: opts.subtotal * 1.16 + this.totalExtra };
  }
  async cancelar(id: string, motivo: string, folio?: string): Promise<{ estado: string }> {
    if (this.fallarCancelacion) throw new Error("boom");
    this.cancelaciones.push({ id, motivo, folio });
    return { estado: this.respuestaCancelacion };
  }
}

async function montar(opts: { conFicha?: boolean } = {}) {
  const cartera = new InMemoryCarteraRepository();
  cartera.sembrarCliente(ORG, "Cliente Uno", opts.conFicha === false ? undefined : FICHA, PROP);
  const repo = new InMemoryHonorariosRepository(cartera, () => ORG);
  const enSesion = <T>(fn: (r: HonorariosRepository) => Promise<T>) => fn(repo);
  const pac = new FakePacClient();
  const id = await repo.guardarIguala(PROP, null, iguala());
  await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
  const [pf] = (await repo.listarPrefacturas(PROP, "2026-07")).prefacturas;
  return { repo, enSesion, pac, igualaId: id, pf: pf! };
}

describe("generarPrefacturasDelPeriodo", () => {
  it("genera una prefactura por iguala activa, con el desglose y el receptor de la ficha", async () => {
    const { pf } = await montar();
    expect(pf).toMatchObject({ estado: "borrador", periodo: "2026-07", baseCentavos: 100_000, ivaCentavos: 16_000, totalCentavos: 116_000, fechaEmision: "2026-07-05", receptor: { rfc: "RRR010101RR1", regimenFiscal: "601", codigoPostal: "64000" }, usoCfdi: "G03" });
  });
  it("generar dos veces NO duplica", async () => {
    const { repo } = await montar();
    const r = await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
    expect(r).toMatchObject({ generadas: 0, yaExistian: 1, omitidas: [] });
    expect((await repo.listarPrefacturas(PROP, "2026-07")).prefacturas).toHaveLength(1);
  });
  it("un periodo nuevo genera otra; una iguala inactiva se salta; el periodo invalido se rechaza", async () => {
    const { repo } = await montar();
    await repo.guardarIguala(PROP, null, iguala({ concepto: "Iguala pausada", activa: false }));
    expect(await generarPrefacturasDelPeriodo(repo, PROP, "2026-08")).toMatchObject({ generadas: 1, yaExistian: 0 });
    await expect(generarPrefacturasDelPeriodo(repo, PROP, "2026-13")).rejects.toBeInstanceOf(HonorariosDatosInvalidosError);
  });
  it("un cliente sin ficha fiscal queda en omitidas con su motivo (no un error)", async () => {
    const { repo } = await montar({ conFicha: false });
    const r = await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
    expect(r.generadas).toBe(0);
    expect(r.omitidas).toHaveLength(1);
    expect(r.omitidas[0]!.motivo).toMatch(/ficha fiscal/);
  });
  it("no mezcla clientes: las igualas de otra property no se generan", async () => {
    const { repo } = await montar();
    expect((await repo.listarPrefacturas(OTRA_PROP, null)).prefacturas).toHaveLength(0);
  });
});

describe("timbrarPrefactura", () => {
  it("sin PAC configurado: error honesto, la prefactura sigue aprobada y NUNCA lleva UUID", async () => {
    const { repo, enSesion, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    await expect(timbrarPrefactura({ pac: null, enSesion }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosPacNoConfiguradoError);
    expect(await repo.obtenerPrefactura(PROP, pf.id)).toMatchObject({ estado: "aprobada", uuid: null, timbrandoEn: null });
    expect(repo.reservasGanadas.get(pf.id) ?? 0).toBe(0);
  });
  it("timbra una aprobada: llama al PAC con el SUBTOTAL (sin IVA), el receptor de la ficha y la referencia = id; guarda el UUID del PAC", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    const r = await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    expect(pac.timbrados).toEqual([{ subtotal: 1000, referencia: pf.id, rfc: "RRR010101RR1" }]);
    expect(r).toMatchObject({ yaTimbrada: false, totalNoCuadraConCobro: false, prefactura: { estado: "timbrada", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", pacId: "pac-1", urlPdf: "https://pac.example/f.pdf" } });
  });
  it("dos 'timbrar' CONCURRENTES solo llaman una vez al PAC", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    pac.retraso = 20;
    await repo.aprobar(PROP, pf.id);
    const resultados = await Promise.allSettled([timbrarPrefactura({ pac, enSesion }, PROP, pf.id), timbrarPrefactura({ pac, enSesion }, PROP, pf.id)]);
    expect(pac.timbrados).toHaveLength(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(repo.reservasGanadas.get(pf.id)).toBe(1);
    expect((await repo.obtenerPrefactura(PROP, pf.id))?.estado).toBe("timbrada");
  });
  it("timbrar una ya timbrada es idempotente: no vuelve a llamar al PAC", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    const r = await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    expect(r.yaTimbrada).toBe(true);
    expect(pac.timbrados).toHaveLength(1);
  });
  it("un borrador, una cancelada o una prefactura ajena no se timbran y no tocan al PAC", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await expect(timbrarPrefactura({ pac, enSesion }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    await expect(timbrarPrefactura({ pac, enSesion }, OTRA_PROP, pf.id)).rejects.toBeInstanceOf(HonorariosNoEncontradoError);
    await repo.cancelar(PROP, pf.id, { motivo: "02", folioSustitucion: null, acusePac: false });
    await expect(timbrarPrefactura({ pac, enSesion }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    expect(pac.timbrados).toHaveLength(0);
  });
  it("SIN DESGLOSE no se timbra: una prefactura que no cuadra no reserva ni llama al PAC", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    const roto = { ...(await repo.obtenerPrefactura(PROP, pf.id))!, totalCentavos: 1 };
    const sesionRota = <T>(fn: (r: HonorariosRepository) => Promise<T>) => fn(new Proxy(repo, { get: (t, k) => (k === "obtenerPrefactura" ? async () => roto : (t as never)[k]) }) as HonorariosRepository);
    await expect(timbrarPrefactura({ pac, enSesion: sesionRota }, PROP, pf.id)).rejects.toMatchObject({ name: "HonorariosNoTimbrableError", codigo: "desglose_no_cuadra" });
    expect(pac.timbrados).toHaveLength(0);
    expect(repo.reservasGanadas.get(pf.id) ?? 0).toBe(0);
    void enSesion;
  });
  it("una prefactura con retenciones no se timbra (NO VERIFICADO D-34) y se queda aprobada", async () => {
    const { repo, enSesion, pac } = await montar();
    await repo.guardarIguala(PROP, null, iguala({ concepto: "Iguala con retenciones", retencionIsrBp: 1000, retieneIvaDosTercios: true }));
    await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
    const conRet = (await repo.listarPrefacturas(PROP, "2026-07")).prefacturas.find((p) => p.retencionIsrCentavos > 0)!;
    await repo.aprobar(PROP, conRet.id);
    await expect(timbrarPrefactura({ pac, enSesion }, PROP, conRet.id)).rejects.toBeInstanceOf(HonorariosNoTimbrableError);
    expect((await repo.obtenerPrefactura(PROP, conRet.id))?.estado).toBe("aprobada");
    expect(pac.timbrados).toHaveLength(0);
  });
  it("si el PAC falla: la prefactura queda fallida con un CODIGO corto (no el mensaje crudo), se avisa y se puede reintentar", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    const avisos: string[] = [];
    pac.fallar = new Error("RFC receptor RRR010101RR1 invalido en el SAT");
    await repo.aprobar(PROP, pf.id);
    await expect(timbrarPrefactura({ pac, enSesion, alFallar: async (_p, codigo) => void avisos.push(codigo) }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosTimbradoFalloError);
    expect(await repo.obtenerPrefactura(PROP, pf.id)).toMatchObject({ estado: "fallida", errorTimbrado: "pac_error", uuid: null, timbrandoEn: null });
    expect(avisos).toEqual(["pac_error"]);
    pac.fallar = null;
    const r = await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    expect(r.prefactura.estado).toBe("timbrada");
    expect(pac.timbrados).toHaveLength(2);
  });
  it("un codigo de error del PAC con forma de codigo se conserva", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    pac.fallar = Object.assign(new Error("x"), { code: "receptor_invalido" });
    await expect(timbrarPrefactura({ pac, enSesion }, PROP, pf.id)).rejects.toMatchObject({ codigo: "receptor_invalido" });
  });
  it("si el PAC timbro pero no se pudo guardar el resultado: error con el UUID, sin reintento ciego", async () => {
    const { repo, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    let llamadas = 0;
    const sesion = <T>(fn: (r: HonorariosRepository) => Promise<T>) => {
      llamadas += 1;
      const r = new Proxy(repo, { get: (t, k) => (k === "registrarTimbre" ? async () => { throw new Error("db caida"); } : (t as never)[k]) }) as HonorariosRepository;
      return fn(r);
    };
    await expect(timbrarPrefactura({ pac, enSesion: sesion }, PROP, pf.id)).rejects.toMatchObject({ name: "HonorariosTimbreNoRegistradoError", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" });
    expect(HonorariosTimbreNoRegistradoError).toBeDefined();
    expect(llamadas).toBeGreaterThan(0);
    // sigue 'timbrando': un segundo intento inmediato NO llama al PAC otra vez
    await expect(timbrarPrefactura({ pac, enSesion: <T>(fn: (r: HonorariosRepository) => Promise<T>) => fn(repo) }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    expect(pac.timbrados).toHaveLength(1);
  });
  it("un total del CFDI distinto al cobrado se guarda pero se AVISA (el CFDI ya existe ante el SAT)", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    pac.totalExtra = 5;
    await repo.aprobar(PROP, pf.id);
    expect(await timbrarPrefactura({ pac, enSesion }, PROP, pf.id)).toMatchObject({ totalNoCuadraConCobro: true, prefactura: { estado: "timbrada" } });
  });
  it("una reserva vieja (timbrando > 15 min) se reclama; una reciente no", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    expect(await repo.reservarTimbrado(PROP, pf.id, 900)).toBe(true);
    expect(await repo.reservarTimbrado(PROP, pf.id, 900)).toBe(false);
    repo.ahora = () => Date.now() + 16 * 60_000;
    // El motor no reclama una reserva viva por su cuenta (estado `timbrando`): la reclamacion es de la base/doble.
    await expect(timbrarPrefactura({ pac, enSesion }, PROP, pf.id)).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    expect(await repo.reservarTimbrado(PROP, pf.id, 900)).toBe(true);
  });
});

describe("cancelarPrefactura", () => {
  it("validarCancelacion: motivo 01-04, el 01 exige el folio de sustitucion y los demas no lo admiten", () => {
    expect(validarCancelacion({ motivo: "02" })).toEqual({ motivo: "02", folioSustitucion: null });
    expect(validarCancelacion({ motivo: "01", folioSustitucion: U2.toUpperCase() })).toEqual({ motivo: "01", folioSustitucion: U2 });
    for (const malo of [{ motivo: "05" }, { motivo: 1 }, {}, { motivo: "01" }, { motivo: "01", folioSustitucion: "no-uuid" }, { motivo: "02", folioSustitucion: U2 }]) {
      expect(() => validarCancelacion(malo as Record<string, unknown>)).toThrow(HonorariosDatosInvalidosError);
    }
  });
  it("borrador, aprobada y fallida se cancelan sin PAC (nunca llegaron a el)", async () => {
    const { repo, enSesion, pf } = await montar();
    const c = await cancelarPrefactura({ pac: null, enSesion }, PROP, pf.id, { motivo: "03", folioSustitucion: null });
    expect(c).toMatchObject({ estado: "cancelada", motivoCancelacion: "03" });
    expect(c.canceladaEn).not.toBeNull();
    void repo;
  });
  it("una timbrada se cancela ANTE EL PAC (con el id del PAC, el motivo y el folio) y luego en la base", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    const t = await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    const c = await cancelarPrefactura({ pac, enSesion }, PROP, pf.id, { motivo: "01", folioSustitucion: U1 });
    expect(pac.cancelaciones).toEqual([{ id: "pac-1", motivo: "01", folio: U1 }]);
    expect(c).toMatchObject({ estado: "cancelada", motivoCancelacion: "01", folioSustitucion: U1, uuid: t.prefactura.uuid });
  });
  it("una timbrada sin PAC configurado NO se cancela (503 honesto) y sigue timbrada", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    await expect(cancelarPrefactura({ pac: null, enSesion }, PROP, pf.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosPacNoConfiguradoError);
    expect((await repo.obtenerPrefactura(PROP, pf.id))?.estado).toBe("timbrada");
  });
  it("si el PAC falla o el SAT aun no confirma, la prefactura sigue timbrada", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    await timbrarPrefactura({ pac, enSesion }, PROP, pf.id);
    pac.fallarCancelacion = true;
    await expect(cancelarPrefactura({ pac, enSesion }, PROP, pf.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosCancelacionPacError);
    pac.fallarCancelacion = false;
    pac.respuestaCancelacion = "en_proceso";
    await expect(cancelarPrefactura({ pac, enSesion }, PROP, pf.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosCancelacionPendienteError);
    expect((await repo.obtenerPrefactura(PROP, pf.id))?.estado).toBe("timbrada");
  });
  it("guardas: dos veces, con un timbrado en curso y de otra property se rechazan", async () => {
    const { repo, enSesion, pac, pf } = await montar();
    await cancelarPrefactura({ pac, enSesion }, PROP, pf.id, { motivo: "02", folioSustitucion: null });
    await expect(cancelarPrefactura({ pac, enSesion }, PROP, pf.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    await expect(cancelarPrefactura({ pac, enSesion }, OTRA_PROP, pf.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosNoEncontradoError);
    await repo.guardarIguala(PROP, null, iguala({ concepto: "Otra iguala" }));
    await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
    const otra = (await repo.listarPrefacturas(PROP, "2026-07")).prefacturas.find((p) => p.estado === "borrador")!;
    await repo.aprobar(PROP, otra.id);
    await repo.reservarTimbrado(PROP, otra.id, 900);
    await expect(cancelarPrefactura({ pac, enSesion }, PROP, otra.id, { motivo: "02", folioSustitucion: null })).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
  });
});

describe("InMemoryHonorariosRepository (reglas de la 023)", () => {
  it("una iguala con prefacturas no se elimina; sin ellas si; el tope de 50 por cliente", async () => {
    const { repo, igualaId } = await montar();
    await expect(repo.eliminarIguala(PROP, igualaId)).rejects.toBeInstanceOf(HonorariosEstadoInvalidoError);
    const sola = await repo.guardarIguala(PROP, null, iguala({ concepto: "Sin prefacturas" }));
    await repo.eliminarIguala(PROP, sola);
    for (let i = 0; i < 49; i += 1) await repo.guardarIguala(PROP, null, iguala({ concepto: `Iguala ${i}` }));
    await expect(repo.guardarIguala(PROP, null, iguala())).rejects.toMatchObject({ name: "HonorariosTopeExcedidoError" });
  });
  it("la base sin migrar: lecturas vacias 'no_disponible' y escrituras con error de dominio", async () => {
    const { repo } = await montar();
    repo.disponible = false;
    expect(await repo.listarIgualas(PROP)).toEqual({ estado: "no_disponible", igualas: [] });
    expect(await repo.listarPrefacturas(PROP, null)).toEqual({ estado: "no_disponible", prefacturas: [] });
    await expect(repo.guardarIguala(PROP, null, iguala())).rejects.toMatchObject({ name: "HonorariosNoDisponiblesError" });
  });
  it("el UUID fiscal es unico por organizacion", async () => {
    const { repo, pf } = await montar();
    await repo.aprobar(PROP, pf.id);
    await repo.reservarTimbrado(PROP, pf.id, 900);
    await repo.registrarTimbre(PROP, pf.id, { uuid: U1, pacId: "p1", urlPdf: null, urlXml: null });
    await repo.guardarIguala(PROP, null, iguala({ concepto: "Segunda" }));
    await generarPrefacturasDelPeriodo(repo, PROP, "2026-07");
    const otra = (await repo.listarPrefacturas(PROP, "2026-07")).prefacturas.find((p) => p.estado === "borrador")!;
    await repo.aprobar(PROP, otra.id);
    await repo.reservarTimbrado(PROP, otra.id, 900);
    await expect(repo.registrarTimbre(PROP, otra.id, { uuid: U1.toUpperCase(), pacId: "p2", urlPdf: null, urlXml: null })).rejects.toMatchObject({ name: "HonorariosDuplicadoError" });
  });
});
