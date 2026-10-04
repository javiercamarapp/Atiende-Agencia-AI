// R-23: ciclo e2e por el STOREFRONT web (sin login): menu -> cotizar -> confirmar -> crear -> comanda al POS ->
// correo de confirmacion (sumidero tipo Resend) -> rastreo por token -> el staff lo avanza hasta entregado.
import { afterEach, describe, expect, it } from "vitest";
import { authedJson, authedGet } from "../restaurantes-admin-kpis-fixtures.ts";
import { ORG_SLUG, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = { origin: "http://localhost:5173" };
const SESSION = "sesion-e2e-0123456789abcdef";

describe("e2e storefront web", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  const post = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront${path}`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...ORIGIN }, body: raw });
  };

  it("cliente nuevo compra a domicilio: pedido, comanda, correo, rastreo y avance del staff", async () => {
    stack = await startCicloStack();
    const menu = (await (await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/fco-montejo/menu`))).json()) as Json;
    const nombres = JSON.stringify(menu.categorias);
    expect(nombres).toMatch(/Tacos de Bistec/);
    expect(nombres).not.toMatch(/Heineken.*"disponible":true/);
    const items = [
      { product_id: stack.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
      { product_id: stack.products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
    ];
    const quote = (await (await post("/fco-montejo/quote", { session_id: SESSION, items, canal: "domicilio", colonia_entrega: "Francisco de Montejo" })).json()) as Json;
    expect(quote.quote.total).toBe(284);
    // Crear sin confirmar: rechazado por la maquina de estados.
    const orderBody = { acepta_aviso_privacidad: true, session_id: SESSION, items, canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Marta Web", customer_phone: "999 123 0050", customer_email: "marta@example.test", customer_address: "Calle 21 #310, Francisco de Montejo", payment_method: "efectivo", quote_hash: quote.quote_hash };
    expect((await post("/fco-montejo/orders", orderBody)).status).toBe(400);
    expect((await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: quote.quote_hash })).status).toBe(200);
    // El servidor exige el aviso de privacidad: sin la casilla marcada no hay pedido (400 claro, motivo estable).
    const sinAviso = await post("/fco-montejo/orders", { ...orderBody, acepta_aviso_privacidad: false });
    expect(sinAviso.status).toBe(400);
    expect(await sinAviso.json()).toMatchObject({ motivo: "aviso_privacidad_requerido" });
    expect(stack.privacidad.pedidoConsents.size).toBe(0);
    const created = await post("/fco-montejo/orders", orderBody);
    expect(created.status).toBe(200);
    const body = (await created.json()) as Json;
    expect(body).toMatchObject({ total: 284, estado: "pending", canal: "domicilio", comanda: { estado: "confirmada" } });
    // Evidencia del consentimiento: una fila para ESTE pedido, canal web, sin datos personales.
    const [pedido] = (await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never)).orders;
    expect(stack.privacidad.pedidoConsents.get(pedido!.id)).toMatchObject({ organizationId: stack.ctx.organizationId, channel: "web", noticeVersion: "v1" });
    expect(JSON.stringify([...stack.privacidad.pedidoConsents.values()])).not.toMatch(/Marta|9991230050|marta@/);
    // Doble clic: el mismo envio no duplica pedido ni comanda.
    const dup = (await (await post("/fco-montejo/orders", orderBody)).json()) as Json;
    expect(dup.ya_registrado === true || dup.rastreo_token).toBeTruthy();
    const list = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never);
    expect(list.orders).toHaveLength(1);
    expect(stack.pos.comandas).toHaveLength(1);

    // Cliente registrado con direccion; correo de confirmacion llega al sumidero con el pedido.
    const c = await stack.ctx.restaurantesRepo.findCustomerByPhone(stack.ctx.organizationId, "9991230050");
    expect(c?.name).toBe("Marta Web");
    expect(stack.sink.emailsTo("marta@example.test").length).toBeGreaterThanOrEqual(1);
    expect(stack.sink.emailsTo("marta@example.test")[0]!.html).toMatch(/284/);

    // Rastreo publico por token firmado: sin datos personales.
    const track = (await (await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/track/${body.rastreo_token}`))).json()) as Json;
    expect(track.disponible).toBe(true);
    expect(JSON.stringify(track)).not.toMatch(/9991230050|marta@example/);
    const bad = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/track/${body.rastreo_token}x`));
    expect(bad.status).toBe(404);

    // El staff avanza el pedido y el rastreo lo refleja.
    const owner = stack.ctx.staff.owner.token;
    const orderId = list.orders[0]!.id;
    const patch = (status: string) => fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${orderId}/status`), authedJson(owner, { status }, "PATCH"));
    expect((await patch("preparando")).status).toBe(200);
    const track2 = (await (await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/track/${body.rastreo_token}`))).json()) as Json;
    expect(JSON.stringify(track2)).toMatch(/preparando/);
    const ownerNotifs = (await (await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/order-notifications`), authedGet(owner))).json()) as Json;
    expect(ownerNotifs.notifications.some((n: Json) => n.eventType === "order.created")).toBe(true);
  });

  it("fuera de zona, recoger, sesion y origen: las reglas duras valen igual en el storefront", async () => {
    stack = await startCicloStack();
    const items = [
      { product_id: stack.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
      { product_id: stack.products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
    ];
    const lejos = await post("/fco-montejo/quote", { session_id: SESSION, items, canal: "domicilio", colonia_entrega: "Progreso" });
    expect(lejos.status).toBe(400);
    const recoger = await post("/fco-montejo/quote", { session_id: SESSION, items, canal: "recoger" });
    expect(recoger.status).toBe(200);
    const sinSesion = await post("/fco-montejo/quote", { items, canal: "recoger" });
    expect(sinSesion.status).toBe(400);
    const sinOrigen = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/fco-montejo/quote`), { method: "POST", headers: { "content-type": "application/json", "content-length": "2", origin: "https://sitio-ajeno.example" }, body: "{}" });
    expect(sinOrigen.status).toBe(403);
  });

  it("correo de confirmacion: si el proveedor falla (5xx) el outbox reintenta y el correo sale UNA sola vez", async () => {
    stack = await startCicloStack();
    stack.sink.failNext(500);
    const base = { session_id: SESSION, items: [{ product_id: stack.products.coca, requested_quantity: 5 }], canal: "recoger" };
    const q = (await (await post("/fco-montejo/quote", base)).json()) as Json;
    await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: q.quote_hash });
    const created = await post("/fco-montejo/orders", { ...base, acepta_aviso_privacidad: true, customer_name: "Correo Reintento", customer_phone: "9991230070", customer_email: "reintento@example.test", payment_method: "efectivo", quote_hash: q.quote_hash });
    expect(created.status).toBe(200); // un fallo del proveedor de correo nunca tumba el pedido
    expect(stack.sink.emailsTo("reintento@example.test")).toHaveLength(0);
    expect(stack.sink.rejectedCount.value).toBe(1);
    const run = await stack.dispatchEmail();
    expect(run.status).toBe(200);
    expect(stack.sink.emailsTo("reintento@example.test")).toHaveLength(1);
    await stack.dispatchEmail();
    expect(stack.sink.emailsTo("reintento@example.test")).toHaveLength(1);
  });

  it("R-38 + R-43: el panel guarda la marca, el storefront la publica con su sitemap y el cliente envia una solicitud de evento que el restaurante recibe", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    // Panel: owner guarda la marca; el staff de sucursal no puede.
    const marca = { titular: "Tacos con historia", eslogan: "Desde 1980", about: "Somos de Mérida", portadaUrl: "https://cdn.example.com/p.jpg", logoUrl: null, instagramUrl: "https://instagram.com/lostaquitos", facebookUrl: null, tiktokUrl: null };
    const url = stack.url(`/v1/restaurantes/${stack.propertyId}/admin/config/sitio-publico`);
    expect((await fetch(url, authedJson(stack.ctx.staff.staffSucursalA.token, marca, "PUT"))).status).toBe(403);
    expect((await fetch(url, authedJson(owner, marca, "PUT"))).status).toBe(200);
    // Storefront publico: portada de marca y boton de WhatsApp de la sucursal (telefono de la sucursal -> wa.me).
    const sf = (await (await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront`))).json()) as Json;
    expect(sf.marca).toMatchObject({ titular: "Tacos con historia", instagramUrl: "https://instagram.com/lostaquitos" });
    expect(sf.sucursales.find((b: Json) => b.slug === "fco-montejo").whatsappUrl).toMatch(/^https:\/\/wa\.me\/529991234567\?text=/);
    // Sitemap: inicio, eventos y la sucursal; nunca rastreo.
    const xml = await (await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront/sitemap.xml`))).text();
    expect(xml).toContain(`/pedir/${ORG_SLUG}/eventos`);
    expect(xml).toContain(`/pedir/${ORG_SLUG}/fco-montejo`);
    expect(xml).not.toMatch(/pedido|rastreo/);
    // Cliente: solicitud de evento. Un bot (honeypot) no crea nada; la persona si.
    const futuro = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const evento = { nombre: "Ana Pérez", telefono: "999 123 0099", fechaEvento: futuro, personas: 60, sucursal: "fco-montejo", comentario: "Boda en jardin", aceptaAviso: true };
    expect((await post("/eventos", { ...evento, sitio_web: "http://spam.example" })).status).toBe(200);
    expect(stack.ctx.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
    expect((await post("/eventos", { ...evento, aceptaAviso: false })).status).toBe(400);
    const ok = await post("/eventos", evento);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Json).recibido).toBe(true);
    const [cb] = stack.ctx.restaurantesRepo.peekCallbackRequests();
    expect(cb).toMatchObject({ organizationId: stack.ctx.organizationId, propertyId: stack.propertyId, reason: "evento", source: "web", customerPhone: "9991230099" });
    expect(cb!.message).toMatch(/Personas: 60/);
    expect(cb!.message).toMatch(/Boda en jardin/);
    // Mismo telefono: tope de 3 por hora aunque cambie la IP.
    expect((await post("/eventos", evento)).status).toBe(200);
    expect((await post("/eventos", evento)).status).toBe(200);
    expect((await post("/eventos", evento)).status).toBe(429);
  });
});
