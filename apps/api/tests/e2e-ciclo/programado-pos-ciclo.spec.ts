// R-23: pedido PROGRAMADO y POS. Un programado no va a cocina hoy (ni al POS): al promoverse a `pending`
// (cron interno O el panel al consultar) la comanda DEBE llegar al POS falso, una sola vez (idempotente por pedido).
// Tambien cubre el POS caido (captura manual) y el reintento por el dispatcher interno.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { E2E_SECRETS, ORG_SLUG, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("e2e programado + POS", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  async function crearProgramado(): Promise<Json> {
    stack.ctx.restaurantesRepo.setScheduledOrdersSupported(true);
    const raw = JSON.stringify({
      branch_slug: "fco-montejo",
      customer_name: "Paco Programado",
      customer_phone: "9991230060",
      source: "voice",
      canal: "recoger",
      payment_method: "efectivo",
      programado_para: "2026-10-06T22:00:00.000Z", // 16:00 Merida; "ahora" es 13:00 Merida
      items: [{ product_id: stack.products.coca, requested_quantity: 5 }],
    });
    const res = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/orders`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-tool-secret": E2E_SECRETS.voiceToolSecret }, body: raw });
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
  }

  /** El motor en memoria no tiene `core.emit_notification` (eso lo prueban scripts/verify-*): se intercepta SOLO esa consulta
   * para comprobar QUE se emite a la campana (evento del catalogo, clave por pedido). El resto pasa intacto. */
  function espiarCampana(): Array<{ evento: unknown; clave: unknown; enlace: unknown; titulo: unknown }> {
    const emisiones: Array<{ evento: unknown; clave: unknown; enlace: unknown; titulo: unknown }> = [];
    const engine = stack.ctx.deps.engine as unknown as { withAppSession: (claims: { userId: string | null }, fn: (db: any) => Promise<any>) => Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const original = engine.withAppSession.bind(engine);
    engine.withAppSession = (claims, fn) =>
      original(claims, (db: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
        fn({
          ...db,
          query: async (sql: string, params: unknown[] = []) => {
            if (/core\.emit_notification/.test(sql)) {
              emisiones.push({ evento: params[2], clave: params[10], enlace: params[7], titulo: params[5] });
              return { rows: [{ emit_notification: 1 }] };
            }
            return db.query(sql, params);
          },
        }),
      );
    return emisiones;
  }

  it("programado: al promoverlo el staff recibe UN aviso en la bandeja y en la campana (sin PII), una sola vez", async () => {
    stack = await startCicloStack();
    const campana = espiarCampana();
    const { order } = await crearProgramado();
    const cron = () => fetch(stack.url("/internal/restaurantes/promover-programados"), { method: "POST", headers: { "x-atiende-internal-secret": E2E_SECRETS.internalSecret } });
    // Aun falta mucho: nada que avisar.
    expect(((await (await cron()).json()) as Json).avisosCocina).toMatchObject({ intentados: 0 });
    expect(campana.filter((e) => String(e.evento).includes("programado_en_cocina"))).toHaveLength(0);

    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    const promovido = (await (await cron()).json()) as Json;
    expect(promovido.avisosCocina).toEqual({ intentados: 1, bandeja: 1, errores: 0 });
    // Campana: evento del catalogo con la clave = id del pedido y el enlace a Pedidos; el titulo no lleva PII.
    const emitidas = campana.filter((e) => e.evento === "restaurantes.pedido.programado_en_cocina");
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]).toMatchObject({ clave: `restaurantes.pedido.programado_en_cocina:${order.id}`, enlace: "/restaurantes/{orgSlug}/pedidos" });
    expect(JSON.stringify(emitidas[0])).not.toMatch(/Paco|9991230060/);
    // Bandeja del panel: el evento nuevo, UNA vez, con la hora local y el nombre del cliente (la bandeja es interna del staff).
    const login = await fetch(stack.url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: stack.ctx.staff.owner.email, password: stack.ctx.staff.owner.password }) });
    const { token } = (await login.json()) as { token: string };
    const lista = (await (await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/order-notifications`), authedGet(token))).json()) as Json;
    const avisos = (lista.notifications as Json[]).filter((n) => n.eventType === "order.programado_promovido");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.orderId).toBe(order.id);
    expect(avisos[0]!.message).toContain("entró a cocina");
    // El cron otra vez no repite nada (ya no hay programados por promover).
    expect(((await (await cron()).json()) as Json).avisosCocina).toMatchObject({ intentados: 0 });
  });

  it("programado: al promoverlo el staff recibe el aviso tambien cuando lo promueve el panel al consultar", async () => {
    stack = await startCicloStack();
    const campana = espiarCampana();
    await crearProgramado();
    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    const login = await fetch(stack.url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: stack.ctx.staff.owner.email, password: stack.ctx.staff.owner.password }) });
    const { token } = (await login.json()) as { token: string };
    await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders?status=pending`), authedGet(token));
    await vi.waitFor(() => expect(campana.filter((e) => e.evento === "restaurantes.pedido.programado_en_cocina")).toHaveLength(1));
  });

  it("programado: al promoverlo por el cron la comanda llega al POS UNA vez", async () => {
    stack = await startCicloStack();
    const { order } = await crearProgramado();
    expect(order.status).toBe("programado");
    expect(stack.pos.comandas).toHaveLength(0);

    // Todavia falta mucho: el cron no lo promueve.
    const cron = () => fetch(stack.url("/internal/restaurantes/promover-programados"), { method: "POST", headers: { "x-atiende-internal-secret": E2E_SECRETS.internalSecret } });
    expect(((await (await cron()).json()) as Json).promoted).toBe(0);

    // Faltan 20 min (anticipacion = 30): se promueve y entra a cocina Y al POS.
    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    const promoted = (await (await cron()).json()) as Json;
    expect(promoted.promoted).toBe(1);
    // R-29: el cron ENCOLA la comanda (envio diferido); el dispatcher la manda al POS.
    expect(promoted.comandas).toMatchObject({ intentados: 1, encoladas: 1, errores: 0 });
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(1);
    expect(stack.pos.llamadasCrear[0]).toMatchObject({ tipo: "recoger" });
    // El cron otra vez no duplica nada, ni el dispatcher reenvia.
    expect(((await (await cron()).json()) as Json).promoted).toBe(0);
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(1);
  });

  it("programado promovido por el PANEL al consultar (sin cron): tambien llega al POS", async () => {
    stack = await startCicloStack();
    await crearProgramado();
    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    // El token del gerente (15 min) vence con el salto del reloj: vuelve a iniciar sesion, como lo haria el panel.
    const login = await fetch(stack.url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: stack.ctx.staff.owner.email, password: stack.ctx.staff.owner.password }) });
    const { token } = (await login.json()) as { token: string };
    const res = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders?status=pending`), authedGet(token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).orders).toHaveLength(1);
    // La tarea post-commit encola la comanda despues de responder (R-29) y el dispatcher la manda al POS.
    await vi.waitFor(async () => {
      await stack.dispatchPos();
      expect(stack.pos.comandas).toHaveLength(1);
    });
  });

  it("POS caido: el pedido existe, la comanda queda fallida y el gerente la captura a mano; al volver el POS el dispatcher no duplica", async () => {
    stack = await startCicloStack();
    stack.pos.inyectarFalla("crearComanda", { tipo: "timeout" });
    // Pedido por la ruta de voz (secreto de herramienta): el POS cae por timeout y la comanda queda pendiente de confirmar.
    const raw = JSON.stringify({ branch_slug: "fco-montejo", source: "voice", canal: "recoger", customer_name: "Pos Caido", customer_phone: "9991230061", payment_method: "efectivo", items: [{ product_id: stack.products.coca, requested_quantity: 5 }] });
    const res = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/orders`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), "x-atiende-tool-secret": E2E_SECRETS.voiceToolSecret }, body: raw });
    expect(res.status).toBe(200);
    const created = (await res.json()) as Json;
    expect(created.order.status).toBe("pending");
    expect(created.comanda).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(stack.pos.comandas).toHaveLength(0);

    // El gerente ve la comanda pendiente y la captura a mano en el POS.
    const owner = stack.ctx.staff.owner.token;
    const lista = (await (await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/softrestaurant/comandas`), authedGet(owner))).json()) as Json;
    expect(JSON.stringify(lista)).toMatch(/fallida|pendiente/);
    const id = (lista.comandas ?? lista.items)[0].id as string;
    const cap = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/softrestaurant/comandas/${id}/capturada`), authedJson(owner, { folio: "MANUAL-1" }, "POST"));
    expect(cap.status).toBe(200);
    // El POS vuelve: el dispatcher ya no reenvia la comanda capturada a mano.
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(0);
  });
});
