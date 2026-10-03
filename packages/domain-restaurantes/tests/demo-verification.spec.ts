// DEMO-PM -- el evaluador de la verificacion de la demo convierte HECHOS de la base en un checklist con veredicto. Aqui se prueba con
// hechos construidos a mano (la consulta SQL real corre contra Postgres en scripts/verify-restaurantes-demo-volumen, escenarios V19).
import { describe, expect, it } from "vitest";
import { parseVerificarArgs } from "../../../scripts/seed-pm-demo/verificar-demo.ts";
import { demoLista, evaluarVerificacionDemo, renderDemoVerificationSql, type DemoFacts } from "../src/seed/demo-verification.ts";

const BUENOS: DemoFacts = {
  org: { id: "o1", demo: true, activo: true },
  sucursales: [
    { slug: "garcia-lavin", status: "active" },
    { slug: "altabrisa", status: "inactive" },
  ],
  agente: { perfil: "taqueria_pm", enabled: true },
  vozT7Habilitada: false,
  volumen: { pedidos: 139, clientes: 70, sucursales: 1, porSlug: { "garcia-lavin": 139 }, whatsapp: 139, domicilio: 110, tarjeta: 62, clientesRecurrentes: 32, pedidosDeRecurrentes: 101, ticketMediano: 643, minutosDomicilioMediana: 65 },
  sesionesWidget: { pedidos: 0, conversaciones: 0 },
};
const con = (cambio: Partial<DemoFacts>): DemoFacts => ({ ...BUENOS, ...cambio });
const falla = (f: DemoFacts) => evaluarVerificacionDemo(f).filter((c) => c.nivel === "requisito" && !c.ok).map((c) => c.id);

describe("evaluarVerificacionDemo", () => {
  it("la demo bien cargada (perfil T7) pasa todos los requisitos", () => {
    const checks = evaluarVerificacionDemo(BUENOS);
    expect(falla(BUENOS)).toEqual([]);
    expect(demoLista(checks)).toBe(true);
    expect(checks.find((c) => c.id === "recurrentes")!.detalle).toContain("73 %");
  });

  it("organizacion inexistente o no marcada como demo: no esta lista y el mensaje dice como arreglarlo", () => {
    expect(falla(con({ org: null }))).toContain("org-demo");
    const noDemo = evaluarVerificacionDemo(con({ org: { id: "o1", demo: false, activo: true } })).find((c) => c.id === "org-demo")!;
    expect(noDemo.ok).toBe(false);
    expect(noDemo.detalle).toContain("--demo");
  });

  it("widget apagado, T7 inactiva o agente generico/apagado: cada uno falla por separado", () => {
    expect(falla(con({ org: { id: "o1", demo: true, activo: false } }))).toEqual(["widget-activo"]);
    expect(falla(con({ sucursales: [{ slug: "garcia-lavin", status: "inactive" }] }))).toEqual(["t7-activa"]);
    expect(falla(con({ sucursales: [] }))).toEqual(["t7-activa"]);
    expect(falla(con({ agente: { perfil: "generico", enabled: true } }))).toEqual(["agente-pm"]);
    expect(falla(con({ agente: { perfil: "taqueria_pm", enabled: false } }))).toEqual(["agente-pm"]);
    expect(falla(con({ agente: null }))).toEqual(["agente-pm"]);
  });

  it("sin volumen: falla y NO inventa porcentajes; con volumen generico en varias sucursales falla la regla de solo T7", () => {
    const vacio = con({ volumen: { ...BUENOS.volumen, pedidos: 0, clientes: 0, sucursales: 0, porSlug: {}, whatsapp: 0, domicilio: 0, tarjeta: 0, clientesRecurrentes: 0, pedidosDeRecurrentes: 0, ticketMediano: null, minutosDomicilioMediana: null } });
    expect(falla(vacio)).toEqual(expect.arrayContaining(["volumen-cargado", "volumen-solo-t7", "volumen-ritmo", "recurrentes", "ticket", "tiempos"]));
    const generico = con({ volumen: { ...BUENOS.volumen, pedidos: 2200, sucursales: 3, porSlug: { "garcia-lavin": 700, "prol-montejo": 900, pensiones: 600 } } });
    const ids = falla(generico);
    expect(ids).toContain("volumen-solo-t7");
    expect(ids).toContain("volumen-ritmo");
  });

  it("ritmo fuera de lo real (recurrentes, domicilio, ticket, tiempos) se reporta con la cifra", () => {
    const raro = con({ volumen: { ...BUENOS.volumen, pedidosDeRecurrentes: 40, domicilio: 40, ticketMediano: 1500, minutosDomicilioMediana: 30, whatsapp: 100 } });
    expect(falla(raro).sort()).toEqual(["domicilio", "recurrentes", "ticket", "tiempos", "whatsapp"].sort());
    expect(evaluarVerificacionDemo(raro).find((c) => c.id === "ticket")!.detalle).toContain("$1500");
  });

  it("voz apagada y sesiones previas del widget son AVISOS honestos: no impiden la demo", () => {
    const f = con({ sesionesWidget: { pedidos: 3, conversaciones: 2 }, vozT7Habilitada: true });
    const checks = evaluarVerificacionDemo(f);
    expect(demoLista(checks)).toBe(true);
    const sesiones = checks.find((c) => c.id === "sesiones-widget")!;
    expect(sesiones).toMatchObject({ nivel: "aviso", ok: false });
    expect(sesiones.detalle).toContain("sesiones_widget");
    expect(checks.find((c) => c.id === "voz")!.detalle).toContain("credenciales");
    expect(evaluarVerificacionDemo(BUENOS).find((c) => c.id === "voz")!.detalle).toContain("DESHABILITADA");
  });
});

describe("renderDemoVerificationSql", () => {
  it("es de SOLO LECTURA: ninguna sentencia que escriba", () => {
    const sql = renderDemoVerificationSql();
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant)\b/i);
    expect(sql).toContain("$1");
    expect(sql).toContain("0001");
    expect(sql).toContain("0009");
  });
});

describe("verificar-demo (CLI): argumentos", () => {
  it("valida el slug y la URL de la API", () => {
    expect(parseVerificarArgs([])).toEqual({ help: false, orgSlug: "los-taquitos-de-pm-demo", apiUrl: null });
    expect(parseVerificarArgs(["--api-url=https://api.ejemplo.com/"]).apiUrl).toBe("https://api.ejemplo.com");
    expect(() => parseVerificarArgs(["--api-url=ftp://x"])).toThrow(/http/);
    expect(() => parseVerificarArgs(["--org-slug=Mal Slug"])).toThrow(/invalido/);
    expect(() => parseVerificarArgs(["--apply"])).toThrow(/desconocido/);
  });
});
