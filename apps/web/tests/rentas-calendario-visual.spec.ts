// Rn-06 -- lógica pura del calendario visual de rentas (apps/web/src/verticals/rentas/lib/calendario-visual.ts): zona horaria de
// la propiedad (Cancún vs CDMX), noches vs días, cruces de medianoche y de fin de mes/año, capas, filtros, carriles de la línea
// de tiempo, agenda móvil y rendimiento con cientos de reservas.
import { describe, expect, it } from "vitest";
import type { OcupacionVisual } from "../src/verticals/rentas/lib/calendario-client.ts";
import {
  agendaDelMes,
  canalesPresentes,
  claveMesDe,
  construirElementos,
  contenidoPorDia,
  diaSemanaLunes,
  diasDelMes,
  elementoDeOcupacion,
  esClaveMesValida,
  etiquetaMes,
  etiquetaRango,
  filtrarElementos,
  FILTROS_POR_DEFECTO,
  hoyEnZona,
  idsEnConflicto,
  limitarPorDia,
  moverMes,
  nochesDe,
  segmentosDeUnidad,
  semanasDeRejilla,
  sumarDias,
  tonoDeCanal,
  tonoDeElemento,
  ventanaDeRejilla,
} from "../src/verticals/rentas/lib/calendario-visual.ts";
import type { ElementoCalendario } from "../src/verticals/rentas/lib/calendario-visual.ts";
import type { ConflictoCalendario } from "../src/verticals/rentas/lib/ical-monitor-client.ts";
import type { TareaOperativa } from "../src/verticals/rentas/lib/limpieza-client.ts";

const ocup = (id: string, inicio: string, fin: string, extra: Partial<OcupacionVisual> = {}): OcupacionVisual => ({
  id,
  unidadId: "u1",
  capa: "reserva",
  rango: { inicio, fin },
  razon: "RESERVA_CANAL",
  estado: "confirmado",
  canalCodigo: "manual",
  huespedNombre: null,
  ...extra,
});

const el = (id: string, inicio: string, fin: string, extra: Partial<ElementoCalendario> = {}): ElementoCalendario => ({ ...elementoDeOcupacion(ocup(id, inicio, fin)), ...extra });

describe("hoyEnZona -- el día lo decide la zona de la propiedad, no el reloj ni el día UTC", () => {
  // 05:30 UTC del 2 de enero = 00:30 del 2 en Cancún (UTC-5, sin horario de verano) = 23:30 del 1 en CDMX (UTC-6).
  const instante = new Date("2026-01-02T05:30:00Z");

  it("Cancún ya está en el día 2 y CDMX todavía en el 1 (la medianoche local cruza en horas distintas)", () => {
    expect(hoyEnZona("America/Cancun", instante)).toBe("2026-01-02");
    expect(hoyEnZona("America/Mexico_City", instante)).toBe("2026-01-01");
  });

  it("un minuto antes de la medianoche de Cancún sigue siendo el día anterior aunque el día UTC ya cambió", () => {
    const casiMedianoche = new Date("2026-01-02T04:59:00Z");
    expect(hoyEnZona("America/Cancun", casiMedianoche)).toBe("2026-01-01");
    expect(casiMedianoche.toISOString().slice(0, 10)).toBe("2026-01-02");
  });

  it("cruza fin de año y fin de mes con la zona, no con UTC", () => {
    expect(hoyEnZona("America/Mexico_City", new Date("2027-01-01T05:59:00Z"))).toBe("2026-12-31");
    expect(hoyEnZona("America/Mexico_City", new Date("2027-01-01T06:00:00Z"))).toBe("2027-01-01");
    expect(hoyEnZona("America/Cancun", new Date("2026-03-01T04:59:00Z"))).toBe("2026-02-28");
  });

  it("una zona inválida, vacía o ausente cae a Ciudad de México en vez de lanzar", () => {
    expect(hoyEnZona("No/Existe", instante)).toBe("2026-01-01");
    expect(hoyEnZona("", instante)).toBe("2026-01-01");
    expect(hoyEnZona(null, instante)).toBe("2026-01-01");
  });
});

