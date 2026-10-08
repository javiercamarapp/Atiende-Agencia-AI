// CFO-09 · alertas de hallazgos del CFO al dueño: umbral, dedupe (dos llamadas = una alerta), tope de 5, día de negocio por zona, base sin migrar,
// canal externo solo en horario y fallos aislados. Dataset SINTETICO. Reloj fijo: miercoles 12:00 de Merida.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  TOPE_ALERTAS_POR_ORG_DIA,
  UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO,
  alertarHallazgosCfo,
  dentroDeHorarioExterno,
  horaLocal,
  seleccionarAlertas,
  zonaDeOrganizacion,
  type AlertaCfo,
  type SucursalAlerta,
} from "../src/cfo/alertas.ts";
import type { Hallazgo, TipoHallazgo, Urgencia } from "../src/cfo/hallazgos.ts";
import { InMemoryCfoRepository, type OpcionesCfoMemoria } from "../src/cfo/repositorio-memoria.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const MIERCOLES_MERIDA = new Date("2026-09-30T18:00:00.000Z");
/** Madrugada del tick (02:20 Merida del jueves 1-oct = 08:20Z): el dia de negocio que cerro es el miercoles 30-sep. */
const TICK = new Date("2026-10-01T08:20:00.000Z");
const ORG = "00000000-0000-4000-8000-0000000000f1";
const IDS = SUCURSALES_PM_SINTETICAS.map((s) => s.propertyId);
const SUCURSALES: readonly SucursalAlerta[] = IDS.map((propertyId) => ({ propertyId, zonaHoraria: "America/Merida" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MIERCOLES_MERIDA);
});
afterEach(() => vi.useRealTimers());

function hallazgo(tipo: TipoHallazgo, urgencia: Urgencia, impactoCentavos: number | null, propertyId: string | null = IDS[0]!): Hallazgo {
  return {
    id: `${tipo}:${propertyId ?? "org"}`,
    tipo,
    propertyId,
    sucursal: propertyId ? "Sucursal" : null,
    titulo: `Hallazgo ${tipo}`,
    cifra: { valor: 1, confianza: "medido", fuente: "test" },
    cifraTexto: "1",
    comparacion: "x",
    porQueImporta: "x",
    accion: { texto: "Revise", ruta: "/cfo/resumen" },
    impactoCentavos,
    urgencia,
    fuentes: [],
  };
}

describe("seleccionarAlertas: umbral, severidad, orden y clave", () => {
  it("alerta si la urgencia es ALTA o el impacto llega al umbral; justo debajo del umbral, no", () => {
    const hs = [
      hallazgo("caida_ventas", "media", UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO - 1),
      hallazgo("ticket_baja", "media", UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO),
      hallazgo("entrega_lenta", "alta", null),
      hallazgo("cancelacion_alta", "baja", null),
      hallazgo("descuento_fuera_rango", "media", null),
    ];
    const r = seleccionarAlertas(hs, "2026-09-30");
    expect(r.map((a) => a.hallazgo.tipo).sort()).toEqual(["entrega_lenta", "ticket_baja"]);
    expect(UMBRAL_ALERTA_CENTAVOS_POR_DEFECTO).toBe(100_000); // $1,000
  });

  it("severidad: urgencia alta = critica; solo por impacto = atencion; el impacto viaja en pesos enteros (null si no es monetizable)", () => {
    const r = seleccionarAlertas([hallazgo("entrega_lenta", "alta", null), hallazgo("caida_ventas", "media", 123_456)], "2026-09-30");
    const alta = r.find((a) => a.hallazgo.tipo === "entrega_lenta")!;
    const monto = r.find((a) => a.hallazgo.tipo === "caida_ventas")!;
    expect(alta).toMatchObject({ severidad: "critica", impactoPesos: null });
    expect(monto).toMatchObject({ severidad: "atencion", impactoPesos: 1235 });
  });

  it("orden determinista: alta primero, luego mayor impacto, luego id; la clave lleva tipo, sucursal y DIA de negocio", () => {
    const hs = [hallazgo("caida_ventas", "media", 200_000), hallazgo("ticket_baja", "alta", 150_000), hallazgo("entrega_lenta", "alta", null), hallazgo("cierre_agente_bajo", "alta", 150_000, null)];
    const r = seleccionarAlertas(hs, "2026-09-30");
    expect(r.map((a) => a.hallazgo.tipo)).toEqual(["cierre_agente_bajo", "ticket_baja", "entrega_lenta", "caida_ventas"]);
    expect(r[0]!.clave).toBe("cierre_agente_bajo-org-2026-09-30");
    expect(r[1]!.clave).toBe(`ticket_baja-${IDS[0]}-2026-09-30`);
    expect(seleccionarAlertas(hs, "2026-09-30")).toEqual(r); // determinista
    expect(seleccionarAlertas([...hs].reverse(), "2026-09-30").map((a) => a.clave)).toEqual(r.map((a) => a.clave));
  });

  it("umbral configurable", () => {
    const hs = [hallazgo("caida_ventas", "media", 50_000)];
    expect(seleccionarAlertas(hs, "2026-09-30")).toHaveLength(0);
    expect(seleccionarAlertas(hs, "2026-09-30", 50_000)).toHaveLength(1);
  });
});

