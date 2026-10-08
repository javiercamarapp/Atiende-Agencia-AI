// CFO-05 · el repositorio en memoria tiene la MISMA semántica que la SQL (alcance, rangos, «No asignado», errores, base sin migrar, versionado
// de costos, importación SR idempotente y sin datos de cliente). Si el doble diverge de la SQL, las pruebas de servicio y de API no valen.
import { describe, expect, it } from "vitest";
import { CfoNoDisponibleError, CfoParametroInvalidoError, CfoSinAccesoError } from "../src/cfo/repositorio.ts";
import { InMemoryCfoRepository } from "../src/cfo/repositorio-memoria.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const [S1, S2, S3] = SUCURSALES_PM_SINTETICAS.map((s) => s.propertyId) as [string, string, string];
const TODAS = [S1, S2, S3];
const R = { desde: "2026-09-01", hasta: "2026-09-30" };
const HUELLA = "a".repeat(64);

function repo(op: Partial<ConstructorParameters<typeof InMemoryCfoRepository>[0]> = {}) {
  const d = generarDatasetSintetico();
  return new InMemoryCfoRepository({
    dataset: { ventasDiarias: d.ventasDiarias, cortesias: d.cortesias, ventasHora: d.ventasHora, productos: d.productos, agenteDiario: d.agenteDiario, comandasPos: d.comandasPos },
    sucursales: TODAS,
    ...op,
  });
}

