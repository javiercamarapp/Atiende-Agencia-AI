// D-P3-14: cron diario de las polizas del periodo. Doble en memoria con las reglas de la migracion 026 (candidatos y registro). Cubre: genera la poliza de lo
// clasificado y limpio, idempotencia (la segunda corrida no duplica ni avisa otra vez), lo que NO se contabiliza (revision pendiente, excluido, cancelado,
// clasificacion dudosa, periodo cerrado), el fallo aislado por CFDI, el aviso por cliente sin PII, el presupuesto de tiempo y la base sin migrar.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryClasificacionRepository,
  InMemoryDespachosRepository,
  InMemoryLibroRepository,
  polizasPeriodoDesdeRepositorios,
} from "@atiende/domain-despachos";
import type { InMemoryPolizasPeriodoRepository, NewInvoiceInput } from "@atiende/domain-despachos";
import { inicioDeVentana, runPolizasPeriodoSistema } from "../src/jobs/despachos/polizas-periodo.ts";
import type { WithUnidadPolizasPeriodo } from "../src/jobs/despachos/polizas-periodo.ts";
import type { NotificacionCron } from "../src/jobs/despachos/cron-comun.ts";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "@atiende/domain-despachos";

const ORG = "org-1";
const PROP = "prop-1";
const HOY = "2026-07-20";

let despachos: InMemoryDespachosRepository;
let libro: InMemoryLibroRepository;
let clasificacion: InMemoryClasificacionRepository;
let repo: InMemoryPolizasPeriodoRepository;
let avisos: NotificacionCron[];
let unidades: number;

beforeEach(() => {
  despachos = new InMemoryDespachosRepository();
  libro = new InMemoryLibroRepository();
  clasificacion = new InMemoryClasificacionRepository();
  repo = polizasPeriodoDesdeRepositorios({ propiedades: () => [{ organizationId: ORG, propertyId: PROP }], despachos, libro, clasificacion });
  avisos = [];
  unidades = 0;
});

const withUnidad: WithUnidadPolizasPeriodo = async (fn) => {
  unidades += 1;
  return fn({ repo, notificar: async (n) => void avisos.push(n) });
};

async function cfdi(parcial: Partial<NewInvoiceInput> = {}, clasif: { categoria: string; confianza: number; metodo?: "reglas" | "claveprodserv" | "correccion"; empate?: boolean } | null = { categoria: "servicios_profesionales", confianza: 0.8 }) {
  const i = await despachos.insertInvoice({
    organizationId: ORG, propertyId: PROP, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: "PPP010101PP1", rfcReceptor: "CLI010101CL1", emisorNombre: null, subtotal: 1000, total: 1160, iva: 160, descuento: 0, categoria: "sin_clasificar",
    valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { proveedoresReportables: [], reportable: false } as NewInvoiceInput["diot"], fecha: "2026-07-10", direccion: "recibido", metodoPago: "PUE", moneda: "MXN",
    subtotalCentavos: 100000, descuentoCentavos: 0, totalCentavos: 116000, ivaTrasladadoCentavos: 16000, ...parcial,
  });
  if (clasif) await clasificacion.registrar(PROP, i.id, { categoria: clasif.categoria, confianza: clasif.confianza, metodo: clasif.metodo ?? "reglas", razon: null, cuenta: null, empate: clasif.empate ?? false });
  return i;
}
const corre = (opciones: Parameters<typeof runPolizasPeriodoSistema>[1] = {}) => runPolizasPeriodoSistema(withUnidad, { hoy: HOY, ...opciones });

