// ds3 «Guía»: motor puro del recorrido (maquina de estados, viaje automatico, construccion desde el menu real, geometria que no tapa
// el foco), progreso local/servidor y paridad de textos ES/EN.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  colocarTarjeta,
  construirTour,
  contarPasos,
  crearViaje,
  enPantalla,
  estadoInicial,
  eventoDeTecla,
  eventoDeTeclado,
  gruposDe,
  HOLGURA_FOCO,
  ladoHojaMovil,
  objetivosMenu,
  pantallaActiva,
  planearViaje,
  puedeTomarFoco,
  reducir,
  reducirViaje,
  rutaRelativa,
  siguienteDelPaso,
  slugDe,
  teclaQueCancela,
  teclasPropias,
  ventanaRuta,
  type ContenidoConsola,
  type Rect,
  type SeccionMenu,
} from "../src/components/guia/motor";
import { claveProgreso, hashCorto, leerLocal, guardarLocal, limpiarProgresoGuia, normalizar, PROGRESO_VACIO, reconciliar, type Almacen } from "../src/components/guia/estado";
import { interpolar, TEXTOS_GUIA, traductorGuia } from "../src/components/guia/textos";

const BASE = "/restaurantes/taqueria";
const MENU: SeccionMenu[] = [
  { title: "Resumen", items: [{ to: BASE, label: "Resumen" }, { to: `${BASE}/copiloto`, label: "Copiloto" }] },
  { title: "Operación", items: [{ to: `${BASE}/operacion`, label: "Cola" }, { to: `${BASE}/operacion/viajes`, label: "Viajes" }, { to: `${BASE}/pedidos`, label: "Pedidos" }] },
  { title: "Catálogo", items: [{ to: `${BASE}/productos`, label: "Productos" }] },
  { title: "Clientes", items: [{ to: `${BASE}/clientes`, label: "Clientes" }, { to: `${BASE}/pedidos`, label: "Pedidos (repetido)" }] },
  { title: "Configuración", items: [{ to: `${BASE}/primeros-pasos`, label: "Primeros pasos" }] },
];
const T = (es: string) => ({ es, en: es });
const CONTENIDO: ContenidoConsola = {
  "": { ilu: "barras", que: T("Resumen del día"), clave: { titulo: T("Cifras"), cuerpo: T("Lo que vendiste") }, accion: { titulo: T("Exportar"), cuerpo: T("Baja el informe") } },
  pedidos: { ilu: "pedido", que: T("Pedidos"), clave: { titulo: T("Tabla"), cuerpo: T("Cada pedido") } },
};

describe("construirTour (desde el menu real del rol)", () => {
  const completo = construirTour(MENU, "completo", { base: BASE, contenido: CONTENIDO, excluir: ["primeros-pasos"] });
  it("una pantalla por item, sin repetir rutas ni visitar las excluidas, y un cierre", () => {
    expect(gruposDe(completo).map((g) => g.href)).toEqual([BASE, `${BASE}/copiloto`, `${BASE}/operacion`, `${BASE}/operacion/viajes`, `${BASE}/pedidos`, `${BASE}/productos`, `${BASE}/clientes`]);
    expect(completo.at(-1)).toMatchObject({ id: "cierre", tipo: "cierre" });
  });
  it("por pantalla: ir + que (+ clave y accion si la pantalla las tiene); ids estables", () => {
    expect(completo.filter((p) => p.pantalla === BASE).map((p) => p.id)).toEqual(["resumen.ir", "resumen.que", "resumen.clave", "resumen.accion"]);
    expect(completo.filter((p) => p.pantalla === `${BASE}/operacion/viajes`).map((p) => p.id)).toEqual(["operacion-viajes.ir", "operacion-viajes.que"]);
    expect(completo.find((p) => p.id === "pedidos.que")?.ilu).toBe("pedido");
  });
  it("el paso «ir» señala el item real del menu por su href (sin anclas nuevas en el shell) y recuerda su grupo", () => {
    const ir = completo.find((p) => p.id === "productos.ir")!;
    expect(ir.objetivos).toContain(`aside a[href="${BASE}/productos"]`);
    expect(ir.menuGrupo).toBe("Catálogo");
  });
  it("corto: las esenciales en su orden, 5 como maximo; 5 pantallas con clave en la primera = 7 pasos con el cierre", () => {
    const corto = construirTour(MENU, "corto", { base: BASE, contenido: CONTENIDO, esenciales: ["", "pedidos", "productos", "clientes", "copiloto", "operacion"] });
    expect(gruposDe(corto).map((g) => g.href)).toEqual([BASE, `${BASE}/pedidos`, `${BASE}/productos`, `${BASE}/clientes`, `${BASE}/copiloto`]);
    expect(contarPasos(corto)).toBe(7);
    expect(corto.some((p) => p.clave === "accion")).toBe(false);
    // Mismos ids en los dos modos: lo guardado sirve en ambos.
    for (const p of corto) expect(completo.some((c) => c.id === p.id) || p.id === "cierre").toBe(true);
  });
  it("corto sin esenciales: las primeras 5 del menu; menu vacio: sin recorrido", () => {
    expect(gruposDe(construirTour(MENU, "corto", { base: BASE })).length).toBe(5);
    expect(construirTour([], "completo", { base: BASE })).toEqual([]);
  });
  it("texto generico honesto cuando la pantalla no tiene contenido propio", () => {
    expect(completo.find((p) => p.id === "clientes.que")?.cuerpo?.es).toContain("{pantalla}");
  });
});