describe("aritmética de fechas y meses", () => {
  it("noches = fin - inicio; vacío, invertido o inválido = 0 (nunca lanza con datos del servidor)", () => {
    expect(nochesDe("2026-10-10", "2026-10-12")).toBe(2);
    expect(nochesDe("2026-10-10", "2026-10-10")).toBe(0);
    expect(nochesDe("2026-10-12", "2026-10-10")).toBe(0);
    expect(nochesDe("2026-02-30", "2026-03-02")).toBe(0);
  });

  it("sumarDias cruza fin de mes, de año y febrero bisiesto, y no se mueve con el horario de verano", () => {
    expect(sumarDias("2026-10-31", 1)).toBe("2026-11-01");
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(sumarDias("2028-02-28", 1)).toBe("2028-02-29");
    expect(sumarDias("2027-02-28", 1)).toBe("2027-03-01");
    expect(sumarDias("2026-03-07", 2)).toBe("2026-03-09"); // el cambio de horario de EE. UU. es el 8
    expect(sumarDias("2026-03-09", -2)).toBe("2026-03-07");
    expect(() => sumarDias("2026-02-30", 1)).toThrow();
  });

  it("diaSemanaLunes: lunes = 0 y domingo = 6", () => {
    expect(diaSemanaLunes("2026-10-05")).toBe(0); // lunes
    expect(diaSemanaLunes("2026-10-11")).toBe(6); // domingo
  });

  it("diasDelMes respeta febrero (28, bisiesto 29) y los meses de 30 y 31", () => {
    expect(diasDelMes("2026-02")).toHaveLength(28);
    expect(diasDelMes("2028-02")).toHaveLength(29);
    expect(diasDelMes("2026-04")).toHaveLength(30);
    expect(diasDelMes("2026-10")).toHaveLength(31);
  });

  it("moverMes cruza el año en ambos sentidos y valida la clave", () => {
    expect(moverMes("2026-12", 1)).toBe("2027-01");
    expect(moverMes("2026-01", -1)).toBe("2025-12");
    expect(moverMes("2026-10", 14)).toBe("2027-12");
    expect(esClaveMesValida("2026-13")).toBe(false);
    expect(esClaveMesValida("2026-00")).toBe(false);
    expect(() => moverMes("2026-13", 1)).toThrow();
    expect(etiquetaMes("2026-10")).toBe("octubre de 2026");
    expect(claveMesDe("2026-10-31")).toBe("2026-10");
  });

  it("la rejilla va de lunes a domingo y siempre son semanas completas", () => {
    // Octubre 2026: el 1 es jueves y el 31 sábado -> del lunes 28-sep al domingo 1-nov (5 semanas), fin exclusivo 2-nov.
    expect(ventanaDeRejilla("2026-10")).toEqual({ inicio: "2026-09-28", fin: "2026-11-02" });
    // Febrero 2027 empieza en lunes y termina en domingo: exactamente 4 semanas.
    expect(ventanaDeRejilla("2027-02")).toEqual({ inicio: "2027-02-01", fin: "2027-03-01" });
    for (const mes of ["2026-02", "2026-03", "2026-05", "2026-08", "2026-10", "2027-01", "2028-02"]) {
      const semanas = semanasDeRejilla(mes);
      expect(semanas.length).toBeGreaterThanOrEqual(4);
      expect(semanas.length).toBeLessThanOrEqual(6);
      for (const s of semanas) {
        expect(s).toHaveLength(7);
        expect(diaSemanaLunes(s[0]!)).toBe(0);
      }
    }
  });

  it("etiquetaRango habla de noches, no de días", () => {
    expect(etiquetaRango("2026-10-10", "2026-10-12")).toBe("10 oct → 12 oct · 2 noches");
    expect(etiquetaRango("2026-10-10", "2026-10-11")).toBe("10 oct → 11 oct · 1 noche");
  });
});

