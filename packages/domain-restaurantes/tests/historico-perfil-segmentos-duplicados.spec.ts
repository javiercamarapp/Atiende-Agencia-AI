// Perfil 360 historico y su uso por el agente, duplicados y segmentos RFM / cuentas. Datos sinteticos y reloj fijo.
import { describe, expect, it } from "vitest";
import { lineasCliente360 } from "../src/cliente-360/prompt.ts";
import { clavePorTelefono, fusionarDomicilios, planFusionPorTelefono, proponerDuplicadosPorNombre, type ClienteParaFusion } from "../src/historico/duplicados.ts";
import { contextoLoMismoParaMensaje, construirPerfil360, clasificarFrecuencia, frescuraDelDato, lineasPerfilHistorico, ofertaLoMismo, perfilParaAgente, type EntradaPerfil } from "../src/historico/perfil.ts";
import { mapPerfilHistorico } from "../src/historico/postgres.ts";
import { etiquetarCuentas, percentil, resumirSegmentos, segmentarRfm, UMBRALES_POR_OMISION, type ClienteParaSegmento } from "../src/historico/segmentos.ts";
import { adjuntarPerfilHistorico } from "../src/historico/uso.ts";
import type { RestaurantesRepository } from "../src/repository.ts";
import type { CustomerLookupResult } from "../src/types.ts";

const HOY = new Date("2026-10-31T12:00:00Z");

const entrada = (extra: Partial<EntradaPerfil> = {}): EntradaPerfil => ({
  nombre: "Cliente Ejemplo A",
  domicilios: [{ etiqueta: "Histórico", colonia: "Montebello", importado: true, ultimoUso: null }],
  historico: { canal: "domicilio", pago: "efectivo", tortilla: "maiz", salsas: ["verde"], omisiones: [], favoritos: ["bistec", "pastor", "cochinita"], pedidos: 8, gastoMxn: 1600, ticketMxn: 200, primerPedido: "2026-01-05", ultimoPedido: "2026-10-20", quejas: [], revisionHumana: false },
  ...extra,
});

describe("frescura del dato", () => {
  it("bordes 30/31/180/181 dias; lo importado nunca es fresco", () => {
    const f = (dias: number, importado = false) => frescuraDelDato({ fecha: new Date(HOY.getTime() - dias * 86_400_000).toISOString().slice(0, 10), importado, hoy: HOY });
    expect([f(0), f(29), f(30)]).toEqual(["fresco", "fresco", "fresco"]);
    expect([f(31), f(179), f(180), f(181)]).toEqual(["viejo", "viejo", "viejo", "caducado"]);
    expect(f(1, true)).toBe("viejo");
    expect(f(400, true)).toBe("caducado");
    expect(frescuraDelDato({ fecha: null, importado: true, hoy: HOY })).toBe("viejo");
  });
  it("frecuencia por umbrales fijos", () => {
    expect(clasificarFrecuencia(0, null, null)).toBe("sin_historial");
    expect(clasificarFrecuencia(1, "2026-01-01", "2026-01-01")).toBe("unica");
    expect(clasificarFrecuencia(3, "2026-01-01", "2026-10-01")).toBe("ocasional");
    expect(clasificarFrecuencia(8, "2026-01-01", "2026-10-01")).toBe("regular");
    expect(clasificarFrecuencia(12, "2025-01-01", "2026-10-01")).toBe("frecuente");
  });
});

describe("perfil 360", () => {
  it("combina historico y pedidos reales: lo real gana sobre lo importado de valor unico", () => {
    const p = construirPerfil360(entrada({ gustosReales: [{ kind: "tortilla", valor: "harina", veces: 3, ultimaVez: "2026-10-25" }], pedidosReales: 2, ultimoPedidoReal: "2026-10-25T10:00:00Z" }), HOY);
    expect(p.gustos.filter((g) => g.kind === "tortilla")).toEqual([{ kind: "tortilla", valor: "harina", frescura: "fresco", fuente: "pedido" }]);
    expect(p).toMatchObject({ pedidosTotales: 10, pedidosReales: 2, ultimaCompra: "2026-10-25", diasDesdeUltimaCompra: 6, ticketMxn: 200, tieneHistorialImportado: true });
    expect(p.domicilios[0]).toMatchObject({ frescura: "viejo", requierePin: false });
  });
  it("colonia inferida o ausente: requierePin; sin historial no hay perfil importado", () => {
    const inf = construirPerfil360(entrada({ domicilios: [{ etiqueta: null, colonia: "Centro", importado: true, ultimoUso: null, coloniaInferida: true }, { etiqueta: null, colonia: null, importado: true, ultimoUso: null }] }), HOY);
    expect(inf.domicilios.map((d) => d.requierePin)).toEqual([true, true]);
    expect(construirPerfil360({ nombre: "X" }, HOY).tieneHistorialImportado).toBe(false);
  });
  it("oferta: pedido real -> repetir_pedido; solo favoritos -> pregunta con maximo 2; nada -> ninguna", () => {
    expect(ofertaLoMismo({ pedidosReales: 1, favoritos: ["a"] }).tipo).toBe("pedido_real");
    expect(ofertaLoMismo({ pedidosReales: 0, favoritos: ["bistec", "pastor", "cochinita"] })).toEqual({ tipo: "favoritos", favoritos: ["bistec", "pastor"], pregunta: "¿Le preparo su favorito, bistec y pastor?" });
    expect(ofertaLoMismo({ pedidosReales: 0, favoritos: [] }).tipo).toBe("ninguna");
  });
});

