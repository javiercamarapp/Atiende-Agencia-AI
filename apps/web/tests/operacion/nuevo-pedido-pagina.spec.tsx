// @vitest-environment jsdom
//
// Nuevo pedido (captura por llamada): consentimiento obligatorio y explicito, total calculado por el servidor, privacidad del cliente
// existente (solo colonias), fuera de cobertura y pedido duplicado.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperacionNuevoPedidoPage } from "../../src/verticals/restaurantes/pages/OperacionNuevoPedido.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "00000000-0000-4000-8000-0000000000b1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.test", nombreSucursal: "Sucursal de prueba" };
const PROD = "00000000-0000-4000-8000-0000000000a1";
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
const producto = { id: PROD, categoryId: null, categoryName: null, name: "Tacos al pastor", description: null, price: 95, imageUrl: null, isPopular: true, isAvailable: true, displayOrder: 1, searchKeywords: [], branch: null };
const cotizacionOk = { cotizacion: { subtotal: 190, envio: 30, total: 220, tiempoEstimadoMin: [55, 65] }, cobertura: { dentro: true } };
const creado = { pedido: { id: "00000000-0000-4000-8000-000000000151", numero: 151, estado: "preparando", total: 220, source: "admin", canalCaptura: "llamada", capturadoPor: null }, cotizacion: cotizacionOk.cotizacion, aviso: { estado: "encolado", plantilla: "pedido_confirmado", motivo: null } };

interface Opc { cotizar?: () => Response; crear?: Array<() => Response>; cliente?: () => Response }
function servidor(o: Opc = {}) {
  const crear = [...(o.crear ?? [() => json(201, creado)])];
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/admin/products")) return json(200, { products: [producto] });
    if (url.includes("/admin/customers/por-telefono")) return o.cliente ? o.cliente() : json(404, { code: "not_found", message: "No existe" });
    if (url.endsWith("/admin/orders/cotizar")) return o.cotizar ? o.cotizar() : json(200, cotizacionOk);
    if (url.endsWith("/admin/orders") && init?.method === "POST") return (crear.shift() ?? (() => json(201, creado)))();
    return json(404, { code: "not_found", message: "sin ruta" });
  });
}