describe("rutas", () => {
  it("enPantalla: exacta o subruta; pantallaActiva elige la mas especifica", () => {
    expect(enPantalla(`${BASE}/pedidos/42`, `${BASE}/pedidos`)).toBe(true);
    expect(enPantalla(`${BASE}/pedidosx`, `${BASE}/pedidos`)).toBe(false);
    expect(pantallaActiva(`${BASE}/operacion/viajes`, [BASE, `${BASE}/operacion`, `${BASE}/operacion/viajes`])).toBe(`${BASE}/operacion/viajes`);
    expect(pantallaActiva("/otra", [BASE])).toBeNull();
  });
  it("rutaRelativa y slugDe", () => {
    expect(rutaRelativa(BASE, BASE)).toBe("");
    expect(rutaRelativa(`${BASE}/operacion/viajes`, BASE)).toBe("operacion/viajes");
    expect(slugDe("")).toBe("resumen");
    expect(slugDe("operacion/viajes")).toBe("operacion-viajes");
  });
  it("objetivosMenu escapa comillas", () => {
    expect(objetivosMenu('/a"b')[1]).toBe('aside a[href="/a\\"b"]');
  });
});

describe("maquina de estados del recorrido", () => {
  const pasos = construirTour(MENU, "completo", { base: BASE, contenido: CONTENIDO, excluir: ["primeros-pasos"] });
  const n = pasos.length;
  it("solo `abrir` abre; un cambio de ruta nunca abre ni cierra", () => {
    expect(reducir(estadoInicial(), { tipo: "ruta", ruta: `${BASE}/pedidos` }, n, pasos, BASE).abierto).toBe(false);
    const abierto = reducir(estadoInicial(), { tipo: "abrir" }, n, pasos, "/otra");
    expect(abierto).toMatchObject({ abierto: true, indice: 0, iniciadoPorPersona: true });
    expect(reducir(abierto, { tipo: "ruta", ruta: "/otra/cosa" }, n, pasos, "/otra/cosa")).toBe(abierto);
  });
  it("abrir en la pantalla del primer «ir» lo salta", () => {
    expect(pasos[reducir(estadoInicial(), { tipo: "abrir" }, n, pasos, BASE).indice]?.id).toBe("resumen.que");
  });
  it("llegar a la pantalla de un «ir» lo completa", () => {
    const enIr = reducir(estadoInicial(), { tipo: "abrir", indice: pasos.findIndex((p) => p.id === "copiloto.ir") }, n, pasos, BASE);
    expect(pasos[enIr.indice]?.id).toBe("copiloto.ir");
    const llego = reducir(enIr, { tipo: "ruta", ruta: `${BASE}/copiloto` }, n, pasos, `${BASE}/copiloto`);
    expect(pasos[llego.indice]?.id).toBe("copiloto.que");
  });
  it("Anterior nunca cae en un «ir»; Esc conserva el paso; Siguiente en el ultimo termina", () => {
    const enQue = reducir(estadoInicial(), { tipo: "abrir", indice: pasos.findIndex((p) => p.id === "copiloto.que") }, n, pasos, `${BASE}/copiloto`);
    expect(pasos[reducir(enQue, { tipo: "anterior" }, n, pasos, `${BASE}/copiloto`).indice]?.id).toBe("resumen.accion");
    const cerrado = reducir(enQue, { tipo: "cerrar" }, n, pasos);
    expect(cerrado).toMatchObject({ abierto: false, indice: enQue.indice, terminado: false });
    const ultimo = reducir(estadoInicial(), { tipo: "abrir", indice: n - 1 }, n, pasos);
    expect(reducir(ultimo, { tipo: "siguiente" }, n, pasos)).toMatchObject({ abierto: false, terminado: true });
  });
  it("sin pasos: estado inicial", () => {
    expect(reducir(estadoInicial(), { tipo: "abrir" }, 0)).toEqual(estadoInicial());
  });
});