describe("uso por el agente", () => {
  const agente = () => perfilParaAgente(construirPerfil360(entrada(), HOY));
  it("las lineas confirman, no inventan y NUNCA llevan calle, numero, telefono, montos ni quejas", () => {
    const conQueja = perfilParaAgente(construirPerfil360(entrada({ historico: { ...entrada().historico!, quejas: ["cobro"] } }), HOY));
    const texto = [...lineasPerfilHistorico(agente()), ...lineasPerfilHistorico(conQueja)].join("\n");
    expect(texto).toContain("confirma SIEMPRE");
    expect(texto).toContain("¿Le preparo su favorito, bistec y pastor?");
    expect(texto).toContain("SIEMPRE pregunta con cuánto paga");
    expect(texto).toContain("especial cuidado");
    expect(texto).not.toMatch(/\d{4,}/);
    expect(texto).not.toMatch(/1600|200|cobro|gasto|ticket/i);
    expect(JSON.stringify(agente())).not.toMatch(/gasto|ticket|quejas|calle|telefono/i);
  });
  it("sin historial importado no agrega ninguna linea (el prompt actual no cambia)", () => {
    expect(lineasPerfilHistorico(undefined)).toEqual([]);
    expect(lineasPerfilHistorico(perfilParaAgente(construirPerfil360({ nombre: "X" }, HOY)))).toEqual([]);
  });
  it("domicilio incierto: la linea manda pedir colonia/pin y no lo ofrece", () => {
    const p = perfilParaAgente(construirPerfil360(entrada({ domicilios: [{ etiqueta: null, colonia: "Centro", importado: true, ultimoUso: null, coloniaInferida: true }] }), HOY));
    const t = lineasPerfilHistorico(p).join("\n");
    expect(t).toContain("NO lo ofrezcas");
    expect(t).not.toContain("Domicilio que puedes confirmar");
  });
  it("«lo de siempre»: solo responde cuando el mensaje lo pide; con pedido real manda a repetir_pedido; sin nada, no inventa", () => {
    expect(contextoLoMismoParaMensaje(agente(), "hola buenas tardes")).toBeNull();
    expect(contextoLoMismoParaMensaje(agente(), "lo de siempre porfa")).toContain("espera su confirmación");
    const real = perfilParaAgente(construirPerfil360(entrada({ pedidosReales: 3 }), HOY));
    expect(contextoLoMismoParaMensaje(real, "lo mismo de la vez pasada")).toContain("repetir_pedido");
    const nada = perfilParaAgente(construirPerfil360(entrada({ historico: { ...entrada().historico!, favoritos: [] } }), HOY));
    expect(contextoLoMismoParaMensaje(nada, "lo de siempre")).toContain("no inventes");
  });
  it("lineasCliente360 es identica sin perfilHistorico y suma las lineas con el", () => {
    const base = { isNew: false, name: "Ana", orderCount: 0, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] } as const;
    const sin = lineasCliente360(base);
    const con = lineasCliente360({ ...base, perfilHistorico: agente() });
    expect(con.slice(0, sin.length)).toEqual(sin);
    expect(con.length).toBeGreaterThan(sin.length);
  });
  it("adjuntarPerfilHistorico: sin metodo en el repo, sin historial o con error devuelve el MISMO objeto; con historial lo agrega", async () => {
    const base = { isNew: false, name: "Ana", orderCount: 0, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] } as Extract<CustomerLookupResult, { isNew: false }>;
    const repo = (f?: () => Promise<EntradaPerfil | null | undefined>) => ({ getPerfilHistorico: f }) as unknown as RestaurantesRepository;
    expect(await adjuntarPerfilHistorico(repo(), "o", "9990000001", base, HOY)).toBe(base);
    expect(await adjuntarPerfilHistorico(repo(async () => null), "o", "9990000001", base, HOY)).toBe(base);
    expect(await adjuntarPerfilHistorico(repo(async () => undefined), "o", "9990000001", base, HOY)).toBe(base);
    expect(await adjuntarPerfilHistorico(repo(async () => { throw new Error("boom"); }), "o", "9990000001", base, HOY)).toBe(base);
    const r = await adjuntarPerfilHistorico(repo(async () => entrada()), "o", "9990000001", base, HOY);
    expect(r.perfilHistorico?.oferta.tipo).toBe("favoritos");
  });
  it("mapPerfilHistorico descarta valores fuera de catalogo", () => {
    const e = mapPerfilHistorico({ nombre: "X", domicilios: [], historico: { canal: "volando", pago: "efectivo", tortilla: "x", quejas: ["cobro", "inventada"], favoritos: ["a"], pedidos: "4", gasto_mxn: "10.5" } });
    expect(e.historico).toMatchObject({ canal: null, pago: "efectivo", tortilla: null, quejas: ["cobro"], pedidos: 4, gastoMxn: 10.5 });
  });
});

