// PAQUETE A (PM): gancho de cliente recurrente («¿lo de siempre?»). Solo diseño: sin datos reales. S20 y S21 sintéticos.
// SEGURIDAD: la dirección guardada solo se muestra si el teléfono es el del REMITENTE de WhatsApp.
import { describe, expect, it } from "vitest";
import { esLoDeSiempre, planReconocimientoRecurrente, proveedorClientesSinDatos } from "../src/cliente-360/reconocer-recurrente.ts";

describe("esLoDeSiempre", () => {
  it.each(["Lo mismo de siempre, cambio de 500", "lo de siempre", "Lo mismo", "repite mi último pedido", "igual que la vez pasada", "lo mismo que la vez pasada"])("sí: %s", (t) => {
    expect(esLoDeSiempre(t)).toBe(true);
  });
  it.each(["quiero 3 tacos", "siempre me mandan frío", "hola", "quiero lo mismo que pidió mi amigo con dos salsas extra", "dame lo mismo que el vecino", "lo mismo para mi vecino", "lo mismo para mi mamá"])("no: %s", (t) => {
    expect(esLoDeSiempre(t)).toBe(false);
  });
});

const REM = "5219990000000";
const base = { telefonoRemitente: REM, texto: "lo mismo de siempre" };
const CLIENTE = { direccionGuardada: "Calle Ficticia 1, Colonia Ejemplo", ultimoPedido: { items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 1 }] } };

describe("planReconocimientoRecurrente", () => {
  it("el proveedor vacío (sin base de clientes) devuelve null y nunca inventa", async () => {
    expect(await proveedorClientesSinDatos.buscarPorTelefono("9990000000")).toBeNull();
  });
  it("S21: número no registrado + «lo mismo» -> no inventa historial, pide pedido completo y registra nuevo", () => {
    const p = planReconocimientoRecurrente({ ...base, cliente: null });
    expect(p.accion).toBe("pedir_pedido_completo");
    expect(p.registrarClienteNuevo).toBe(true);
    expect(p.mensajeGuia).toMatch(/no tengo registrado/i);
    expect(p.recotizarConMenuVigente).toBe(false);
  });
  it("S20: cliente con pedido anterior -> propone, recotiza con menú vigente y confirma antes de cocina", () => {
    const p = planReconocimientoRecurrente({ ...base, cliente: CLIENTE });
    expect(p.accion).toBe("proponer_lo_de_siempre");
    expect(p.recotizarConMenuVigente).toBe(true);
    expect(p.confirmarAntesDeCocina).toBe(true);
    expect(p.confirmarDireccion).toBe("Calle Ficticia 1, Colonia Ejemplo");
    expect(p.mensajeGuia).not.toMatch(/\$\d/);
  });
  it("cliente conocido sin pedido anterior: no hay «de siempre»", () => {
    const p = planReconocimientoRecurrente({ ...base, cliente: { direccionGuardada: "Calle Ficticia 1", ultimoPedido: null } });
    expect(p.accion).toBe("pedir_pedido_completo");
    expect(p.registrarClienteNuevo).toBe(false);
  });
  it("sin la frase y cliente conocido: confirma dirección guardada", () => {
    const p = planReconocimientoRecurrente({ telefonoRemitente: REM, texto: "hola", cliente: { direccionGuardada: "Calle Ficticia 1", ultimoPedido: null } });
    expect(p.accion).toBe("confirmar_direccion");
  });
  it("teléfono dicho = el del remitente en otro formato: sí vincula", () => {
    const p = planReconocimientoRecurrente({ ...base, telefonoDicho: "999 000 0000", cliente: CLIENTE });
    expect(p.accion).toBe("proponer_lo_de_siempre");
    expect(p.confirmarDireccion).toBe("Calle Ficticia 1, Colonia Ejemplo");
  });
  it("SEGURIDAD: si el cliente teclea un número distinto del suyo NO se revela dirección ni historial", () => {
    const p = planReconocimientoRecurrente({ ...base, telefonoDicho: "9991112222", cliente: CLIENTE });
    expect(p.accion).toBe("pedir_direccion_cliente_no_vinculado");
    expect(p.confirmarDireccion).toBeNull();
    expect(p.vincularPorPersonal).toBe(true);
    expect(p.recotizarConMenuVigente).toBe(false);
    expect(JSON.stringify(p)).not.toContain("Calle Ficticia");
  });
  it("SEGURIDAD: sin remitente verificable tampoco se revela nada", () => {
    const p = planReconocimientoRecurrente({ telefonoRemitente: null, texto: "hola", cliente: CLIENTE });
    expect(p.accion).toBe("pedir_direccion_cliente_no_vinculado");
    expect(JSON.stringify(p)).not.toContain("Calle Ficticia");
  });
});