describe("teclado", () => {
  it("Esc siempre sale; flechas y Enter respetan campos, modificadores y la tarjeta", () => {
    expect(eventoDeTecla("Escape", "INPUT", { propias: true })).toEqual({ tipo: "cerrar" });
    expect(eventoDeTecla("ArrowRight", "DIV")).toEqual({ tipo: "siguiente" });
    expect(eventoDeTecla("ArrowRight", "INPUT", { propias: true })).toBeNull();
    expect(eventoDeTecla("ArrowLeft", "DIV", { modificador: true })).toBeNull();
    expect(eventoDeTecla("Enter", "BUTTON")).toBeNull();
    expect(eventoDeTeclado({ key: "Enter", defaultPrevented: false, tagName: "DIV", dentroDeTarjeta: false, propias: false, modificador: false })).toBeNull();
    expect(eventoDeTeclado({ key: "Enter", defaultPrevented: false, tagName: "DIV", dentroDeTarjeta: true, propias: false, modificador: false })).toEqual({ tipo: "siguiente" });
    expect(eventoDeTeclado({ key: "Escape", defaultPrevented: true, tagName: "DIV", dentroDeTarjeta: true, propias: false, modificador: false })).toBeNull();
    expect(teclasPropias({ tagName: "DIV", getAttribute: () => "tab" })).toBe(true);
    expect(teclasPropias({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(teclasPropias(null)).toBe(false);
  });
  it("Tab y Esc cancelan la cuenta (Esc se consume)", () => {
    expect(teclaQueCancela("Tab")).toEqual({ motivo: "tab", consumir: false });
    expect(teclaQueCancela("Escape")).toEqual({ motivo: "escape", consumir: true });
    expect(teclaQueCancela("a")).toBeNull();
  });
  it("puedeTomarFoco: no le quita el foco a quien trabaja en la pagina", () => {
    expect(puedeTomarFoco({ activo: null, dentroDeGuia: false, esDisparador: false })).toBe(true);
    expect(puedeTomarFoco({ activo: {}, dentroDeGuia: false, esDisparador: false })).toBe(false);
    expect(puedeTomarFoco({ activo: {}, dentroDeGuia: true, esDisparador: false })).toBe(true);
  });
});

describe("viaje automatico", () => {
  it("planear: solo armado, con elemento resuelto, sin movimiento reducido, campo ni formulario", () => {
    expect(planearViaje({ tipo: "info", armado: true, elemento: "existe" }).motivo).toBe("no-ir");
    expect(planearViaje({ tipo: "ir", armado: false, elemento: "existe" }).motivo).toBe("no-armado");
    expect(planearViaje({ tipo: "ir", armado: true, elemento: "buscando" }).motivo).toBe("buscando");
    expect(planearViaje({ tipo: "ir", armado: true, elemento: "existe", movimientoReducido: true })).toMatchObject({ manual: true, motivo: "movimiento-reducido" });
    expect(planearViaje({ tipo: "ir", armado: true, elemento: "existe", focoEnCampo: true }).motivo).toBe("campo");
    expect(planearViaje({ tipo: "ir", armado: true, elemento: "ausente", formularioSucio: true }).motivo).toBe("formulario");
    expect(planearViaje({ tipo: "ir", armado: true, elemento: "ausente" })).toMatchObject({ armar: true, ms: 3000 });
  });
  it("cuenta de 3 s -> viaja una sola vez; Siguiente durante el viaje no dispara otro; sin ruta en 3 s -> fallo", () => {
    vi.useFakeTimers();
    const alViajar = vi.fn();
    const ctl = crearViaje({ alViajar });
    ctl.enviar({ tipo: "planear", plan: planearViaje({ tipo: "ir", armado: true, elemento: "existe" }) });
    expect(ctl.estado()).toMatchObject({ fase: "cuenta", restan: 3 });
    vi.advanceTimersByTime(3000);
    expect(alViajar).toHaveBeenCalledTimes(1);
    ctl.enviar({ tipo: "siguiente" });
    expect(alViajar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(ctl.estado().fase).toBe("fallo");
    ctl.destruir();
    vi.useRealTimers();
  });
  it("cancelar solo durante la cuenta (queda manual); clic propio espera la ruta; reiniciar limpia", () => {
    let e = reducirViaje({ fase: "cuenta", restan: 2, motivo: null }, { tipo: "cancelar", motivo: "quedarme" }).estado;
    expect(e).toEqual({ fase: "manual", restan: 0, motivo: "quedarme" });
    expect(reducirViaje(e, { tipo: "cancelar", motivo: "x" }).estado).toBe(e);
    const clic = reducirViaje(e, { tipo: "clic" });
    expect(clic).toEqual({ estado: { fase: "viajando", restan: 0, motivo: null }, efecto: null });
    e = reducirViaje(clic.estado, { tipo: "reiniciar" }).estado;
    expect(e.fase).toBe("inactivo");
  });
  it("siguienteDelPaso: info avanza; ir sin conductor lleva; ir con fallo continua; ir con conductor pasa por el", () => {
    const despachar = vi.fn();
    const llevar = vi.fn();
    expect(siguienteDelPaso({ tipo: "info", conductor: null, despachar, llevar })).toBe("avanzar");
    expect(siguienteDelPaso({ tipo: "ir", conductor: null, despachar, llevar })).toBe("llevar");
    const enviar = vi.fn();
    expect(siguienteDelPaso({ tipo: "ir", conductor: { enviar, estado: () => ({ fase: "fallo", restan: 0, motivo: null }) }, despachar, llevar })).toBe("continuar");
    expect(siguienteDelPaso({ tipo: "ir", conductor: { enviar, estado: () => ({ fase: "cuenta", restan: 2, motivo: null }) }, despachar, llevar })).toBe("conductor");
    expect(enviar).toHaveBeenCalledWith({ tipo: "siguiente" });
  });
});

describe("colocarTarjeta: la tarjeta NUNCA tapa el elemento resaltado (bug de Rovaq a 1440)", () => {
  const V = { width: 1440, height: 900 };
  const C = { width: 380, height: 386 };
  const toca = (o: Rect, p: { left: number; top: number }) => {
    const f = { left: o.left - HOLGURA_FOCO, top: o.top - HOLGURA_FOCO, width: o.width + 2 * HOLGURA_FOCO, height: o.height + 2 * HOLGURA_FOCO };
    return p.left < f.left + f.width && f.left < p.left + C.width && p.top < f.top + f.height && f.top < p.top + C.height;
  };
  it("la franja de 4 KPI a lo ancho arriba (el caso de Rovaq): la tarjeta va abajo, sin tocarla", () => {
    const kpi = { left: 272, top: 140, width: 1140, height: 120 };
    const p = colocarTarjeta(kpi, C, V);
    expect(p.tapa).toBe(false);
    expect(toca(kpi, p)).toBe(false);
  });
  it("barrido: ningun objetivo razonable queda tapado, en escritorio y tablet", () => {
    for (const v of [V, { width: 1024, height: 768 }, { width: 1280, height: 720 }]) {
      for (let x = 0; x < v.width - 200; x += 97) {
        for (let y = 0; y < v.height - 120; y += 83) {
          const o = { left: x, top: y, width: 200, height: 40 };
          const p = colocarTarjeta(o, C, v);
          expect(p.tapa).toBe(false);
          expect(toca(o, p)).toBe(false);
          expect(p.left).toBeGreaterThanOrEqual(16);
          expect(p.top + C.height).toBeLessThanOrEqual(v.height);
        }
      }
    }
  });
  it("objetivo enorme: elige la posicion con menos area tapada y lo dice", () => {
    expect(colocarTarjeta({ left: 0, top: 0, width: 1440, height: 900 }, C, V).tapa).toBe(true);
  });
  it("sin objetivo: centrada", () => {
    expect(colocarTarjeta(null, C, V)).toMatchObject({ left: 530, top: 257, centrada: true, tapa: false });
  });
  it("movil: la hoja sube arriba si el objetivo queda bajo su borde", () => {
    expect(ladoHojaMovil({ left: 0, top: 700, width: 300, height: 40 }, 844, 300, 75)).toBe("arriba");
    expect(ladoHojaMovil({ left: 0, top: 100, width: 300, height: 40 }, 844, 300, 75)).toBe("abajo");
    expect(ladoHojaMovil(null, 844, 300, 75)).toBe("abajo");
  });
  it("ventanaRuta: 5 pantallas alrededor de la actual", () => {
    const v = ventanaRuta(["a", "b", "c", "d", "e", "f", "g"], 4);
    expect(v.items.map((i) => i.nombre)).toEqual(["c", "d", "e", "f", "g"]);
    expect(v).toMatchObject({ antes: true, despues: false });
  });
});

describe("progreso", () => {
  class Mem implements Almacen {
    m = new Map<string, string>();
    getItem(k: string) { return this.m.get(k) ?? null; }
    setItem(k: string, v: string) { this.m.set(k, v); }
    removeItem(k: string) { this.m.delete(k); }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    get length() { return this.m.size; }
  }
  it("la clave lleva hash, nunca el id en claro; cambia con persona, organizacion y rol", () => {
    const k = claveProgreso("user-123", "taqueria", "restaurantes.owner");
    expect(k).not.toContain("user-123");
    expect(k).toMatch(/^atiende-guia\.v1\.[0-9a-f]{8}\.restaurantes\.owner$/);
    expect(hashCorto("a", "b")).not.toBe(hashCorto("a", "c"));
  });
  it("lee y guarda; JSON roto, almacen ausente o que lanza = vacio, nunca rompe", () => {
    const a = new Mem();
    expect(guardarLocal(a, "k", { ...PROGRESO_VACIO, paso: "pedidos.que", visto: true, actualizado: 5 })).toBe(true);
    expect(leerLocal(a, "k")).toMatchObject({ paso: "pedidos.que", visto: true, actualizado: 5 });
    a.setItem("k", "{roto");
    expect(leerLocal(a, "k")).toEqual(PROGRESO_VACIO);
    expect(leerLocal(null, "k")).toEqual(PROGRESO_VACIO);
    const lanza = { ...a, getItem: () => { throw new Error("privado"); }, setItem: () => { throw new Error("cuota"); } } as unknown as Almacen;
    expect(leerLocal(lanza, "k")).toEqual(PROGRESO_VACIO);
    expect(guardarLocal(lanza, "k", PROGRESO_VACIO)).toBe(false);
  });
  it("normalizar descarta formas raras y pasos fuera de formato", () => {
    expect(normalizar({ paso: "<x>", modo: "largo", visto: "si", actualizado: "2026-11-06T00:00:00Z" })).toMatchObject({ paso: null, modo: null, visto: false, actualizado: Date.parse("2026-11-06T00:00:00Z") });
  });
  it("reconciliar: gana la copia mas nueva y «terminado» nunca se pierde", () => {
    const local = { ...PROGRESO_VACIO, paso: "a.que", terminado: true, actualizado: 10 };
    const remoto = { ...PROGRESO_VACIO, paso: "b.que", actualizado: 20 };
    expect(reconciliar(local, remoto)).toMatchObject({ paso: "b.que", terminado: true });
    expect(reconciliar(local, null)).toBe(local);
    expect(reconciliar({ ...local, actualizado: 30 }, remoto).paso).toBe("a.que");
  });
  it("al cerrar sesion se borran solo las claves de la guia", () => {
    const a = new Mem();
    a.setItem("atiende-guia.v1.x.y", "1");
    a.setItem("atiende-guia.pp.z", "1");
    a.setItem("otra", "1");
    expect(limpiarProgresoGuia(a)).toBe(2);
    expect(a.getItem("otra")).toBe("1");
  });
});

describe("textos ES/EN", () => {
  it("mismas claves y mismas variables en los dos idiomas", () => {
    const es = TEXTOS_GUIA.es as Record<string, string>;
    const en = TEXTOS_GUIA.en as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
    const vars = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    for (const k of Object.keys(es)) expect(vars(en[k]!), k).toEqual(vars(es[k]!));
  });
  it("interpola y deja visible una variable que falta (nunca la inventa)", () => {
    expect(traductorGuia("en")("guia.menu.corto", { n: 7 })).toBe("Short tour (7 steps)");
    expect(traductorGuia("es")("guia.tarjeta.paso", { n: 3, total: 58 })).toBe("Paso 3 de 58");
    expect(interpolar("{a} y {b}", { a: 1 })).toBe("1 y {b}");
  });
});

describe("CSS de la guia", () => {
  const css = readFileSync(join(__dirname, "../src/components/guia/guia.css"), "utf8");
  it("todo vive bajo la bandera ds3: sin ella la guia no se pinta", () => {
    expect(css).toMatch(/html:not\(\[data-diseno="ds3"\]\) \.guia-raiz \{ display: none !important; \}/);
  });
  it("la capa de foco nunca recibe clics y el movimiento va dentro de prefers-reduced-motion", () => {
    expect(css).toMatch(/\.guia-capa \{[^}]*pointer-events: none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("movimiento de la paleta ds3: curva de la app y duraciones 120/180/250/360", () => {
    expect(css).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
    for (const ms of ["120ms", "180ms", "250ms", "360ms"]) expect(css).toContain(ms);
  });
});