describe("duplicados", () => {
  const c = (id: string, phone: string, extra: Partial<ClienteParaFusion> = {}): ClienteParaFusion => ({ id, phone, name: null, orderCount: 0, lastOrderAt: null, createdAt: "2026-01-01T00:00:00Z", ...extra });
  it("agrupa por ultimos 10 digitos, elige sobreviviente determinista y suma pedidos conservando el historial", () => {
    const grupos = planFusionPorTelefono([
      c("b", "5219990000001", { orderCount: 1, lastOrderAt: "2026-05-01T00:00:00Z", name: "Ana" }),
      c("a", "9990000001", { orderCount: 3, lastOrderAt: "2026-03-01T00:00:00Z" }),
      c("z", "9990000002"),
      c("s", "12345", { orderCount: 9 }),
      c("t", "12345", { orderCount: 1 }),
    ]);
    expect(grupos).toEqual([{ clave: "9990000001", sobreviviente: "a", absorbidos: ["b"], orderCountTotal: 4, lastOrderAt: "2026-05-01T00:00:00Z", nombre: "Ana" }]);
    expect(clavePorTelefono("12345")).toBeNull();
  });
  it("empate de pedidos: gana el mas antiguo y luego el menor id", () => {
    const g = planFusionPorTelefono([c("y", "9990000005", { createdAt: "2026-02-01T00:00:00Z" }), c("x", "529990000005", { createdAt: "2026-01-01T00:00:00Z" })]);
    expect(g[0]!.sobreviviente).toBe("x");
    const g2 = planFusionPorTelefono([c("m", "9990000006"), c("k", "529990000006")]);
    expect(g2[0]!.sobreviviente).toBe("k");
  });
  it("domicilios iguales se unen (gana el que tiene colonia, suma usos, un solo predeterminado)", () => {
    const r = fusionarDomicilios([
      [{ address: "Calle 10 #5", colonia: null, timesUsed: 2, isDefault: true }],
      [{ address: "calle 10  #5", colonia: "Montebello", timesUsed: 1, isDefault: true }, { address: "Calle 20", colonia: null, timesUsed: 0, isDefault: false }],
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ colonia: "Montebello", timesUsed: 3, isDefault: true });
    expect(r.filter((d) => d.isDefault)).toHaveLength(1);
  });
  it("por nombre solo se PROPONE; «Juan» solo no es suficiente; mismo telefono no se propone (se fusiona)", () => {
    const p = proponerDuplicadosPorNombre([
      c("1", "9990000011", { name: "Maria Lopez Prueba", colonia: "Centro" }),
      c("2", "9990000022", { name: "María López Prueba", colonia: "Centro" }),
      c("3", "9990000012", { name: "Maria Lopez Prueba", colonia: "Altabrisa" }),
      c("4", "9990000033", { name: "Juan" }),
      c("5", "9990000044", { name: "Juan" }),
      c("6", "529990000011", { name: "Maria Lopez Prueba", colonia: "Centro" }),
    ]);
    expect(p).toEqual([
      { a: "1", b: "2", motivo: "mismo_nombre_y_colonia" },
      { a: "1", b: "3", motivo: "telefono_difiere_un_digito_mismo_nombre" },
      { a: "2", b: "3", motivo: "telefono_difiere_un_digito_mismo_nombre" },
      { a: "2", b: "6", motivo: "mismo_nombre_y_colonia" },
      { a: "3", b: "6", motivo: "telefono_difiere_un_digito_mismo_nombre" },
    ]);
    expect(p.some((x) => x.a === "4" || x.b === "4")).toBe(false);
    expect(p.some((x) => (x.a === "1" && x.b === "6") || (x.a === "6" && x.b === "1"))).toBe(false);
  });
});