describe("día y hora del negocio", () => {
  it("la zona de la organización es la más común entre sus sucursales; vacía = México; sin sucursales = null", () => {
    expect(zonaDeOrganizacion([])).toBeNull();
    expect(zonaDeOrganizacion([{ propertyId: "a", zonaHoraria: "America/Cancun" }, { propertyId: "b", zonaHoraria: "America/Merida" }, { propertyId: "c", zonaHoraria: "America/Merida" }])).toBe("America/Merida");
    expect(zonaDeOrganizacion([{ propertyId: "a", zonaHoraria: null }])).toBe("America/Mexico_City");
  });

  it("hora local y ventana externa 8-21 h en la zona del negocio (no en UTC)", () => {
    expect(horaLocal(MIERCOLES_MERIDA, "America/Merida")).toBe(12);
    expect(dentroDeHorarioExterno(MIERCOLES_MERIDA, "America/Merida")).toBe(true);
    expect(dentroDeHorarioExterno(TICK, "America/Merida")).toBe(false); // 02:20 locales
    expect(dentroDeHorarioExterno(new Date("2026-10-01T02:59:00Z"), "America/Merida")).toBe(true); // 20:59 locales
    expect(dentroDeHorarioExterno(new Date("2026-10-01T03:00:00Z"), "America/Merida")).toBe(false); // 21:00 locales
  });
});

// ---- integración con el servicio real (repositorio en memoria) y una sesión que registra core.emit_notification ----------------------------------------

interface Emision { readonly evento: string; readonly propertyId: string | null; readonly severidad: string; readonly titulo: string; readonly cuerpo: string | null; readonly enlace: string; readonly dedupe: string; readonly roles: unknown; readonly organizationId: string }

