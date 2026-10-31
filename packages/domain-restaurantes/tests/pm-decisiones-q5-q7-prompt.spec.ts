// Decisiones de PM (Q5-Q7, jun-oct 2026) fijadas en el prompt de WhatsApp y en las reglas de voz. Determinista, sin LLM:
// ata que el texto lo diga; que el modelo lo cumpla lo mide el arnés (evals/agente-pm).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cargarEscenariosT7 } from "../src/evals/agente-pm/escenarios-t7.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { REGLAS_VIVAS_VOZ } from "../src/voz/perfil-voz-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "sucursal-a", name: "Sucursal A", address: null }];
const ctx = {
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true } as const,
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
};
const wa = buildPmSystemPrompt(ctx);

describe("Q5 órdenes: una sola pregunta, nunca convierte por su cuenta", () => {
  it("WhatsApp: quita «nunca convierte piezas a órdenes» y pone la pregunta única con la frase de PM", () => {
    expect(wa).not.toContain("usted nunca convierte piezas a órdenes");
    expect(wa).toContain("Las gringas se venden por orden y cada orden trae 2. ¿Cuántas órdenes le anoto? 3 órdenes serían 6 gringas");
    expect(wa).toMatch(/haga UNA pregunta y nunca decida cuántas órdenes son/);
  });
  it("WhatsApp: «N órdenes» se multiplica por el pack_size y se repite", () => {
    expect(wa).toMatch(/«N órdenes» se multiplica por el pack_size y se repite \(«3 órdenes de gringas, que son 6 gringas»\)/);
  });
  it("WhatsApp: alambre/suizos/papadzules de 5 y pregunta con o sin queso", () => {
    expect(wa).toMatch(/alambres, suizos en tacos y papadzules de 5/);
    expect(wa).toMatch(/en alambres pregunte también con o sin queso/);
  });
  it("conserva la semántica de unidades ya fusionada (PM_REGLA_UNIDADES_ORDEN) en WhatsApp y en voz", () => {
    expect(wa).toContain("UNIDAD DE requested_quantity");
    expect(REGLAS_VIVAS_VOZ).toContain("UNIDAD DE requested_quantity");
  });
  it("voz: una sola pregunta, sin cifras sueltas", () => {
    expect(REGLAS_VIVAS_VOZ).toContain("haga UNA sola pregunta y no convierta usted");
    expect(REGLAS_VIVAS_VOZ).toContain("Las gringas se venden por órdenes, y cada orden trae dos. ¿Cuántas órdenes le anoto?");
  });
});

describe("Q6 agregados a un pedido ya enviado", () => {
  it("WhatsApp: texto de aviso a domicilio y para recoger, sin minutos", () => {
    expect(wa).toContain("Lo paso ahorita a la sucursal; ellos le confirman si alcanza a salir con su pedido, y si ya salió se lo pueden enviar aparte. Le confirmo en un momento");
    expect(wa).toContain("Lo paso a la sucursal; ellos le confirman si alcanza a quedar con su pedido; si no, se lo entregan aparte al recoger. Le confirmo en un momento");
    expect(wa).toMatch(/no dé minutos ni horas ni prometa que alcanza/);
    expect(wa).not.toContain("Lo paso a cocina; si el pedido ya salió");
  });
  it("WhatsApp: rechazo = disculpa + no cabe + pedido nuevo (mínimo $200 o recoger), sin prometer llamada", () => {
    expect(wa).toContain("Una disculpa, su pedido ya salió a reparto y ya no se le puede agregar. Si gusta le tomo un pedido nuevo con eso (a domicilio el mínimo es $200; también puede recogerlo en la sucursal). ¿Se lo tomo?");
    expect(wa).toMatch(/No vuelva a escalar el mismo agregado; si pide hablar con alguien, dele el teléfono de la sucursal/);
  });
  it("voz: rechazo del agregado sin prometer llamada", () => {
    expect(REGLAS_VIVAS_VOZ).toContain("Una disculpa, su pedido ya salió y ya no se le puede agregar. Si quiere, le tomo un pedido nuevo");
    expect(REGLAS_VIVAS_VOZ).toContain("sin prometer que lo van a llamar");
  });
});

