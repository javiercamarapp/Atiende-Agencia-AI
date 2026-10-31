import { describe, expect, it } from "vitest";
import { ConfigInvalidaError, generarComportamientoVoz, generarPromptWhatsApp, generarSeed } from "../src/plantilla/generador.ts";
import { COMPORTAMIENTO_VOZ_MAX } from "../src/voz/perfil-voz-pm.ts";
import type { RestauranteConfig } from "../src/plantilla/tipos.ts";
import { validarConfig } from "../src/plantilla/validar.ts";
import { PM_RESTAURANTE_CONFIG } from "../src/plantilla/config-pm.ts";

const DIAS = [0, 1, 2, 3, 4, 5, 6];
/** Restaurante de prueba 100 % ficticio, sin relacion con PM. */
export const PIZZERIA: RestauranteConfig = {
  schemaVersion: 1,
  slug: "pizzeria-la-brasa",
  marca: { nombre: "Pizzería La Brasa", agente: "Rafa", saludo: null, tiempoEntrega: "a domicilio de 30 a 45 min; para recoger 20 min" },
  negocio: { giro: "pizzería", articuloGiro: "la", ciudad: "Monterrey, Nuevo León", zonaHoraria: "America/Monterrey" },
  sucursales: [
    { slug: "centro", nombre: "Centro", direccion: "Calle Ficticia 123", telefono: "5550100", activa: true, reparte: true, horario: [{ dias: DIAS, abre: "13:00", cierra: "23:00" }] },
    { slug: "norte", nombre: "Norte", direccion: null, telefono: null, activa: true, reparte: false, horario: [{ dias: [5, 6], abre: "13:00", cierra: "01:00" }] },
  ],
  menu: {
    categorias: ["Pizzas", "Bebidas"],
    productos: [
      { nombre: "Hawaiana grande", categoria: "Pizzas", precio: 189, alias: ["hawaiana"] },
      { nombre: "Pepperoni grande", categoria: "Pizzas", precio: 199, precioPorSucursal: { norte: 209 } },
      { nombre: "Cola 600 ml", categoria: "Bebidas", precio: 25 },
    ],
  },
  politicas: { pedidoMinimoDomicilio: 150, costoEnvio: 0, propina: "preguntar", transferencia: "si", promosTexto: "martes 2x1 en pizzas medianas, solo para recoger", salsasTexto: "cátsup y orégano", pedidoGrandeTexto: "más de $2,500", urlFacturacion: null, motivosDesactivados: [] },
  promociones: [{ codigo: "mar2x1", nombre: "Martes 2x1", tipo: "bogo", dias: [2], canales: ["recoger"], productos: ["Hawaiana grande"], descripcion: "2x1 en hawaiana" }],
  conocimiento: [{ titulo: "Alergias", texto: "Consultar con el gerente.", tipo: "politica" }],
  voz: { habilitada: true },
};