class SesionEmisiones implements TenantDbSession {
  readonly emisiones: Emision[] = [];
  readonly vistas = new Set<string>();
  falla: ((dedupe: string) => boolean) | null = null;
  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (/count\(distinct dedupe_key\)/.test(sql)) {
      // Lo que la base ya tiene de ese dia: claves `restaurantes.cfo.hallazgo...:<tipo>-<sucursal>-<dia>` (el LIKE del llamador, hecho a mano).
      const sufijo = String(params[1]).replace("restaurantes.cfo.hallazgo%", "");
      return { rows: [{ n: [...this.vistas].filter((k) => k.startsWith("restaurantes.cfo.hallazgo") && k.endsWith(sufijo)).length } as T] };
    }
    if (!/core\.emit_notification/.test(sql)) return { rows: [] };
    const dedupe = String(params[10]);
    if (this.falla?.(dedupe)) throw Object.assign(new Error("fallo simulado de la base"), { code: "XX000" });
    // Dedupe de la base: la misma clave no vuelve a notificar.
    if (this.vistas.has(dedupe)) return { rows: [{ emit_notification: 0 } as T] };
    this.vistas.add(dedupe);
    this.emisiones.push({ organizationId: String(params[0]), propertyId: (params[1] as string | null) ?? null, evento: String(params[2]), severidad: String(params[4]), titulo: String(params[5]), cuerpo: (params[6] as string | null) ?? null, enlace: String(params[7]), dedupe, roles: params[11] });
    return { rows: [{ emit_notification: 2 } as T] };
  }
  async exec(): Promise<void> {}
}

const D = generarDatasetSintetico({ hasta: "2026-09-30", diasRango: 120 });
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-30", zona: "America/Merida", corte: "01:00:00" }));

function repo(op: Partial<OpcionesCfoMemoria> = {}, dataset: object = {}): InMemoryCfoRepository {
  return new InMemoryCfoRepository({
    sucursales: IDS,
    dataset: { ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos, clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, srResumen: D.srResumen, ...dataset },
    ...op,
  });
}

