// paridad3 D-31 + D-P3-15 -- cron diario del piloto: crea las solicitudes de documentos, recuerda a los 3/7/10 dias y auto-completa el cierre.
import { describe, expect, it } from "vitest";
import { InMemoryPilotoRepository, getTemplate, construirTareasDesdePlantilla } from "@atiende/domain-despachos";
import type { CloseTask, EstadoModulosCierre } from "@atiende/domain-despachos";
import { runPilotoCierreClienteSweep } from "../src/index.ts";
import type { UnidadPiloto, WithUnidadPiloto } from "../src/index.ts";

const ORG = "org-1";
const SANO: EstadoModulosCierre = {
  debeCentavos: 0, haberCentavos: 0, polizas: 0, polizasDescuadradas: 0, cfdiTotal: 0, cfdiSinPoliza: 0, cfdiInvalidos: 0, conciliacionSesiones: 0, conciliacionAbiertas: 0,
  movimientos: 0, movimientosConciliados: 0, pagosProvisionales: 1, solicitudEstado: null, solicitudPendientes: 0, periodicidad: "mensual",
};

interface Correo { organizationId: string; eventType: string; dedupeKey: string; to: string; subject: string; text: string }
function armar() {
  const piloto = new InMemoryPilotoRepository();
  const correos: Correo[] = [];
  const avisos: { evento: string; clave: string; propertyId?: string | null; parametros?: Readonly<Record<string, string | number>> }[] = [];
  let falla: ((u: UnidadPiloto) => void) | null = null;
  const withUnidad: WithUnidadPiloto = async (fn) => {
    const unidad: UnidadPiloto = {
      piloto,
      encolarCorreo: async (organizationId, eventType, dedupeKey, p) => {
        if (correos.some((c) => c.organizationId === organizationId && c.dedupeKey === dedupeKey)) return; // como el outbox real: idempotente por clave
        correos.push({ organizationId, eventType, dedupeKey, to: p.to, subject: p.subject, text: p.text });
      },
      notificar: async (n) => {
        avisos.push({ evento: n.evento, clave: n.clave, propertyId: n.propertyId, parametros: n.parametros });
      },
    };
    falla?.(unidad);
    return fn(unidad);
  };
  let n = 0;
  const generarToken = () => `T${String(++n).padStart(42, "0")}`;
  return { piloto, correos, avisos, withUnidad, generarToken, fallar: (f: (u: UnidadPiloto) => void) => (falla = f) };
}
const opciones = (generarToken: () => string, hoy = "2026-07-01") => ({ hoy, appBaseUrl: "https://app.test/", generarToken });
const cliente = (piloto: InMemoryPilotoRepository, id: string, extra: { correo?: string; dia?: number } = {}) => {
  piloto.sembrarCliente({ organizationId: ORG, propertyId: id, razonSocial: `Cliente ${id}` });
  if (extra.correo || extra.dia) piloto.automatizacion.set(id, { contactoCorreo: extra.correo ?? null, envioReportesCierre: false, solicitudActiva: true, solicitudDia: extra.dia ?? 1, plantilla: {} });
};