describe("alcance y rango (espejo de cfo_resolver_sucursales / cfo_validar_rango)", () => {
  it("null = todas las permitidas; el renglón «No asignado» solo sale con null (o con una lista que cubre TODAS) y organización completa", async () => {
    const r = repo();
    const todas = await r.agenteDiario({ organizationId: ORG, propertyIds: null }, { desde: "2026-01-01", hasta: "2026-12-31" });
    expect(todas.filas.some((f) => f.propertyId === null)).toBe(true);
    const una = await r.agenteDiario({ organizationId: ORG, propertyIds: [S1] }, { desde: "2026-01-01", hasta: "2026-12-31" });
    expect(una.filas.every((f) => f.propertyId === S1)).toBe(true);
    const cubreTodas = await r.agenteDiario({ organizationId: ORG, propertyIds: TODAS }, { desde: "2026-01-01", hasta: "2026-12-31" });
    expect(cubreTodas.filas.some((f) => f.propertyId === null)).toBe(true);
    const acotado = repo({ permitidas: [S1], organizacionCompleta: false });
    const suyo = await acotado.agenteDiario({ organizationId: ORG, propertyIds: null }, { desde: "2026-01-01", hasta: "2026-12-31" });
    expect(suyo.filas.length).toBeGreaterThan(0);
    expect(suyo.filas.every((f) => f.propertyId === S1)).toBe(true);
  });

  it("sucursal ajena, de otra organización o inexistente: el MISMO CfoSinAccesoError", async () => {
    const acotado = repo({ permitidas: [S1], organizacionCompleta: false });
    await expect(acotado.ventasDiarias({ organizationId: ORG, propertyIds: [S2] }, R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
    await expect(repo().ventasDiarias({ organizationId: ORG, propertyIds: ["00000000-0000-4000-8000-00000000ffff"] }, R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
  });

  it("rango > 400 días, invertido o lista vacía/mayor a 500 -> CfoParametroInvalidoError", async () => {
    const r = repo();
    const p = { organizationId: ORG, propertyIds: null };
    await expect(r.ventasDiarias(p, { desde: "2026-01-01", hasta: "2027-02-05" }, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError); // 401 días
    await expect(r.ventasDiarias(p, { desde: "2026-01-01", hasta: "2027-02-04" }, 50)).resolves.toMatchObject({ disponible: true }); // 400 días exactos
    await expect(r.ventasDiarias(p, { desde: "2026-09-30", hasta: "2026-09-01" }, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.ventasDiarias({ organizationId: ORG, propertyIds: [] }, R, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.ventasDiarias({ organizationId: ORG, propertyIds: Array.from({ length: 501 }, () => S1) }, R, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
  });

  it("base sin migrar por bloque: lecturas disponible=false, escrituras CfoNoDisponibleError", async () => {
    const sin081 = repo({ migraciones: { m081: false } });
    expect((await sin081.ventasDiarias({ organizationId: ORG, propertyIds: null }, R, 50)).disponible).toBe(false);
    expect((await sin081.agenteDiario({ organizationId: ORG, propertyIds: null }, R)).disponible).toBe(true);
    const sin083 = repo({ migraciones: { m083: false } });
    expect((await sin083.configLeer(ORG)).disponible).toBe(false);
    await expect(sin083.configGuardar(ORG, { iva_pct: 16 })).rejects.toBeInstanceOf(CfoNoDisponibleError);
  });

  it("pedidosDetalle: filtro de lista cerrada (otra llave -> 22023) y cursor mal formado -> 22023", async () => {
    const r = repo();
    const p = { organizationId: ORG, propertyIds: null };
    await expect(r.pedidosDetalle(p, R, { telefono: "x" } as never, 10, null, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.pedidosDetalle(p, R, {}, 10, "no-es-cursor", 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
  });
});

describe("configuración (cfo_config_guardar)", () => {
  it("guarda, valida rangos y llaves, exige organización completa y deja bitácora solo si algo cambió", async () => {
    const r = repo();
    expect((await r.configLeer(ORG)).configurada).toBe(false);
    await r.configGuardar(ORG, { iva_pct: 8, comision_terminal_pct: 2.5 });
    const l = await r.configLeer(ORG);
    expect(l.configurada).toBe(true);
    expect(l.config.ivaPct).toBe(8);
    expect(l.config.comisionTerminalPct).toBe(2.5);
    expect(r.auditoria.map((a) => a.action)).toEqual(["cfo.config_actualizada"]);
    await r.configGuardar(ORG, { iva_pct: 8 }); // sin cambios
    expect(r.auditoria).toHaveLength(1);
    await r.configGuardar(ORG, { comision_terminal_pct: null });
    expect((await r.configLeer(ORG)).config.comisionTerminalPct).toBeNull();
    await expect(r.configGuardar(ORG, { iva_pct: 31 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.configGuardar(ORG, { perdido_dias: 731 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.configGuardar(ORG, { activo_dias: 365 })).rejects.toBeInstanceOf(CfoParametroInvalidoError); // activo >= perdido (120)
    await expect(r.configGuardar(ORG, { frecuente_n: 2.5 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.configGuardar(ORG, { telefono: 1 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    expect((await r.configLeer(ORG)).config.ivaPct).toBe(8); // lo inválido no se aplicó
    await expect(repo({ organizacionCompleta: false }).configGuardar(ORG, { iva_pct: 10 })).rejects.toBeInstanceOf(CfoSinAccesoError);
  });
});

describe("costos capturados (versionado y alcance)", () => {
  const base = { organizationId: ORG, propertyId: S1, mes: "2026-09-01", concepto: "nomina" as const, montoCentavos: 5_000_000, pct: null, nota: null };

  it("cada guardado crea una versión nueva y reemplaza la vigente; el historial lo muestra", async () => {
    const r = repo();
    await r.costoGuardar(base);
    await r.costoGuardar({ ...base, montoCentavos: 5_200_000, nota: "ajuste" });
    const vigentes = await r.costosLeer({ organizationId: ORG, propertyIds: [S1] }, "2026-09-01", "2026-09-30");
    expect(vigentes.filas).toHaveLength(1);
    expect(vigentes.filas[0]).toMatchObject({ montoCentavos: 5_200_000, nota: "ajuste" });
    const h = await r.costoHistorial(ORG, S1, "2026-09-01", "nomina");
    expect(h.filas.map((x) => [x.version, x.montoCentavos, x.vigente])).toEqual([[1, 5_000_000, false], [2, 5_200_000, true]]);
    expect(r.auditoria.filter((a) => a.action === "cfo.costo_capturado")).toHaveLength(2);
  });

  it("validaciones: monto xor pct, food_cost_objetivo_pct exige pct, mes día 1, rangos, nota ≤ 300", async () => {
    const r = repo();
    await expect(r.costoGuardar({ ...base, pct: 10 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, montoCentavos: null, pct: null })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, concepto: "food_cost_objetivo_pct" })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, montoCentavos: null, pct: 32 })).rejects.toBeInstanceOf(CfoParametroInvalidoError); // pct en un concepto de monto
    await expect(r.costoGuardar({ ...base, concepto: "food_cost_objetivo_pct", montoCentavos: null, pct: 32 })).resolves.toBeTruthy();
    await expect(r.costoGuardar({ ...base, mes: "2026-09-15" })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, mes: "2019-12-01" })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, montoCentavos: -1 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, concepto: "x" as never })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.costoGuardar({ ...base, nota: "x".repeat(301) })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
  });

  it("el costo de la organización (propertyId null) exige alcance de organización completa; sucursal ajena -> 42501; 'No asignado' no sale con una lista", async () => {
    const org = repo();
    await org.costoGuardar({ ...base, propertyId: null, concepto: "renta" });
    expect((await org.costosLeer({ organizationId: ORG, propertyIds: null }, "2026-09-01", "2026-09-30")).filas.some((c) => c.propertyId === null)).toBe(true);
    expect((await org.costosLeer({ organizationId: ORG, propertyIds: [S1] }, "2026-09-01", "2026-09-30")).filas.some((c) => c.propertyId === null)).toBe(false);
    const acotado = repo({ permitidas: [S1], organizacionCompleta: false });
    await expect(acotado.costoGuardar({ ...base, propertyId: null })).rejects.toBeInstanceOf(CfoSinAccesoError);
    await expect(acotado.costoGuardar({ ...base, propertyId: S2 })).rejects.toBeInstanceOf(CfoSinAccesoError);
    await expect(acotado.costoGuardar(base)).resolves.toBeTruthy();
  });
});

describe("importación de SoftRestaurant (sr_importar)", () => {
  const resumen = [
    { dia_negocio: "2026-09-10", tipo_servicio: "domicilio", tickets: 20, bruta_centavos: 300_000, neta_centavos: 280_000, descuento_centavos: 20_000 },
    { dia_negocio: "2026-09-10", tipo_servicio: "comedor", tickets: 30, bruta_centavos: 600_000, neta_centavos: 600_000 },
  ];
  const entrada = (extra: Record<string, unknown> = {}) => ({ organizationId: ORG, propertyId: S1, huella: HUELLA, tipo: "resumen_servicio" as const, nombreArchivo: "ventas.csv", renglones: resumen, ...extra });

  it("importa, es idempotente por huella (no duplica) y deja bitácora UNA sola vez", async () => {
    const r = repo();
    const a = await r.srImportar(entrada());
    expect(a).toMatchObject({ creado: true, aceptados: 2, rechazados: 0 });
    const b = await r.srImportar(entrada());
    expect(b).toMatchObject({ creado: false, loteId: a.loteId, aceptados: 2 });
    const l = await r.srResumenLeer({ organizationId: ORG, propertyIds: [S1] }, R);
    expect(l.filas).toHaveLength(2);
    expect(l.filas.reduce((s, f) => s + f.netaCentavos, 0)).toBe(880_000);
    expect(r.auditoria.filter((x) => x.action === "cfo.sr_importado")).toHaveLength(1);
    expect((await r.srLotes({ organizationId: ORG, propertyIds: [S1] }, 10)).filas).toHaveLength(1);
    expect((await r.srCobertura({ organizationId: ORG, propertyIds: [S1] })).filas[0]).toMatchObject({ diasConDato: 1, diaMin: "2026-09-10" });
  });

  it("un archivo con columna de cliente/teléfono se rechaza COMPLETO (22023) y no escribe nada", async () => {
    const r = repo();
    await expect(r.srImportar(entrada({ renglones: [{ ...resumen[0], telefono: "9990000000" }] }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.srImportar(entrada({ renglones: [{ ...resumen[0], cliente: "Ana" }] }))).rejects.toThrow(/llaves no permitidas/);
    expect((await r.srResumenLeer({ organizationId: ORG, propertyIds: [S1] }, R)).filas).toHaveLength(0);
    expect(r.auditoria).toHaveLength(0);
  });

  it("renglones inválidos se rechazan por renglón; si ninguno es válido no se crea lote", async () => {
    const r = repo();
    const parcial = await r.srImportar(entrada({ renglones: [resumen[0], { ...resumen[1], tipo_servicio: "barra" }] }));
    expect(parcial).toMatchObject({ creado: true, aceptados: 1, rechazados: 1 });
    expect(parcial.errores).toEqual([{ renglon: 2, campo: "tipo_servicio", motivo: "tipo de servicio desconocido" }]);
    const ninguno = await r.srImportar(entrada({ huella: "b".repeat(64), renglones: [{ dia_negocio: "mal", tipo_servicio: "domicilio" }] }));
    expect(ninguno).toMatchObject({ loteId: null, creado: false, aceptados: 0, rechazados: 1 });
  });

  it("topes: 2 000 renglones de resumen / 20 000 de cuentas; huella, tipo y nombre inválidos; sucursal ajena", async () => {
    const r = repo();
    await expect(r.srImportar(entrada({ renglones: Array.from({ length: 2001 }, () => resumen[0]) }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.srImportar(entrada({ renglones: [] }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.srImportar(entrada({ huella: "XYZ" }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.srImportar(entrada({ tipo: "otro" }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.srImportar(entrada({ nombreArchivo: "../etc/passwd" }))).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(repo({ permitidas: [S2], organizacionCompleta: false }).srImportar(entrada())).rejects.toBeInstanceOf(CfoSinAccesoError);
  });

  it("la misma huella para OTRA sucursal se rechaza (22023)", async () => {
    const r = repo();
    await r.srImportar(entrada());
    await expect(r.srImportar(entrada({ propertyId: S2 }))).rejects.toThrow(/otra sucursal/);
  });
});

describe("exportaciones (cfo_registrar_exportacion)", () => {
  it("registra la bitácora con vista/formato y valida", async () => {
    const r = repo();
    await r.registrarExportacion({ organizationId: ORG, propertyIds: null, vista: "resumen", formato: "pdf", desde: R.desde, hasta: R.hasta });
    expect(r.auditoria).toEqual([{ action: "cfo.exportacion", detalle: { vista: "resumen", formato: "pdf", desde: R.desde, hasta: R.hasta, todas: true } }]);
    await expect(r.registrarExportacion({ organizationId: ORG, propertyIds: null, vista: "otra" as never, formato: "pdf", desde: R.desde, hasta: R.hasta })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(r.registrarExportacion({ organizationId: ORG, propertyIds: null, vista: "resumen", formato: "csv" as never, desde: R.desde, hasta: R.hasta })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
  });
});