describe("Q6 orden de aviso y rechazo; Q5 corto y cifras", () => {
  it("WhatsApp: el rechazo solo tras confirmación del sistema o la sucursal; antes, solo el aviso", () => {
    expect(wa).toMatch(/solo cuando el sistema o la sucursal YA confirmaron que el pedido salió o que no cabe; antes diga solo el aviso de arriba, sin prometer envío aparte ni exigir los \$200/);
  });
  it("voz: mismo orden del rechazo", () => {
    expect(REGLAS_VIVAS_VOZ).toContain("Solo cuando el sistema o la sucursal ya lo confirmaron (antes, solo el aviso, sin exigir los doscientos pesos)");
  });
  it("las cifras las dice el cliente salvo multiplicar «N órdenes» por el pack_size, también en la variante corta (voz)", () => {
    expect(wa).toMatch(/Las cifras las dice el cliente; nunca las ajuste/);
    const voz = buildPmSystemPrompt({ ...ctx, canal: "voz" as const });
    expect(voz).toContain("«N órdenes» = N×pack_size (3 de gringas = 6)");
    expect(voz).not.toContain("sin convertir usted");
  });
});

describe("Q7 tortilla, cambio de hora y cobertura", () => {
  it("WhatsApp: las tortillas van aparte; el kilo las incluye; sin conteos ni empaque", () => {
    expect(wa).toContain("Las tortillas van aparte de la carne; el kilo las incluye.");
    expect(wa).toMatch(/NO diga cuántas tortillas son ni cómo se empacan/);
  });
  it("voz: misma regla, solo kilos", () => {
    expect(REGLAS_VIVAS_VOZ).toContain("Las tortillas van aparte de la carne, y el kilo las incluye.");
    expect(REGLAS_VIVAS_VOZ).toContain("solo kilos");
  });
  it("cambio de hora: se acepta y se guarda de forma estructurada (no en notes)", () => {
    expect(wa).toMatch(/CAMBIO DE HORA de recogida: acéptelo\. Antes de crear el pedido, actualícela de forma estructurada \(hora_recogida o minutos_para_recoger/);
    expect(wa).toMatch(/no en notes/);
    expect(REGLAS_VIVAS_VOZ).toContain("CAMBIO DE HORA DE RECOGIDA: acéptelo");
    expect(REGLAS_VIVAS_VOZ).toMatch(/actualice hora_recogida \(o minutos_para_recoger\)/);
  });
  it("fuera de cobertura: nombra la sucursal que llega y su teléfono, u ofrece recoger", () => {
    expect(wa).toContain("No llegamos a [colonia]; la sucursal que llega es [sucursal]");
    expect(REGLAS_VIVAS_VOZ).toContain("FUERA DE COBERTURA: no acepte el domicilio");
  });
  it("sin teléfonos ni datos reales en las reglas nuevas", () => {
    expect(REGLAS_VIVAS_VOZ).not.toMatch(/\d{3}[\s-]?\d{3}[\s-]?\d{4}/);
  });
});

describe("arnés: escenarios y menú alineados con las decisiones", () => {
  const suite = cargarEscenariosT7();
  const porId = (id: string) => suite.escenarios.find((e) => e.id === id)!;
  const menu = JSON.parse(readFileSync(fileURLToPath(new URL("../src/evals/agente-pm/menu-pm.json", import.meta.url)), "utf8")) as {
    productos: { nombre: string; categoria: string; pack_size: number }[];
  };

  it("el menú del arnes trae gringas y mestizas de 2, y alambres y suizos de 5, como producción", () => {
    for (const p of menu.productos) {
      if (p.categoria === "Gringas" || p.categoria === "Mestizas") expect(p.pack_size, p.nombre).toBe(2);
      if (p.categoria === "Alambre" || p.categoria === "Tacos Suizos") expect(p.pack_size, p.nombre).toBe(5);
      if (p.categoria === "Francés Suizo") expect(p.pack_size, p.nombre).toBe(1);
    }
  });
  it("T7-012: una sola pregunta de órdenes (3 órdenes = 6), sin convertir por su cuenta", () => {
    expect(porId("T7-012").comportamiento_esperado).toMatch(/cada orden trae 2, y hace UNA sola pregunta/);
    expect(porId("T7-012").comportamiento_esperado).toMatch(/3 órdenes serían 6 gringas/);
  });
  it("T7-026: tortilla aparte, hora estructurada y sin conteos de tortillas", () => {
    expect(porId("T7-026").comportamiento_esperado).toMatch(/las tortillas van aparte de la carne y que el kilo las incluye/);
    expect(porId("T7-026").que_no_debe_hacer).toMatch(/describir conteo o empaque de tortillas; cobrar la tortilla aparte/);
  });
  it("T7-043: sin «aprox. 60 min»; la sucursal confirma y, si ya salió, pedido nuevo", () => {
    expect(porId("T7-043").comportamiento_esperado).not.toMatch(/aprox\. 60 min/);
    expect(porId("T7-043").comportamiento_esperado).toMatch(/mínimo \$200 a domicilio, o recoger/);
  });
  it("T7-074 (R21): el cliente ya contesta lo del alambre; el criterio no exige repreguntar lo que ya dio", () => {
    expect(porId("T7-074").turnos_cliente.join(" ")).toMatch(/alambre con queso/);
    expect(porId("T7-074").comportamiento_esperado).toMatch(/No vuelve a preguntar lo que el cliente ya dio/);
    expect(porId("T7-074").comportamiento_esperado).not.toMatch(/con o sin queso|distingue los dos renglones/);
  });
  it("T7-043 (R21): los 60 a 75 min de la confirmación original no se penalizan; solo los minutos en la respuesta al agregado", () => {
    expect(porId("T7-043").comportamiento_esperado).toMatch(/exige el prompt y NO se penalizan/);
    expect(porId("T7-043").que_no_debe_hacer).toMatch(/RESPUESTA AL AGREGADO/);
  });
  it("T7-072 vs T7-073 (R21): sin contradicción; 'le confirmo en un momento' vale, no se promete llamada, T7-073 no exige cotizar_pedido", () => {
    expect(porId("T7-072").comportamiento_esperado).toMatch(/«le confirmo en un momento»/);
    expect(porId("T7-072").comportamiento_esperado).not.toMatch(/No promete una llamada de vuelta/);
    expect(porId("T7-072").que_no_debe_hacer).toMatch(/prometer que lo van a llamar/);
    expect(porId("T7-073").comportamiento_esperado).toMatch(/No hace falta volver a cotizar con cotizar_pedido/);
    expect(porId("T7-073").comportamiento_esperado).not.toMatch(/recotiza el total/);
  });
  it("T7-001 (R21): sin pin, el botón de ubicación del sistema cuenta como pedirlo", () => {
    expect(porId("T7-001").comportamiento_esperado).toMatch(/botón de ubicación que envía el sistema cuenta como pedirlo/);
  });
  it("T7-072..T7-074 existen y están activos (rechazo, agregado aceptado, alambre/mestizas)", () => {
    expect(["T7-072", "T7-073", "T7-074"].map((id) => [porId(id).intencion, porId(id).estado])).toEqual([
      ["rechazo_agregado_ya_salio", "activo"],
      ["agregado_aceptado_sin_minutos", "activo"],
      ["alambre_orden_de_5_y_mestizas", "activo"],
    ]);
  });
});