describe("solicitudes de documentos", () => {
  it("el dia 1 crea la solicitud del mes ANTERIOR por cliente y manda el aviso solo a quien tiene correo de contacto", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    cliente(a.piloto, "c2");
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(r.solicitudes).toMatchObject({ estado: "ok", creadas: 2, yaExistian: 0, correosEncolados: 1, sinContacto: 1 });
    expect(a.piloto.solicitudes.map((s) => [s.propertyId, s.ejercicio, s.mes])).toEqual([["c1", 2026, 6], ["c2", 2026, 6]]);
    expect(a.correos).toHaveLength(1);
    expect(a.correos[0]).toMatchObject({ to: "uno@cliente.mx", eventType: "despachos.solicitud.documentos" });
    expect(a.correos[0]!.text).toContain("https://app.test/portal/cliente#t=T");
    expect(a.correos[0]!.text).toContain("Estado de cuenta bancario");
    expect(a.correos[0]!.subject).toContain("junio de 2026");
  });

  it("es idempotente: una segunda corrida el mismo dia no crea otra solicitud ni otro correo", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(r.solicitudes).toMatchObject({ creadas: 0, correosEncolados: 0 });
    expect(a.piloto.solicitudes).toHaveLength(1);
    expect(a.correos).toHaveLength(1);
  });

  it("respeta el dia configurado por cliente: con dia 5, el 3 todavia no y el 5 si", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx", dia: 5 });
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-03"))).solicitudes.creadas).toBe(0);
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-05"))).solicitudes.creadas).toBe(1);
  });

  it("en enero pide diciembre del ejercicio anterior", async () => {
    const a = armar();
    cliente(a.piloto, "c1");
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2027-01-01"));
    expect(a.piloto.solicitudes.map((s) => [s.ejercicio, s.mes])).toEqual([[2026, 12]]);
  });

  it("un cliente con la solicitud desactivada no recibe nada", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    a.piloto.automatizacion.set("c1", { contactoCorreo: "uno@cliente.mx", envioReportesCierre: false, solicitudActiva: false, solicitudDia: 1, plantilla: {} });
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(r.solicitudes.creadas).toBe(0);
    expect(a.correos).toHaveLength(0);
  });

  it("si no se puede crear el enlace el aviso sale SIN enlace (honesto) en vez de perderse", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    a.piloto.crearEnlaceSistema = async () => {
      throw new Error("tope");
    };
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(a.correos).toHaveLength(1);
    expect(a.correos[0]!.text).not.toContain("/portal/cliente");
  });

  it("un cliente que falla no frena a los demas y se reporta", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    cliente(a.piloto, "c2", { correo: "dos@cliente.mx" });
    const original = a.piloto.crearSolicitudSistema.bind(a.piloto);
    a.piloto.crearSolicitudSistema = async (pid, e, m) => {
      if (pid === "c1") throw new Error("falla sintetica en c1");
      return original(pid, e, m);
    };
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(r.solicitudes.fallidos).toEqual([{ id: "c1", error: "falla sintetica en c1" }]);
    expect(r.solicitudes.creadas).toBe(1);
    expect(r.fallidos).toBe(1);
    expect(a.correos.map((c) => c.to)).toEqual(["dos@cliente.mx"]);
  });

  it("base sin la 027: cada paso responde no_disponible y no hace nada", async () => {
    const a = armar();
    cliente(a.piloto, "c1", { correo: "uno@cliente.mx" });
    a.piloto.disponible = false;
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    expect(r.solicitudes.estado).toBe("no_disponible");
    expect(r.recordatorios.estado).toBe("no_disponible");
    expect(r.cierre.estado).toBe("no_disponible");
    expect(a.correos).toHaveLength(0);
  });
});

describe("recordatorios a los 3, 7 y 10 dias", () => {
  async function conSolicitud(correo: string | null = "uno@cliente.mx") {
    const a = armar();
    cliente(a.piloto, "c1", correo ? { correo } : {});
    let ahora = Date.parse("2026-07-01T10:00:00Z");
    a.piloto.ahora = () => ahora;
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken));
    return { a, avanzar: (dias: number) => (ahora += dias * 86_400_000) };
  }
  const dia = (n: number) => `2026-07-${String(1 + n).padStart(2, "0")}`;

  it("manda un recordatorio por nivel (3, 7 y 10 dias) y nunca repite el mismo", async () => {
    const { a, avanzar } = await conSolicitud();
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(2)))).recordatorios.enviados).toBe(0);
    avanzar(3);
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(3)))).recordatorios.enviados).toBe(1);
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(4)))).recordatorios.enviados).toBe(0);
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(7)))).recordatorios.enviados).toBe(1);
    const r10 = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(10)));
    expect(r10.recordatorios).toMatchObject({ enviados: 1, avisosAlDespacho: 1 });
    expect((await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(15)))).recordatorios.enviados).toBe(0);
    expect(a.correos.filter((c) => c.eventType === "despachos.solicitud.recordatorio").map((c) => c.dedupeKey.split(":")[2])).toEqual(["recordatorio1", "recordatorio2", "recordatorio3"]);
    expect(a.correos.at(-1)!.subject).toMatch(/^Urgente/);
  });

  it("el aviso al despacho (campana) sale solo a los 10 dias, con dedupe por solicitud y sin PII", async () => {
    const { a } = await conSolicitud();
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(10)));
    expect(a.avisos).toHaveLength(1);
    expect(a.avisos[0]).toMatchObject({ evento: "despachos.solicitud.sin_completar", clave: a.piloto.solicitudes[0]!.id, parametros: { cantidad: 3 } });
    expect(JSON.stringify(a.avisos)).not.toMatch(/@|cliente\.mx/);
  });

  it("se detienen cuando la solicitud se completa", async () => {
    const { a } = await conSolicitud();
    for (const r of a.piloto.solicitudes[0]!.renglones) await a.piloto.marcarRenglonNoAplica("c1", r.id, "No aplica este mes");
    expect(a.piloto.solicitudes[0]!.estado).toBe("completa");
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(12)));
    expect(r.recordatorios.enviados).toBe(0);
    expect(a.avisos).toHaveLength(0);
  });

  it("sin correo de contacto no manda nada pero SI marca el nivel y avisa al despacho a los 10 dias", async () => {
    const { a } = await conSolicitud(null);
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, dia(10)));
    expect(r.recordatorios).toMatchObject({ enviados: 0, sinContacto: 1, avisosAlDespacho: 1 });
    expect(a.piloto.solicitudes[0]!.nivel).toBe(3);
  });
});