describe("alertarHallazgosCfo", () => {
  it("emite los hallazgos del día de negocio que cerró, a owner/admin, sin PII y con enlace al CFO", async () => {
    const db = new SesionEmisiones();
    const r = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    expect(r).toMatchObject({ estado: "ok", dia: "2026-09-30", zonaHoraria: "America/Merida", fallos: [] });
    expect(r.candidatos).toBeGreaterThan(0);
    expect(r.emitidas).toBe(db.emisiones.length);
    expect(r.emitidas).toBeGreaterThan(0);
    for (const e of db.emisiones) {
      expect(["restaurantes.cfo.hallazgo", "restaurantes.cfo.hallazgo_sin_monto"]).toContain(e.evento);
      expect(e.enlace).toBe("/restaurantes/{orgSlug}/cfo");
      expect(e.organizationId).toBe(ORG);
      expect(e.roles).toBeNull(); // solo owner/admin (los implicitos de la base)
      expect(e.dedupe).toMatch(new RegExp(`^restaurantes\\.cfo\\.hallazgo(_sin_monto)?:[a-z_]+-(org|[0-9a-f-]{36})-2026-09-30$`));
      expect(`${e.titulo} ${e.cuerpo ?? ""}`).not.toMatch(/@|\d{7,}/);
      expect(["atencion", "critica"]).toContain(e.severidad);
    }
  });

  it("idempotente: dos llamadas = una alerta por hallazgo (la segunda no emite nada nuevo)", async () => {
    const db = new SesionEmisiones();
    const r1 = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    const antes = db.emisiones.length;
    const r2 = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    expect(r1.emitidas).toBeGreaterThan(0);
    expect(r2.emitidas).toBe(0);
    expect(db.emisiones).toHaveLength(antes);
    expect(new Set(db.emisiones.map((e) => e.dedupe)).size).toBe(db.emisiones.length);
  });

  it("tope: como máximo 5 por organización y día; el resto se cuenta como omitido (y siguen siendo las mismas 5 al repetir)", async () => {
    const db = new SesionEmisiones();
    const r = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo(), umbralCentavos: 1 });
    expect(TOPE_ALERTAS_POR_ORG_DIA).toBe(5);
    expect(r.candidatos).toBeGreaterThan(5);
    expect(r.emitidas).toBe(5);
    expect(r.omitidasPorTope).toBe(r.candidatos - 5);
    const claves = db.emisiones.map((e) => e.dedupe);
    const r2 = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo(), umbralCentavos: 1 });
    expect(r2.emitidas).toBe(0);
    expect(db.emisiones.map((e) => e.dedupe)).toEqual(claves);
  });

  it("el día de negocio sigue la zona de la organización, no el UTC: a las 22:00 de Mérida del 29 aún está 'hoy' el 29 y cerró el 28", async () => {
    const db = new SesionEmisiones();
    const r = await alertarHallazgosCfo(db, ORG, new Date("2026-09-30T04:00:00Z"), { sucursales: SUCURSALES, repo: repo() });
    expect(r.dia).toBe("2026-09-28");
    expect(r.zonaHoraria).toBe("America/Merida");
  });

  it("base sin migrar (081): no emite nada y lo dice (no_disponible), sin lanzar", async () => {
    const db = new SesionEmisiones();
    const r = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo({ migraciones: { m081: false } }) });
    expect(r.estado).toBe("no_disponible");
    expect(r.emitidas).toBe(0);
    expect(db.emisiones).toHaveLength(0);
  });

  it("sin sucursales: no hace nada", async () => {
    const db = new SesionEmisiones();
    expect(await alertarHallazgosCfo(db, ORG, TICK, { sucursales: [], repo: repo() })).toMatchObject({ estado: "sin_sucursales", emitidas: 0 });
  });

  it("un fallo al emitir UNA alerta se aísla: se reporta, las demás salen y nada lanza", async () => {
    const db = new SesionEmisiones();
    const primera = await alertarHallazgosCfo(new SesionEmisiones(), ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    expect(primera.emitidas).toBeGreaterThan(1);
    let n = 0;
    db.falla = () => ++n === 1;
    const r = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    expect(r.estado).toBe("ok");
    expect(r.fallos).toHaveLength(1);
    expect(r.fallos[0]).toMatch(/XX000|fallo simulado/);
    expect(r.emitidas).toBe(primera.emitidas - 1);
  });

  it("canal externo (hueco F2): solo con alertas nuevas y dentro del horario del negocio", async () => {
    const enviadas: AlertaCfo[] = [];
    const canalExterno = async (a: AlertaCfo): Promise<void> => void enviadas.push(a);
    // 02:20 locales: fuera de horario -> no se envía nada, se cuenta.
    const noche = await alertarHallazgosCfo(new SesionEmisiones(), ORG, TICK, { sucursales: SUCURSALES, repo: repo(), canalExterno });
    expect(enviadas).toHaveLength(0);
    expect(noche.externasEnviadas).toBe(0);
    expect(noche.externasFueraDeHorario).toBe(noche.emitidas);
    // 12:00 locales (el dia de negocio que cerro es el 29): dentro de horario, una vez por alerta nueva.
    const dia = await alertarHallazgosCfo(new SesionEmisiones(), ORG, MIERCOLES_MERIDA, { sucursales: SUCURSALES, repo: repo(), canalExterno });
    expect(dia.dia).toBe("2026-09-29");
    expect(dia.externasEnviadas).toBe(dia.emitidas);
    expect(enviadas).toHaveLength(dia.emitidas);
    // Repetir no reenvía (no hay alertas nuevas).
    const db = new SesionEmisiones();
    await alertarHallazgosCfo(db, ORG, MIERCOLES_MERIDA, { sucursales: SUCURSALES, repo: repo(), canalExterno });
    const antes = enviadas.length;
    await alertarHallazgosCfo(db, ORG, MIERCOLES_MERIDA, { sucursales: SUCURSALES, repo: repo(), canalExterno });
    expect(enviadas).toHaveLength(antes);
  });

  it("si el canal externo falla, la alerta de la campana ya salió y el fallo se reporta sin lanzar", async () => {
    const db = new SesionEmisiones();
    const r = await alertarHallazgosCfo(db, ORG, MIERCOLES_MERIDA, { sucursales: SUCURSALES, repo: repo(), canalExterno: async () => { throw new Error("canal caido"); } });
    expect(r.emitidas).toBeGreaterThan(0);
    expect(r.externasEnviadas).toBe(0);
    expect(r.fallos.length).toBe(r.emitidas);
    expect(r.fallos[0]).toMatch(/canal_externo/);
  });

  it("día de negocio real: antes del corte (más tardío de las sucursales) el 'ayer' aún está abierto y se evalúa el antepasado", async () => {
    // Corte 01:00 (por omision): a las 00:30 locales todavia no cierra ayer; a las 01:00 en punto si.
    const antes = await alertarHallazgosCfo(new SesionEmisiones(), ORG, new Date("2026-10-01T06:30:00Z"), { sucursales: SUCURSALES, repo: repo() });
    expect(antes.dia).toBe("2026-09-29");
    const justo = await alertarHallazgosCfo(new SesionEmisiones(), ORG, new Date("2026-10-01T07:00:00Z"), { sucursales: SUCURSALES, repo: repo() });
    expect(justo.dia).toBe("2026-09-30");
    // Una sucursal que cierra a las 03:00: el tick de las 02:20 todavia no puede evaluar ayer.
    const tarde = COBERTURA.map((c, i) => (i === 0 ? { ...c, corte: "03:00:00" } : c));
    const r = await alertarHallazgosCfo(new SesionEmisiones(), ORG, TICK, { sucursales: SUCURSALES, repo: repo({}, { cobertura: tarde }) });
    expect(r.dia).toBe("2026-09-29");
    const despues = await alertarHallazgosCfo(new SesionEmisiones(), ORG, new Date("2026-10-01T09:05:00Z"), { sucursales: SUCURSALES, repo: repo({}, { cobertura: tarde }) });
    expect(despues.dia).toBe("2026-09-30"); // 03:05 locales
  });

  it("el tope cuenta lo ya emitido ese día: dos ticks con datos distintos no suman 5 + 5", async () => {
    const db = new SesionEmisiones();
    const r1 = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo(), umbralCentavos: 1 });
    expect(r1.emitidas).toBe(5);
    // Segundo tick el mismo dia con OTROS datos (sin SoftRestaurant: cambian los candidatos).
    const r2 = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo({}, { srResumen: [] }), umbralCentavos: 1 });
    expect(r2.emitidas).toBe(0);
    expect(new Set(db.emisiones.map((e) => e.dedupe)).size).toBe(5);
    // Otro dia de negocio tiene su propio tope.
    const r3 = await alertarHallazgosCfo(db, ORG, new Date("2026-10-02T08:20:00Z"), { sucursales: SUCURSALES, repo: repo(), umbralCentavos: 1 });
    expect(r3.dia).toBe("2026-10-01");
  });

  it("si la lectura de lo ya emitido falla, el tope se aplica por llamada (no se rompe el tick)", async () => {
    const db = new SesionEmisiones();
    const original = db.query.bind(db);
    db.query = (async (sql: string, params?: unknown[]) => {
      if (/count\(distinct dedupe_key\)/.test(sql)) throw Object.assign(new Error("rls"), { code: "42501" });
      return original(sql, params);
    }) as typeof db.query;
    const r = await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo(), umbralCentavos: 1 });
    expect(r.emitidas).toBe(5);
    expect(r.fallos).toEqual([]);
  });

  it("el texto de la notificación usa un código legible del tipo y el impacto en pesos con '$'", async () => {
    const db = new SesionEmisiones();
    await alertarHallazgosCfo(db, ORG, TICK, { sucursales: SUCURSALES, repo: repo() });
    expect(db.emisiones.length).toBeGreaterThan(0);
    for (const e of db.emisiones) {
      expect(e.titulo).toMatch(/^El CFO encontró algo que revisar: [A-Z][A-Za-z-]+$/);
      if (e.evento === "restaurantes.cfo.hallazgo") expect(e.cuerpo).toMatch(/^Impacto estimado del día: \$\d+ MXN\./);
    }
  });
});
