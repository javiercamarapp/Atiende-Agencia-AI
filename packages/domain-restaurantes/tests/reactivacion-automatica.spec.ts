// Reactivacion automatica (PM R23, F3): reglas puras + orquestador con repositorio en memoria y adaptador de envio FALSO. Datos 100 % sinteticos.
import { describe, expect, it } from "vitest";
import {
  EnviadorFalso,
  barrerReactivacion,
  dentroDeHorario,
  ejecutarReactivacionOrg,
  evaluarCandidato,
  limpiarParametro,
  parametrosPlantilla,
  relojLocal,
  tasasReactivacion,
} from "../src/marketing/reactivacion.ts";
import type { AvisoReactivacion, CandidatoReactivacion, ContextoReactivacion, DependenciasReactivacion, RepoReactivacion } from "../src/marketing/reactivacion.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
// 17:00 UTC = 11:00 en America/Merida (UTC-6 todo el ano): dentro del horario 10-20.
const AHORA = new Date("2026-11-04T17:00:00Z");

const ctx = (o: Partial<ContextoReactivacion> = {}): ContextoReactivacion => ({
  modo: "real", diasMin: 14, diasMax: 21, minDiasEntreEnvios: 14, maxPorMes: 2, horaDesde: 10, horaHasta: 20, topeDiario: 50,
  plantillaNombre: "reactivacion_favorito", plantillaIdioma: "es_MX", plantillaAprobada: true, phoneNumberId: "pnid-sintetico", zonaHoraria: "America/Merida", enviadosHoy: 0, ...o,
});
const cand = (n: number, o: Partial<CandidatoReactivacion> = {}): CandidatoReactivacion => ({
  customerId: `00000000-0000-0000-0000-0000000c${String(n).padStart(4, "0")}`, telefono: `+5255500${String(n).padStart(5, "0")}`, nombre: `Cliente ${n}`, propertyId: "00000000-0000-0000-0000-0000000b0001",
  diasSinPedir: 15, favorito: "Orden de tacos de cochinita", ultimoMensajeClienteAt: null, optinEstado: "otorgado", enviosEnIntervalo: 0, enviosEnMes: 0, quejaReciente: false, sucursalActiva: true, control: false, ...o,
});

interface Memoria {
  readonly repo: RepoReactivacion;
  readonly envios: { customerId: string; dia: string; estado: string }[];
  readonly corridas: { modo: string; enviados: number; simulados: number; controles: number; bloqueos: Record<string, number>; aviso: AvisoReactivacion | null }[];
}
function memoria(contexto: ContextoReactivacion | null, candidatos: readonly CandidatoReactivacion[]): Memoria {
  const envios: Memoria["envios"] = [];
  const corridas: Memoria["corridas"] = [];
  const repo: RepoReactivacion = {
    organizaciones: async () => (contexto && contexto.modo !== "apagado" ? [ORG] : []),
    contexto: async () => contexto,
    candidatos: async () => candidatos,
    registrarEnvio: async (a) => {
      if (envios.some((e) => e.customerId === a.customerId && e.dia === a.dia)) return false;
      envios.push({ customerId: a.customerId, dia: a.dia, estado: a.estado });
      return true;
    },
    registrarCorrida: async (a) => {
      corridas.push({ modo: a.modo, enviados: a.enviados, simulados: a.simulados, controles: a.controles, bloqueos: { ...a.bloqueos }, aviso: a.aviso });
    },
  };
  return { repo, envios, corridas };
}
const deps = (m: Memoria, extra: Partial<DependenciasReactivacion> = {}): DependenciasReactivacion & { enviador: EnviadorFalso } => {
  const enviador = new EnviadorFalso();
  return { repo: m.repo, enviador, suprimidos: { estaSuprimido: async () => false }, ...extra, ...{} } as DependenciasReactivacion & { enviador: EnviadorFalso };
};