let rendered: RenderedComponent | undefined;
const esperar = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function montar(f: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", f);
  await act(async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <OperacionNuevoPedidoPage {...CTX} />
      </MemoryRouter>,
    );
  });
  await esperar(10);
}
const campo = (nombre: RegExp) => Array.from(document.querySelectorAll("input,textarea")).find((e) => nombre.test(e.getAttribute("aria-label") ?? "") || nombre.test(document.querySelector(`label[for="${e.id}"]`)?.textContent ?? "")) as HTMLInputElement;
const boton = (texto: RegExp | string) => Array.from(document.querySelectorAll("button")).find((b) => (typeof texto === "string" ? b.textContent?.trim() === texto || b.getAttribute("aria-label") === texto : texto.test(b.textContent ?? "") || texto.test(b.getAttribute("aria-label") ?? ""))) as HTMLButtonElement;
async function llenar() {
  changeValue(campo(/Teléfono/), "999 123 4567");
  changeValue(campo(/^Nombre/), "Ana R.");
  changeValue(campo(/Dirección completa/), "Calle 60 #320");
  await esperar(0);
  click(boton("Agregar Tacos al pastor"));
  await esperar(700); // pausa de cotizacion + respuesta
}
const textos = () => document.body.textContent ?? "";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Nuevo pedido", () => {
  it("muestra el guion, nada preseleccionado, «No» visible y Guardar bloqueado hasta responder", async () => {
    await montar(servidor());
    await llenar();
    expect(textos()).toContain("Le mandamos el aviso de su pedido por WhatsApp a este número, ¿está bien?");
    expect(boton("Sí, avisar").getAttribute("aria-pressed")).toBe("false");
    expect(boton("No").getAttribute("aria-pressed")).toBe("false");
    expect(textos()).toContain("220.00");
    expect(boton(/Guardar/).disabled).toBe(true);
    expect(document.querySelector('[data-testid="faltantes"]')?.textContent).toContain("aviso por WhatsApp");
    click(boton("No"));
    await esperar(0);
    expect(boton(/Guardar sin aviso/).disabled).toBe(false);
  });

  it("el total sale del servidor (cotizar) y no se calcula en el telefono", async () => {
    const f = servidor();
    await montar(f);
    await llenar();
    expect(textos()).toContain("220.00");
    expect(textos()).toContain("55–65 min");
    const cot = f.mock.calls.filter((c) => String(c[0]).endsWith("/cotizar"));
    expect(cot.length).toBeGreaterThan(0);
  });

  it("guarda con consentimiento Si, confirmar ya y Idempotency-Key; muestra el aviso resultante", async () => {
    const f = servidor();
    await montar(f);
    await llenar();
    click(boton("Sí, avisar"));
    await esperar(0);
    click(boton(/Guardar y avisar/));
    await esperar(10);
    const post = f.mock.calls.find((c) => String(c[0]).endsWith("/admin/orders") && (c[1] as RequestInit | undefined)?.method === "POST")!;
    const cuerpo = JSON.parse(String((post[1] as RequestInit).body));
    expect(cuerpo.consentimientoWhatsapp).toEqual({ otorgado: true, via: "verbal_llamada" });
    expect(cuerpo.confirmarYa).toBe(true);
    expect(cuerpo.cliente.telefono).toBe("+529991234567");
    expect(((post[1] as RequestInit).headers as Record<string, string>)["idempotency-key"]).toMatch(/.+/);
    expect(document.querySelector('[data-testid="pedido-guardado"]')?.textContent).toContain("Pedido #151 guardado");
    expect(textos()).toContain("Aviso por WhatsApp en camino");
  });

  it("cliente existente: muestra solo colonias, jamas la direccion guardada, y no la precarga", async () => {
    const f = servidor({ cliente: () => json(200, { cliente: { id: "00000000-0000-4000-8000-0000000000c1", nombre: "Ana R.", domicilios: [{ id: "00000000-0000-4000-8000-0000000000d1", texto: "Calle SECRETA 999", colonia: "Centro" }], ultimoPedido: null, gustos: [] } }) });
    await montar(f);
    changeValue(campo(/Teléfono/), "9991234567");
    await esperar(400);
    const caja = document.querySelector('[data-testid="cliente-existente"]')!;
    expect(caja.textContent).toContain("Centro");
    expect(textos()).not.toContain("SECRETA");
    expect(campo(/Dirección completa/).value).toBe("");
    expect(campo(/^Nombre/).value).toBe("Ana R.");
  });

  it("fuera de cobertura: alerta clara y no deja guardar", async () => {
    await montar(servidor({ cotizar: () => json(422, { code: "fuera_de_cobertura", message: "Fuera de la zona de reparto." }) }));
    await llenar();
    click(boton("Sí, avisar"));
    await esperar(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Fuera de cobertura");
    expect(boton(/Guardar/).disabled).toBe(true);
  });

  it("pedido duplicado reciente: pide confirmar y reenvia con forzarDuplicado", async () => {
    const f = servidor({ crear: [() => json(409, { code: "pedido_duplicado_reciente", message: "Duplicado" }), () => json(201, creado)] });
    await montar(f);
    await llenar();
    click(boton("Sí, avisar"));
    await esperar(0);
    click(boton(/Guardar y avisar/));
    await esperar(10);
    expect(document.body.textContent).toContain("¿Es un pedido repetido?");
    click(boton("Sí, guardar otro"));
    await esperar(20);
    const posts = f.mock.calls.filter((c) => String(c[0]).endsWith("/admin/orders") && (c[1] as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String((posts[1]![1] as RequestInit).body)).forzarDuplicado).toBe(true);
    expect(document.querySelector('[data-testid="pedido-guardado"]')).not.toBeNull();
  });
});