describe("cierre en piloto automatico (cron diario)", () => {
  function conPeriodo(estado: EstadoModulosCierre, anio = 2026, mes = 6) {
    const a = armar();
    cliente(a.piloto, "c1");
    a.piloto.automatizacion.set("c1", { contactoCorreo: null, envioReportesCierre: false, solicitudActiva: false, solicitudDia: 1, plantilla: {} });
    a.piloto.sembrarPeriodo({ periodoId: "per-1", organizationId: ORG, propertyId: "c1", anio, mes });
    const nuevas = construirTareasDesdePlantilla(anio, mes, getTemplate());
    const ids = nuevas.map((_, i) => `t${i}`);
    const porKey = new Map(nuevas.map((n, i) => [n.key, ids[i]!] as const));
    a.piloto.tareasPorPeriodo.set(
      "per-1",
      nuevas.map((n, i) => ({ id: ids[i]!, periodId: "per-1", title: n.title, description: n.description, category: n.category, status: n.status, dependsOn: n.dependsOnKeys.map((k) => porKey.get(k)!), dueDate: n.dueDate, autoCheckQuery: n.autoCheckQuery, required: n.required, completedAt: null, completedBy: null })) as CloseTask[],
    );
    a.piloto.sembrarEstadoModulos("c1", anio, mes, estado);
    return a;
  }

  it("auto-completa las tareas cuya senal persistida se cumple (en cascada) y NUNCA cierra el periodo", async () => {
    const a = conPeriodo(SANO);
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-02"));
    expect(r.cierre).toMatchObject({ estado: "ok", periodos: 1, tareasCompletadas: 3 });
    expect(a.piloto.tareasAutocompletadas).toHaveLength(1);
    expect(a.piloto.periodos.get("per-1")!.cerrado).toBeFalsy();
    // La segunda corrida no vuelve a completar lo ya hecho.
    const r2 = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-03"));
    expect(r2.cierre.tareasCompletadas).toBe(0);
  });

  it("con CFDI sin poliza no completa nada y no avisa que esta listo", async () => {
    const a = conPeriodo({ ...SANO, cfdiSinPoliza: 4 });
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-02"));
    expect(r.cierre).toMatchObject({ tareasCompletadas: 0, listosParaRevisar: 0 });
    expect(a.avisos).toHaveLength(0);
  });

  it("avisa UNA vez por periodo (dedupe por id) cuando el periodo ya termino y todas las validaciones pasan", async () => {
    const a = conPeriodo(SANO);
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-02"));
    expect(r.cierre.listosParaRevisar).toBe(1);
    expect(a.avisos).toEqual([{ evento: "despachos.cierre.listo_para_revisar", clave: "per-1", propertyId: "c1", parametros: undefined }]);
    await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-03"));
    // El productor emite en cada corrida; el dedupe es la clave estable del catalogo (la base no duplica la notificacion).
    expect(new Set(a.avisos.map((x) => `${x.evento}:${x.clave}`)).size).toBe(1);
  });

  it("un periodo del MES EN CURSO no se anuncia como listo (todavia entran movimientos)", async () => {
    const a = conPeriodo(SANO, 2026, 7);
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-15"));
    expect(r.cierre.listosParaRevisar).toBe(0);
  });

  it("un periodo que falla no frena a los demas", async () => {
    const a = conPeriodo(SANO);
    a.piloto.sembrarPeriodo({ periodoId: "per-2", organizationId: ORG, propertyId: "c1", anio: 2026, mes: 5 });
    a.piloto.tareasCierreSistema = async (id) => {
      if (id === "per-1") throw new Error("falla sintetica");
      return [];
    };
    const r = await runPilotoCierreClienteSweep(a.withUnidad, opciones(a.generarToken, "2026-07-02"));
    expect(r.cierre.fallidos).toEqual([{ id: "per-1", error: "falla sintetica" }]);
    expect(r.cierre.periodos).toBe(2);
  });
});