describe("evaluarCandidato (reglas puras)", () => {
  const c = ctx();
  it("elegible: opt-in, ventana 14-21 inclusiva, sucursal activa, favorito", () => {
    expect(evaluarCandidato(cand(1), c)).toBeNull();
    expect(evaluarCandidato(cand(1, { diasSinPedir: 14 }), c)).toBeNull();
    expect(evaluarCandidato(cand(1, { diasSinPedir: 21 }), c)).toBeNull();
  });
  it("sin opt-in NUNCA: cualquier estado distinto de otorgado se bloquea", () => {
    for (const estado of ["revocado", "sin_registro", "", "OTORGADO"]) expect(evaluarCandidato(cand(1, { optinEstado: estado }), c)).toBe("sin_optin");
  });
  it("fuera de ventana, queja, sucursal apagada, topes y falta de favorito", () => {
    expect(evaluarCandidato(cand(1, { diasSinPedir: 13 }), c)).toBe("fuera_de_ventana_dias");
    expect(evaluarCandidato(cand(1, { diasSinPedir: 22 }), c)).toBe("fuera_de_ventana_dias");
    expect(evaluarCandidato(cand(1, { quejaReciente: true }), c)).toBe("queja_reciente");
    expect(evaluarCandidato(cand(1, { sucursalActiva: false }), c)).toBe("sucursal_apagada");
    expect(evaluarCandidato(cand(1, { enviosEnIntervalo: 1 }), c)).toBe("tope_intervalo");
    expect(evaluarCandidato(cand(1, { enviosEnMes: 2 }), c)).toBe("tope_mensual");
    expect(evaluarCandidato(cand(1, { enviosEnMes: 1 }), c)).toBeNull();
    expect(evaluarCandidato(cand(1, { favorito: "  " }), c)).toBe("sin_favorito");
    expect(evaluarCandidato(cand(1, { favorito: null }), c)).toBe("sin_favorito");
    expect(evaluarCandidato(cand(1, { telefono: null }), c)).toBe("sin_telefono");
  });
});

describe("horario y plantilla", () => {
  it("el horario se mide en la zona de la sucursal", () => {
    expect(relojLocal(AHORA, "America/Merida")).toEqual({ hora: 11, dia: "2026-11-04" });
    expect(dentroDeHorario(AHORA, ctx())).toBe(true);
    expect(dentroDeHorario(new Date("2026-11-04T15:59:00Z"), ctx())).toBe(false); // 09:59
    expect(dentroDeHorario(new Date("2026-11-04T16:00:00Z"), ctx())).toBe(true); // 10:00
    expect(dentroDeHorario(new Date("2026-11-05T02:00:00Z"), ctx())).toBe(false); // 20:00
    expect(relojLocal(new Date("2026-11-05T03:00:00Z"), "America/Merida").dia).toBe("2026-11-04"); // 21:00 local aun es el dia 4
  });
  it("parametros: primer nombre o 'cliente', sin saltos de linea ni espacios repetidos, acotados", () => {
    expect(parametrosPlantilla("Ana María López", "Tacos")).toEqual(["Ana", "Tacos"]);
    expect(parametrosPlantilla(null, "Tacos")[0]).toBe("cliente");
    expect(limpiarParametro("a\n\tb    c", 60)).toBe("a b c");
    expect(limpiarParametro("x".repeat(100), 60)).toHaveLength(60);
  });
});