describe("runPolizasPeriodoSistema", () => {
  it("la ventana es el mes en curso y los dos anteriores", () => {
    expect(inicioDeVentana("2026-07-20", 2)).toBe("2026-05-01");
    expect(inicioDeVentana("2026-01-05", 2)).toBe("2025-11-01");
  });

  it("registra la poliza de cada CFDI clasificado y limpio (egreso con IVA acreditable), siembra el catalogo y avisa UNA vez por cliente con solo la cantidad", async () => {
    const a = await cfdi();
    const b = await cfdi({ fecha: "2026-07-12" });
    const r = await corre();
    expect(r).toMatchObject({ estado: "ok", candidatos: 2, generadas: 2, omitidas: 0, noArmables: 0, clientesAvisados: 1, cortadoPorTiempo: false, fallidos: [] });
    const polizas = await libro.polizasDeCfdi(PROP, [a.id, b.id]);
    expect(polizas.size).toBe(2);
    expect((await libro.listarCuentas(PROP)).datos.length).toBeGreaterThan(30);
    expect(avisos).toEqual([{ evento: "despachos.libro.polizas_generadas", organizationId: ORG, propertyId: PROP, clave: `${PROP}:${HOY}`, parametros: { cantidad: 2 }, entidadTipo: "property", entidadId: PROP }]);
    expect(JSON.stringify(avisos)).not.toMatch(/PPP010101PP1|CLI010101CL1/);
  });

  it("es idempotente: la segunda corrida no encuentra candidatos, no duplica y no avisa de nuevo", async () => {
    await cfdi();
    await corre();
    const segunda = await corre();
    expect(segunda).toMatchObject({ candidatos: 0, generadas: 0, clientesAvisados: 0 });
    expect(avisos).toHaveLength(1);
  });

  it("una corrida usa una transaccion por CFDI y una por cliente avisado (mas la lectura de candidatos)", async () => {
    await cfdi();
    await cfdi();
    await corre();
    expect(unidades).toBe(1 + 2 + 1);
  });

  it("NO contabiliza: revision pendiente, excluido por revision rechazada, cancelado, clasificacion dudosa (0.65 con umbral 0.7, empate, otros), sin clasificar", async () => {
    const pendiente = await cfdi();
    await despachos.createReview({ organizationId: ORG, propertyId: PROP, invoiceId: pendiente.id, reason: "x" });
    const rechazado = await cfdi();
    const rev = await despachos.createReview({ organizationId: ORG, propertyId: PROP, invoiceId: rechazado.id, reason: "x" });
    await despachos.resolveReview(PROP, rev.id, "u1", "rechazado", null);
    await cfdi();
    const cancelado = await cfdi();
    await despachos.registrarEstadoSatInvoice(PROP, cancelado.id, "cancelado");
    await cfdi({}, { categoria: "servicios_profesionales", confianza: 0.65 });
    await cfdi({}, { categoria: "servicios_profesionales", confianza: 0.45, empate: true });
    await cfdi({}, { categoria: "otros", confianza: 0.3 });
    await cfdi({}, null);
    const r = await corre();
    // Solo el CFDI limpio y bien clasificado es candidato.
    expect(r).toMatchObject({ candidatos: 1, generadas: 1 });
  });

  it("una clasificacion hecha por una persona (correccion) se contabiliza aunque el umbral del despacho sea 1", async () => {
    await clasificacion.guardarConfig(PROP, ORG, { umbral: 1 });
    await cfdi({}, { categoria: "seguros", confianza: 0.95, metodo: "correccion" });
    await cfdi({}, { categoria: "servicios_profesionales", confianza: 0.95 });
    expect(await corre()).toMatchObject({ candidatos: 1, generadas: 1 });
  });

  it("periodo cerrado: se omite sin escribir; abierto del mismo cliente si se contabiliza", async () => {
    const cerrado = await cfdi({ fecha: "2026-06-10" });
    const abierto = await cfdi({ fecha: "2026-07-10" });
    // Cerrar junio: el periodo de cierre (que lee la funcion de candidatos) y el del libro (que rechaza el registro).
    const { periodo } = await despachos.insertPeriodoCierre({ organizationId: ORG, propertyId: PROP, anio: 2026, mes: 6, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    await despachos.updatePeriodoCierre({ ...periodo, status: "closed" });
    libro.periodosCerrados.add(`${PROP}|2026-06`);
    const r = await corre();
    expect((await libro.polizasDeCfdi(PROP, [cerrado.id])).size).toBe(0);
    expect((await libro.polizasDeCfdi(PROP, [abierto.id])).size).toBe(1);
    expect(r.fallidos).toEqual([]);
  });

  it("lo que no se puede armar sin inventar (moneda extranjera, retenciones) no entra; lo que la base deja pasar pero TypeScript no arma cuenta como noArmables", async () => {
    await cfdi({ moneda: "USD" });
    await cfdi({ isrRetenidoCentavos: 1000 });
    const ok = await cfdi();
    const r = await corre();
    expect(r.generadas).toBe(1);
    expect((await libro.polizasDeCfdi(PROP, [ok.id])).size).toBe(1);
    expect(r.noArmables).toBe(2);
  });

  it("un CFDI que falla no impide los demas ni el aviso: queda en fallidos con un mensaje corto y sin PII", async () => {
    const mala = await cfdi();
    const buena = await cfdi({ fecha: "2026-07-11" });
    repo.fallarEn.add(mala.id);
    const r = await corre();
    expect(r.generadas).toBe(1);
    expect(r.fallidos).toHaveLength(1);
    expect(r.fallidos[0]).toMatchObject({ invoiceId: mala.id, propertyId: PROP });
    expect((await libro.polizasDeCfdi(PROP, [buena.id])).size).toBe(1);
    expect(avisos).toHaveLength(1);
  });

  it("el presupuesto de tiempo corta la corrida y lo pendiente queda para el dia siguiente", async () => {
    await cfdi();
    await cfdi();
    await cfdi();
    let t = 0;
    const r = await corre({ presupuestoMs: 10, ahora: () => (t += 8) });
    expect(r.cortadoPorTiempo).toBe(true);
    expect(r.generadas).toBeLessThan(3);
    const siguiente = await corre();
    expect(r.generadas + siguiente.generadas).toBe(3);
  });

  it("base sin migrar: no_disponible, nada contabilizado y sin aviso", async () => {
    await cfdi();
    repo.disponible = false;
    expect(await corre()).toMatchObject({ estado: "no_disponible", candidatos: 0, generadas: 0 });
    expect(avisos).toEqual([]);
  });
});