describe("contenidoPorDia -- noches vs días", () => {
  const dias = diasDelMes("2026-10");

  it("una estancia 10-12 ocupa las noches del 10 y el 11; el 12 es solo de salida", () => {
    const m = contenidoPorDia([el("a", "2026-10-10", "2026-10-12")], dias);
    expect(m.get("2026-10-09")!.noches).toHaveLength(0);
    expect(m.get("2026-10-10")!.noches).toHaveLength(1);
    expect(m.get("2026-10-11")!.noches).toHaveLength(1);
    expect(m.get("2026-10-12")!.noches).toHaveLength(0);
    expect(m.get("2026-10-12")!.salidas.map((e) => e.id)).toEqual(["a"]);
  });

  it("un check-out y un check-in el mismo día conviven: la salida de uno y la noche del otro", () => {
    const m = contenidoPorDia([el("a", "2026-10-10", "2026-10-12"), el("b", "2026-10-12", "2026-10-14")], dias);
    expect(m.get("2026-10-12")!.salidas.map((e) => e.id)).toEqual(["a"]);
    expect(m.get("2026-10-12")!.noches.map((e) => e.id)).toEqual(["b"]);
  });

  it("una estancia que cruza el fin de mes aparece en los últimos días de octubre y los primeros de noviembre", () => {
    const rejilla = semanasDeRejilla("2026-10").flat(); // incluye 1-nov (domingo)
    const m = contenidoPorDia([el("a", "2026-10-30", "2026-11-03")], rejilla);
    expect(m.get("2026-10-30")!.noches).toHaveLength(1);
    expect(m.get("2026-10-31")!.noches).toHaveLength(1);
    expect(m.get("2026-11-01")!.noches).toHaveLength(1);
    expect(m.has("2026-11-02")).toBe(false); // fuera de la rejilla de octubre
  });

  it("una estancia que empezó antes de la ventana y termina dentro solo pinta lo visible y su salida", () => {
    const m = contenidoPorDia([el("a", "2026-09-25", "2026-10-03")], dias);
    expect(m.get("2026-10-01")!.noches).toHaveLength(1);
    expect(m.get("2026-10-02")!.noches).toHaveLength(1);
    expect(m.get("2026-10-03")!.noches).toHaveLength(0);
    expect(m.get("2026-10-03")!.salidas).toHaveLength(1);
  });

  it("las limpiezas ocupan su día pero no cuentan como salida", () => {
    const tarea: TareaOperativa = { id: "t1", propertyId: "p", unidadId: "u1", unidadNombre: "U", tipo: "limpieza", estado: "pendiente", prioridad: "media", asignadoA: null, esProveedorExterno: false, programadaPara: "2026-10-12", slaVenceEn: null, completadaEn: null, creadoEn: "x" };
    const [limpieza] = construirElementos({ ocupaciones: [], tareas: [tarea], conflictos: [] });
    const m = contenidoPorDia([limpieza!], dias);
    expect(m.get("2026-10-12")!.noches).toHaveLength(1);
    expect(m.get("2026-10-13")!.salidas).toHaveLength(0);
  });

  it("limitarPorDia resume el exceso en '+N más'", () => {
    expect(limitarPorDia([1, 2, 3], 3)).toEqual({ visibles: [1, 2, 3], ocultos: 0 });
    expect(limitarPorDia([1, 2, 3, 4, 5], 3)).toEqual({ visibles: [1, 2, 3], ocultos: 2 });
  });
});