describe("ejecutarReactivacionOrg", () => {
  it("el universo opt-in es 0: ni un envio, ni uno simulado, y la corrida lo deja asentado", async () => {
    const m = memoria(ctx(), []);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r).toMatchObject({ estado: "ejecutada", evaluados: 0, enviados: 0, simulados: 0 });
    expect(d.enviador.enviados).toHaveLength(0);
    expect(m.envios).toHaveLength(0);
    expect(m.corridas).toHaveLength(1);
  });
  it("sin opt-in nunca se envia aunque la fuente (defensa en profundidad) lo entregue", async () => {
    const m = memoria(ctx(), [cand(1, { optinEstado: "sin_registro" }), cand(2, { optinEstado: "revocado" })]);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r.enviados).toBe(0);
    expect(r.bloqueos).toEqual({ sin_optin: 2 });
    expect(d.enviador.enviados).toHaveLength(0);
  });
  it("modo apagado o sin configuracion: no hace nada y no registra corrida", async () => {
    for (const c of [null, ctx({ modo: "apagado" })]) {
      const m = memoria(c, [cand(1)]);
      const d = deps(m);
      expect((await ejecutarReactivacionOrg(d, ORG, AHORA)).estado).toBe("apagado");
      expect(d.enviador.enviados).toHaveLength(0);
      expect(m.corridas).toHaveLength(0);
    }
  });
  it("modo simulado: registra simulaciones y el adaptador de envio no recibe NADA", async () => {
    const m = memoria(ctx({ modo: "simulado" }), [cand(1), cand(2)]);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r).toMatchObject({ simulados: 2, enviados: 0 });
    expect(d.enviador.enviados).toHaveLength(0);
    expect(m.envios.map((e) => e.estado)).toEqual(["simulado", "simulado"]);
    expect(m.corridas[0]?.modo).toBe("simulado");
  });
  it("modo real: envia solo a elegibles con plantilla y parametros correctos, y es idempotente en la misma jornada", async () => {
    const m = memoria(ctx(), [cand(1), cand(2, { diasSinPedir: 30 }), cand(3, { quejaReciente: true }), cand(4, { sucursalActiva: false }), cand(5, { nombre: null })]);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r.enviados).toBe(2);
    expect(r.bloqueos).toEqual({ fuera_de_ventana_dias: 1, queja_reciente: 1, sucursal_apagada: 1 });
    expect(d.enviador.enviados.map((x) => x.params)).toEqual([["Cliente", "Orden de tacos de cochinita"], ["cliente", "Orden de tacos de cochinita"]]);
    expect(d.enviador.enviados[0]).toMatchObject({ plantilla: "reactivacion_favorito", idioma: "es_MX", phoneNumberId: "pnid-sintetico" });
    expect(d.enviador.enviados[0]?.body).toContain("responde BAJA");
    // Segunda corrida el mismo dia: la base ya tiene a esas personas, no se duplica nada.
    const r2 = await ejecutarReactivacionOrg(d, ORG, new Date(AHORA.getTime() + 3_600_000));
    expect(r2.enviados).toBe(0);
    expect(r2.bloqueos.ya_registrado).toBe(2);
    expect(d.enviador.enviados).toHaveLength(2);
    expect(m.envios).toHaveLength(2);
  });
  it("sin plantilla aprobada: no envia, registra corrida con aviso y avisa al panel", async () => {
    const avisos: string[] = [];
    const m = memoria(ctx({ plantillaAprobada: false }), [cand(1)]);
    const d = deps(m, { avisarPanel: async (_o, a) => void avisos.push(a) });
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r).toMatchObject({ enviados: 0, aviso: "requiere_plantilla_aprobada" });
    expect(d.enviador.enviados).toHaveLength(0);
    expect(avisos).toEqual(["requiere_plantilla_aprobada"]);
    expect(m.corridas[0]?.aviso).toBe("requiere_plantilla_aprobada");
  });
  it("sin WhatsApp conectado: no envia y avisa", async () => {
    const m = memoria(ctx({ phoneNumberId: null }), [cand(1)]);
    const d = deps(m);
    expect((await ejecutarReactivacionOrg(d, ORG, AHORA)).aviso).toBe("requiere_whatsapp_conectado");
    expect(d.enviador.enviados).toHaveLength(0);
  });
  it("fuera de horario: no envia ni evalua; el siguiente tick dentro del horario si", async () => {
    const m = memoria(ctx(), [cand(1)]);
    const d = deps(m);
    const noche = new Date("2026-11-05T04:00:00Z"); // 22:00 local
    expect(await ejecutarReactivacionOrg(d, ORG, noche)).toMatchObject({ enviados: 0, aviso: "fuera_de_horario" });
    expect(d.enviador.enviados).toHaveLength(0);
    expect((await ejecutarReactivacionOrg(d, ORG, AHORA)).enviados).toBe(1);
  });
  it("BAJA: la lista de supresion bloquea aunque el consentimiento siguiera vigente", async () => {
    const m = memoria(ctx(), [cand(1), cand(2)]);
    const d = deps(m, { suprimidos: { estaSuprimido: async (t) => t.endsWith("00001") } });
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r.enviados).toBe(1);
    expect(r.bloqueos).toEqual({ suprimido: 1 });
  });
  it("tope diario: se respeta lo ya enviado hoy", async () => {
    const m = memoria(ctx({ topeDiario: 3, enviadosHoy: 1 }), [cand(1), cand(2), cand(3), cand(4)]);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r.enviados).toBe(2);
    expect(r.bloqueos).toEqual({ tope_diario: 2 });
  });
  it("grupo de control: se registra para medir y NO recibe mensaje", async () => {
    const m = memoria(ctx(), [cand(1, { control: true }), cand(2)]);
    const d = deps(m);
    const r = await ejecutarReactivacionOrg(d, ORG, AHORA);
    expect(r).toMatchObject({ enviados: 1, controles: 1 });
    expect(d.enviador.enviados).toHaveLength(1);
    expect(m.envios.map((e) => e.estado).sort()).toEqual(["control", "encolado"]);
  });
  it("el orden es determinista por cliente y un fallo del envio de uno no frena a los demas", async () => {
    const m = memoria(ctx(), [cand(3), cand(1), cand(2)]);
    const base = new EnviadorFalso();
    const d = deps(m, {});
    const roto: DependenciasReactivacion = { ...d, enviador: { enviar: async (x) => (x.telefono.endsWith("00002") ? Promise.reject(new Error("boom")) : base.enviar(x)) } };
    const r = await ejecutarReactivacionOrg(roto, ORG, AHORA);
    expect(r.enviados).toBe(2);
    expect(r.bloqueos).toEqual({ error: 1 });
    expect(base.enviados.map((x) => x.telefono)).toEqual(["+525550000001", "+525550000003"]);
  });
});

