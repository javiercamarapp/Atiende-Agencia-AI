// Ajustes del prompt de PM que salen de los chats reales de T7 (2-oct-2026): lluvia, pin automático, aviso de salida, pago, facturación.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../../src/whatsapp/llm-turn-handler.ts";
import { PM_MARGEN_LLUVIA_MINUTOS, buildPmSystemPrompt } from "../../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../../src/types.ts";

function prompt(over: Partial<Parameters<typeof buildPmSystemPrompt>[0]> = {}) {
  return buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "Lupita",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: [{ propertyId: "p1", slug: "t7", name: "Sucursal de prueba", address: null } as BranchSummary],
    entryBranch: null,
    customer: { isNew: true },
    fechaHoraLocal: "2 de octubre de 2026, 14:10",
    diaSemana: "viernes",
    ...over,
  });
}

describe("prompt PM: lo que enseñan los chats de T7", () => {
  it("lluvia: tiempo de la sucursal más un margen, ya no la cifra fija de 1 h a 1 h 20", () => {
    for (const canal of ["whatsapp", "voz"] as const) {
      const p = prompt({ canal });
      expect(p).toContain(`más unos ${PM_MARGEN_LLUVIA_MINUTOS} minutos`);
      expect(p).not.toMatch(/1 hora a 1 hora 20/);
    }
  });

  it("pin: se guarda solo en el pedido, no se anota en notes; los campos de pago y acceso tienen su propio parámetro", () => {
    const p = prompt();
    expect(p).toMatch(/no los repita ni los anote en notes/);
    expect(p).toContain("indicaciones_acceso");
    expect(p).toContain("telefono_alterno");
    expect(p).toContain("efectivo_con");
    expect(p).toContain("llevar_terminal");
    expect(p).not.toMatch(/sirve también una captura del mapa/);
  });

  it("«¿me avisan cuando salga?»: sí se promete el aviso de salida; el de llegada no", () => {
    const p = prompt();
    expect(p).toMatch(/sí, el sistema le manda un mensaje de "va en camino"/);
    expect(p).toMatch(/Un aviso de LLEGADA del repartidor no existe/);
    expect(p).not.toMatch(/no prometa un aviso que no existe/);
  });

  it("jerga de salsas y piña gratis si la piden", () => {
    const p = prompt();
    expect(p).toMatch(/xnipec/);
    expect(p).toMatch(/sauceada/);
    expect(p).toMatch(/piña picada \(gratis si la piden/);
  });

  it("facturación: con enlace configurado lo da; sin enlace NO lo inventa y escala", () => {
    expect(prompt({ urlFacturacion: "https://facturas.ejemplo.test/pm" })).toContain("Dé este enlace de facturación en línea: https://facturas.ejemplo.test/pm");
    const sin = prompt();
    expect(sin).toMatch(/No tiene el enlace de facturación: NO lo invente/);
    expect(sin).not.toContain("https://facturas.ejemplo.test");
    // Un valor que no es https (o con espacios) se trata como ausente.
    expect(prompt({ urlFacturacion: "javascript:alert(1)" })).toMatch(/No tiene el enlace de facturación/);
    expect(prompt({ urlFacturacion: "http://inseguro.test" })).toMatch(/No tiene el enlace de facturación/);
  });

  it("llegada para recoger y pedido hecho por teléfono usan registrar_contacto con su motivo y el mensaje fijo", () => {
    const p = prompt();
    expect(p).toMatch(/LLEGADA PARA RECOGER[^\n]*reason "cliente_llego"[^\n]*SOLO el "mensaje_al_cliente"/);
    expect(p).toMatch(/PEDIDO HECHO POR TELÉFONO[^\n]*NO cree pedido[^\n]*reason "pedido_telefonico"/);
  });

  it("escalación: no promete «en un momento»; de madrugada dice cuándo responde el equipo", () => {
    const p = prompt();
    expect(p).not.toMatch(/en un momento le responden/);
    expect(p).toMatch(/entre la 1 am y las 12 del día[^\n]*a partir de las 12 del día/);
  });
});