describe("capas: construirElementos, conflictos y filtros", () => {
  const conflicto = (estado: ConflictoCalendario["estado"], a: string, b: string | null): ConflictoCalendario => ({
    id: `k-${a}`,
    estado,
    motivoResolucion: null,
    detectadoEnLocal: null,
    resueltoEnLocal: null,
    resueltoPorMi: false,
    solape: null,
    unidadId: "u1",
    unidadNombre: null,
    tipo: "overbooking_confirmado",
    detectadoEn: "x",
    resueltoEn: null,
    ocupacionA: { id: a, inicio: "2026-10-10", fin: "2026-10-12", estado: "confirmado", capa: "reserva", canal: "airbnb" },
    ocupacionB: b ? { id: b, inicio: "2026-10-11", fin: "2026-10-13", estado: "confirmado", capa: "reserva", canal: "booking" } : null,
  });

  it("solo los conflictos ABIERTOS marcan ocupaciones", () => {
    const ids = idsEnConflicto([conflicto("abierto", "a", "b"), conflicto("resuelto", "c", "d"), conflicto("ignorado", "e", null)]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("una ocupación en conflicto (o conflicto_pendiente) se pinta como danger y se ordena primero", () => {
    const items = construirElementos({
      ocupaciones: [ocup("z", "2026-10-01", "2026-10-03"), ocup("a", "2026-10-10", "2026-10-12", { canalCodigo: "airbnb" }), ocup("p", "2026-10-20", "2026-10-22", { estado: "conflicto_pendiente" })],
      tareas: [],
      conflictos: [conflicto("abierto", "a", null)],
    });
    expect(items.map((e) => e.id)).toEqual(["a", "p", "z"]);
    expect(items.filter((e) => e.enConflicto).map((e) => tonoDeElemento(e, ["manual", "airbnb"]))).toEqual(["danger", "danger"]);
  });

  it("descarta canceladas, rangos vacíos o invertidos y tareas canceladas", () => {
    const cancelada: TareaOperativa = { id: "t", propertyId: "p", unidadId: "u1", unidadNombre: "U", tipo: "limpieza", estado: "cancelada", prioridad: "media", asignadoA: null, esProveedorExterno: false, programadaPara: "2026-10-12", slaVenceEn: null, completadaEn: null, creadoEn: "x" };
    const items = construirElementos({
      ocupaciones: [ocup("c", "2026-10-01", "2026-10-03", { estado: "cancelado" }), ocup("v", "2026-10-05", "2026-10-05"), ocup("i", "2026-10-09", "2026-10-07"), ocup("ok", "2026-10-10", "2026-10-11")],
      tareas: [cancelada],
      conflictos: [],
    });
    expect(items.map((e) => e.id)).toEqual(["ok"]);
  });

  it("la etiqueta de una reserva es el huésped (o el canal) y la de un bloqueo su razón; el contacto nunca viaja", () => {
    expect(elementoDeOcupacion(ocup("a", "2026-10-10", "2026-10-12", { huespedNombre: "Ana Pérez" })).etiqueta).toBe("Ana Pérez");
    expect(elementoDeOcupacion(ocup("b", "2026-10-10", "2026-10-12", { canalCodigo: "airbnb" })).etiqueta).toBe("Airbnb");
    expect(elementoDeOcupacion(ocup("c", "2026-10-10", "2026-10-12", { capa: "bloqueo", razon: "MANTENIMIENTO", canalCodigo: null })).etiqueta).toBe("Mantenimiento");
    expect(JSON.stringify(elementoDeOcupacion(ocup("d", "2026-10-10", "2026-10-12")))).not.toContain("contacto");
  });

  const base: ElementoCalendario[] = [
    el("r-airbnb", "2026-10-01", "2026-10-03", { canal: "airbnb", unidadId: "u1" }),
    el("r-directa", "2026-10-04", "2026-10-06", { canal: "manual", unidadId: "u2" }),
    el("bloq", "2026-10-07", "2026-10-09", { tipo: "bloqueo", canal: null, unidadId: "u1" }),
    el("limp", "2026-10-09", "2026-10-10", { tipo: "limpieza", canal: null, unidadId: "u2" }),
    el("conf", "2026-10-11", "2026-10-13", { enConflicto: true, canal: "booking", unidadId: "u1" }),
  ];

  it("filtra por unidad", () => {
    expect(filtrarElementos(base, { ...FILTROS_POR_DEFECTO, unidadId: "u2" }).map((e) => e.id)).toEqual(["r-directa", "limp"]);
  });

  it("el filtro de canal solo afecta a las reservas: bloqueos y limpiezas siguen visibles", () => {
    expect(filtrarElementos(base, { ...FILTROS_POR_DEFECTO, canal: "airbnb" }).map((e) => e.id)).toEqual(["r-airbnb", "bloq", "limp"]);
  });

  it("apagar una capa la oculta; apagar 'conflictos' quita el resalte pero no el elemento", () => {
    const sinBloqueos = filtrarElementos(base, { ...FILTROS_POR_DEFECTO, capas: { ...FILTROS_POR_DEFECTO.capas, bloqueos: false, limpiezas: false } });
    expect(sinBloqueos.map((e) => e.id)).toEqual(["r-airbnb", "r-directa", "conf"]);
    const sinResalte = filtrarElementos(base, { ...FILTROS_POR_DEFECTO, capas: { ...FILTROS_POR_DEFECTO.capas, conflictos: false } });
    expect(sinResalte.find((e) => e.id === "conf")!.enConflicto).toBe(false);
    expect(sinResalte).toHaveLength(5);
  });

  it("canales presentes: directa primero y el resto alfabético; el color es estable por canal", () => {
    const canales = canalesPresentes(base);
    expect(canales).toEqual(["manual", "airbnb", "booking"]);
    expect(tonoDeCanal("manual", canales)).toBe("success");
    expect(tonoDeCanal("airbnb", canales)).not.toBe(tonoDeCanal("booking", canales));
    expect(tonoDeCanal("airbnb", canales)).toBe(tonoDeCanal("airbnb", ["manual", "airbnb", "booking", "vrbo"]));
  });

  it("provisional = advertencia, bloqueo y limpieza = neutro", () => {
    expect(tonoDeElemento(el("p", "2026-10-01", "2026-10-02", { estado: "provisional" }), [])).toBe("warning");
    expect(tonoDeElemento(el("b", "2026-10-01", "2026-10-02", { tipo: "bloqueo" }), [])).toBe("neutral");
  });
});

describe("segmentosDeUnidad -- línea de tiempo", () => {
  const desde = "2026-10-01";
  const hasta = "2026-11-01";

  it("recorta a la ventana y marca los bordes abiertos", () => {
    const { segmentos } = segmentosDeUnidad([el("a", "2026-09-28", "2026-10-03"), el("b", "2026-10-30", "2026-11-04")], desde, hasta);
    expect(segmentos[0]).toMatchObject({ columna: 0, span: 2, continuaAntes: true, continuaDespues: false });
    expect(segmentos[1]).toMatchObject({ columna: 29, span: 2, continuaAntes: false, continuaDespues: true });
  });

  it("deja fuera lo que no toca la ventana, incluida una estancia que termina justo en `desde`", () => {
    const { segmentos } = segmentosDeUnidad([el("antes", "2026-09-28", "2026-10-01"), el("despues", "2026-11-01", "2026-11-03")], desde, hasta);
    expect(segmentos).toHaveLength(0);
  });

  it("estancias contiguas comparten carril; las que se solapan (conflicto) van en carriles distintos", () => {
    const contiguas = segmentosDeUnidad([el("a", "2026-10-10", "2026-10-12"), el("b", "2026-10-12", "2026-10-14")], desde, hasta);
    expect(contiguas.carriles).toBe(1);
    const solapadas = segmentosDeUnidad([el("a", "2026-10-10", "2026-10-13"), el("b", "2026-10-12", "2026-10-14"), el("c", "2026-10-13", "2026-10-15")], desde, hasta);
    expect(solapadas.carriles).toBe(2);
    expect(solapadas.segmentos.map((s) => s.carril)).toEqual([0, 1, 0]);
  });
});

describe("agendaDelMes -- móvil", () => {
  it("agrupa por día de llegada; lo que viene de antes del mes cuelga del día 1; excluye lo ajeno al mes", () => {
    const agenda = agendaDelMes([el("viene", "2026-09-29", "2026-10-03"), el("a", "2026-10-10", "2026-10-12"), el("b", "2026-10-10", "2026-10-11", { tipo: "bloqueo" }), el("sigue", "2026-10-30", "2026-11-04"), el("ajena", "2026-11-05", "2026-11-07"), el("termina", "2026-09-20", "2026-10-01")], "2026-10");
    expect(agenda.map((d) => d.fecha)).toEqual(["2026-10-01", "2026-10-10", "2026-10-30"]);
    expect(agenda[0]!.elementos.map((e) => e.id)).toEqual(["viene"]);
    expect(agenda[1]!.elementos.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("rendimiento con cientos de reservas", () => {
  it("600 elementos en 5 unidades: el mes se calcula completo, correcto y rápido", () => {
    const items: ElementoCalendario[] = [];
    for (let i = 0; i < 600; i++) {
      const inicio = sumarDias("2026-09-28", i % 35);
      items.push(el(`r${i}`, inicio, sumarDias(inicio, 1 + (i % 4)), { unidadId: `u${i % 5}` }));
    }
    const t0 = performance.now();
    const dias = semanasDeRejilla("2026-10").flat();
    const m = contenidoPorDia(items, dias);
    const total = [...m.values()].reduce((n, d) => n + d.noches.length, 0);
    for (let u = 0; u < 5; u++) segmentosDeUnidad(items.filter((e) => e.unidadId === `u${u}`), "2026-10-01", "2026-11-01");
    const ms = performance.now() - t0;
    expect(m.size).toBe(dias.length);
    expect(total).toBeGreaterThan(600);
    expect(ms).toBeLessThan(1500);
  });
});