describe("barrerReactivacion y metricas", () => {
  it("el barrido recorre solo organizaciones encendidas", async () => {
    const m = memoria(ctx(), [cand(1)]);
    const d = deps(m);
    expect(await barrerReactivacion(d, AHORA)).toEqual({ organizaciones: 1, enviados: 1, simulados: 0, errores: 0 });
    const apagado = memoria(ctx({ modo: "apagado" }), [cand(1)]);
    expect(await barrerReactivacion(deps(apagado), AHORA)).toEqual({ organizaciones: 0, enviados: 0, simulados: 0, errores: 0 });
  });
  it("tasas: respuesta, recompra, incremental contra control y baja; sin denominador = null", () => {
    const t = tasasReactivacion({ enviados: 40, simulados: 0, controles: 10, respondieron: 10, recompraron: 12, recompraronControl: 1, bajas: 2, atribucionDias: 7 });
    expect(t.respuesta).toBeCloseTo(0.25);
    expect(t.recompra).toBeCloseTo(0.3);
    expect(t.recompraControl).toBeCloseTo(0.1);
    expect(t.incremental).toBeCloseTo(0.2);
    expect(t.baja).toBeCloseTo(0.05);
    expect(tasasReactivacion({ enviados: 0, simulados: 0, controles: 0, respondieron: 0, recompraron: 0, recompraronControl: 0, bajas: 0, atribucionDias: 7 })).toEqual({ respuesta: null, recompra: null, recompraControl: null, incremental: null, baja: null });
  });
});