describe("generador: otro restaurante sale de la misma plantilla sin rastros de PM", () => {
  const wa = generarPromptWhatsApp(PIZZERIA, { saludo: "Buenas noches", fechaHoraLocal: "viernes 20:00", diaSemana: "viernes" });
  const voz = generarComportamientoVoz(PIZZERIA);
  it("usa los datos del negocio", () => {
    expect(wa).toContain("Rafa de Pizzería La Brasa, pizzería de Monterrey, Nuevo León");
    expect(wa).toContain("(America/Monterrey)");
    expect(wa).toContain("pedido mínimo de $150");
    expect(wa).toContain("martes 2x1 en pizzas medianas");
    expect(wa).toContain("de la pizzería");
    expect(wa).toContain("Centro");
  });
  it("no filtra lo especifico de PM (literales parametrizados)", () => {
    for (const t of [wa, voz]) {
      expect(t).not.toContain("$200");
      expect(t).not.toContain("America/Merida");
      expect(t).not.toMatch(/taquería de Mérida/);
    }
  });
  it("politicas de pago: propina preguntar y transferencia si", () => {
    expect(wa).toContain("efectivo, tarjeta o transferencia");
    expect(wa).toContain("pregunte UNA vez si desea agregar propina");
    expect(wa).not.toContain("NUNCA pregunte por la propina");
    expect(wa).toContain("NUNCA invente ni dé datos bancarios");
    expect(voz).toContain("Transferencia: sí; nunca dé datos bancarios");
  });
  it("voz cabe en el tope de 8000 y es determinista", () => {
    expect(voz.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
    expect(generarComportamientoVoz(PIZZERIA)).toBe(voz);
  });
  it("solo sucursales activas entran al prompt", () => {
    const c = { ...PIZZERIA, sucursales: [PIZZERIA.sucursales[0]!, { ...PIZZERIA.sucursales[1]!, activa: false }] };
    expect(generarPromptWhatsApp(c)).not.toContain("slug: norte");
  });
});

describe("validarConfig", () => {
  it("la pizzeria de prueba es valida sin advertencias", () => {
    expect(validarConfig(PIZZERIA)).toEqual({ ok: true, errores: [], advertencias: [] });
  });
  it("detecta errores de precio, categoria, alias, promo y horario; el generador se niega", () => {
    const mala: RestauranteConfig = {
      ...PIZZERIA,
      slug: "Mala Config",
      negocio: { ...PIZZERIA.negocio, zonaHoraria: "Marte/Olimpo" },
      sucursales: [{ ...PIZZERIA.sucursales[0]!, horario: [{ dias: [9], abre: "25:00", cierra: "23:00" }] }],
      menu: { categorias: ["Pizzas"], productos: [{ nombre: "A", categoria: "Pizzas", precio: 0, alias: ["x"] }, { nombre: "B", categoria: "Otra", precio: 10, alias: ["x"] }, { nombre: "a", categoria: "Pizzas", precio: 12.5 }] },
      promociones: [{ codigo: "p", nombre: "p", tipo: "bogo", dias: [2], canales: ["recoger"], productos: ["Fantasma"], descripcion: "d" }],
      politicas: { ...PIZZERIA.politicas, pedidoMinimoDomicilio: -1, urlFacturacion: "http://inseguro" },
    };
    const v = validarConfig(mala);
    expect(v.ok).toBe(false);
    const joined = v.errores.join("\n");
    for (const frag of ["slug", "zona IANA", "dias", "precio 0", "categoria \"Otra\"", "Alias \"x\"", "duplicado", "Fantasma", "pedidoMinimoDomicilio", "urlFacturacion"]) expect(joined).toContain(frag);
    expect(() => generarPromptWhatsApp(mala)).toThrow(ConfigInvalidaError);
  });
  it("costoEnvio distinto de 0 no esta soportado", () => {
    expect(validarConfig({ ...PIZZERIA, politicas: { ...PIZZERIA.politicas, costoEnvio: 30 as unknown as 0 } }).errores.join()).toContain("costoEnvio");
  });
  it("PM solo-perfil no exige menu; completo si", () => {
    expect(validarConfig(PM_RESTAURANTE_CONFIG, { soloPerfil: true }).ok).toBe(true);
    expect(validarConfig(PM_RESTAURANTE_CONFIG).errores.join()).toContain("menu no tiene productos");
  });
});

describe("generarSeed", () => {
  const s = generarSeed(PIZZERIA);
  it("es determinista y refleja la config", () => {
    expect(generarSeed(PIZZERIA)).toEqual(s);
    expect(s.organizacion).toEqual({ slug: "pizzeria-la-brasa", nombre: "Pizzería La Brasa" });
    expect(s.productos.map((p) => p.slug)).toEqual(["hawaiana-grande", "pepperoni-grande", "cola-600-ml"]);
    expect(s.productos[1]!.preciosPorSucursal).toEqual({ centro: 199, norte: 209 });
    expect(s.agenteWhatsApp.largeOrderText).toBe("más de $2,500");
    expect(s.voz.comportamiento).toBe(generarComportamientoVoz(PIZZERIA));
  });
  it("PM como seed de perfil: voz igual al comportamiento historico y sin productos", () => {
    const pm = generarSeed(PM_RESTAURANTE_CONFIG, { soloPerfil: true });
    expect(pm.productos).toEqual([]);
    expect(pm.voz.comportamiento).toBe(generarComportamientoVoz(PM_RESTAURANTE_CONFIG, { soloPerfil: true }));
    expect(pm.sucursales).toHaveLength(7);
  });
  it("texto del agente fuera de limite se rechaza", () => {
    expect(() => generarSeed({ ...PIZZERIA, politicas: { ...PIZZERIA.politicas, promosTexto: "x".repeat(301) } })).toThrow(/promosTexto/);
  });
});