describe("segmentos RFM y cuentas", () => {
  const k = (id: string, extra: Partial<ClienteParaSegmento>): ClienteParaSegmento => ({ id, pedidos: 1, gastoMxn: 100, ticketMxn: 100, primerPedido: "2026-01-01", ultimoPedido: "2026-10-25", ...extra });
  const clientes: ClienteParaSegmento[] = [
    k("campeon", { pedidos: 10, gastoMxn: 3000, ticketMxn: 300, ultimoPedido: "2026-10-20" }),
    k("riesgo", { pedidos: 5, gastoMxn: 2500, ticketMxn: 500, ultimoPedido: "2026-08-01" }),
    k("dormido", { pedidos: 2, gastoMxn: 200, ticketMxn: 100, ultimoPedido: "2026-05-01" }),
    k("nuevo", { pedidos: 1, gastoMxn: 90, primerPedido: "2026-10-15", ultimoPedido: "2026-10-15" }),
    k("regular", { pedidos: 3, gastoMxn: 300, primerPedido: "2026-02-01", ultimoPedido: "2026-10-01" }),
    k("queja", { pedidos: 4, gastoMxn: 150, ultimoPedido: "2026-02-01", revisionHumana: true }),
    k("kilo", { pedidos: 4, gastoMxn: 4400, ticketMxn: 1100, ultimoPedido: "2026-10-28", kilosTotales: 12 }),
    k("evento", { pedidos: 1, gastoMxn: 2100, ticketMxn: 2100, primerPedido: "2026-09-01", ultimoPedido: "2026-09-01" }),
    k("limite", { pedidos: 1, gastoMxn: 1999, ticketMxn: 2000, primerPedido: "2026-01-01", ultimoPedido: "2026-10-30" }),
  ];
  it("percentil por rango mas cercano (igual que percentile_disc)", () => {
    expect(percentil([100, 200, 300, 400], 0.75)).toBe(300);
    expect(percentil([0, 0], 0.75)).toBeNull();
  });
  it("asigna cada segmento con los umbrales por omision", () => {
    const m = new Map(segmentarRfm(clientes, HOY).map((s) => [s.id, s]));
    expect(m.get("campeon")?.segmento).toBe("campeon");
    expect(m.get("riesgo")).toMatchObject({ segmento: "en_riesgo_alto_valor", altoValor: true, reactivable: true });
    expect(m.get("dormido")).toMatchObject({ segmento: "dormido", reactivable: true });
    expect(m.get("nuevo")?.segmento).toBe("nuevo");
    expect(m.get("regular")?.segmento).toBe("regular");
    expect(m.get("campeon")?.reactivable).toBe(false);
  });
  it("la queja abierta (revision humana) jamas es reactivable", () => {
    expect(segmentarRfm(clientes, HOY).find((s) => s.id === "queja")).toMatchObject({ segmento: "dormido", reactivable: false });
  });
  it("cuentas: kilo por volumen, evento solo con ticket ESTRICTAMENTE mayor a $2,000 y siempre «sugerida»", () => {
    const c = etiquetarCuentas(clientes);
    expect(c).toEqual([
      { id: "evento", tipos: ["evento"], estado: "sugerida" },
      { id: "kilo", tipos: ["kilo"], estado: "sugerida" },
    ]);
    expect(etiquetarCuentas(clientes, { ...UMBRALES_POR_OMISION, ticketEvento: 3000 })).toEqual([{ id: "kilo", tipos: ["kilo"], estado: "sugerida" }]);
  });
  it("resumen y determinismo ante el orden de entrada", () => {
    const r = resumirSegmentos(clientes, HOY);
    expect(r.porSegmento.campeon).toBe(1);
    expect(r.cuentasKilo).toBe(1);
    expect(r.candidatasEvento).toBe(1);
    expect(resumirSegmentos([...clientes].reverse(), HOY)).toEqual(r);
  });
});
