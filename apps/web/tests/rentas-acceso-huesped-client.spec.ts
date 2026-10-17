import { describe, expect, it, vi } from "vitest";
import { confirmarPagoReserva, fetchBitacoraAcceso, fetchConfigPrecheckin, fetchInstruccionAcceso, fetchMensajeOta, fetchPendientesEntrega, fetchPoliticaAcceso, fetchReservasAcceso, guardarInstruccionAcceso, guardarPoliticaAcceso, guardarReglamentoPrecheckin, marcarEntregadaManual } from "../src/verticals/rentas/lib/acceso-client.ts";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("acceso-client", () => {
  it("lee y guarda la política (snake_case <-> camelCase, método PUT)", async () => {
    const llamadas: { url: string; method: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const politica = { activo: true, horas_antes_checkin: 36, hora_checkin: "16:00", exigir_pago: true, ota_cuenta_como_pagada: false };
      return init?.method === "PUT" ? ok({ politica }) : ok({ disponible: true, configurada: true, politica });
    }) as unknown as typeof fetch;
    const r = await fetchPoliticaAcceso(fetchImpl, "http://api.local", "tok", "p1");
    expect(r).toEqual({ disponible: true, configurada: true, politica: { activo: true, horasAntesCheckin: 36, horaCheckin: "16:00", exigirPago: true, otaCuentaComoPagada: false } });
    await guardarPoliticaAcceso(fetchImpl, "http://api.local", "tok", "p1", r.politica!);
    expect(llamadas[1]).toEqual({ url: "http://api.local/rentas/p1/acceso-huesped/politica", method: "PUT", body: { activo: true, horas_antes_checkin: 36, hora_checkin: "16:00", exigir_pago: true, ota_cuenta_como_pagada: false } });
  });

  it("instrucciones: lee, guarda con PUT y maneja la base sin migrar (disponible:false)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return ok({ instrucciones: { direccion_exacta: "Calle 1", codigo_acceso: null, instrucciones: null } });
      return url.includes("sin-migrar") ? ok({ disponible: false, instrucciones: null }) : ok({ disponible: true, instrucciones: { direccion_exacta: "Calle 1", codigo_acceso: "1234", instrucciones: "x" } });
    }) as unknown as typeof fetch;
    expect(await fetchInstruccionAcceso(fetchImpl, "http://api.local", "tok", "p1", "u1")).toEqual({ disponible: true, instrucciones: { direccionExacta: "Calle 1", codigoAcceso: "1234", instrucciones: "x" } });
    expect(await fetchInstruccionAcceso(fetchImpl, "http://api.local", "tok", "p1", "sin-migrar")).toEqual({ disponible: false, instrucciones: null });
    expect(await guardarInstruccionAcceso(fetchImpl, "http://api.local", "tok", "p1", "u1", { direccionExacta: "Calle 1", codigoAcceso: null, instrucciones: null })).toEqual({ direccionExacta: "Calle 1", codigoAcceso: null, instrucciones: null });
  });

  it("reservas, pago confirmado y bitácora", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/acceso-huesped/reservas")) return ok({ disponible: true, reservas: [{ reserva_id: "r1", unidad_id: "u1", unidad_nombre: "Casa", canal: "manual", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: "Ana", pago_confirmado: true, liberada: false }] });
      if (url.includes("pago-confirmado")) return ok({ reserva_id: "r1", pago_confirmado: JSON.parse(String(init?.body)).confirmado });
      return ok({ disponible: true, eventos: [{ id: "e1", reserva_id: "r1", evento: "liberada", canal: "email", creado_en: "2026-10-01T10:00:00Z" }] });
    }) as unknown as typeof fetch;
    expect((await fetchReservasAcceso(fetchImpl, "http://api.local", "tok", "p1")).reservas[0]).toMatchObject({ reservaId: "r1", pagoConfirmado: true, checkIn: "2027-03-10" });
    expect(await confirmarPagoReserva(fetchImpl, "http://api.local", "tok", "p1", "r1", false)).toBe(false);
    expect((await fetchBitacoraAcceso(fetchImpl, "http://api.local", "tok", "p1")).eventos[0]).toEqual({ id: "e1", reservaId: "r1", evento: "liberada", creadoEn: "2026-10-01T10:00:00Z" });
    expect(urls).toContain("POST http://api.local/rentas/p1/reservas/r1/pago-confirmado");
    expect(urls).toContain("GET http://api.local/rentas/p1/acceso-huesped/bitacora?limite=30");
  });
});

describe("acceso-client -- Rn-P3-08/09", () => {
  it("config de pre-check-in, reglamento (PUT), pendientes, mensaje para la OTA y entrega manual (snake_case <-> camelCase)", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const config = { disponible: true, enlace_publico: "https://app.atiende.ai/rentas/precheckin/p1", texto_sugerido: "Hola", reglamento: "No fiestas.", reglamento_version: 2 };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith("/acceso-huesped/precheckin")) return ok(config);
      if (url.endsWith("/acceso-huesped/pendientes")) return ok({ disponible: true, pendientes: [{ reserva_id: "r1", unidad_id: "u1", unidad_nombre: "Casa", canal: "airbnb", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: null, omitida_en: "2027-03-09T10:00:00Z" }] });
      if (url.endsWith("/acceso-mensaje")) return ok({ disponible: true, mensaje: "Hola" });
      return ok({ reserva_id: "r1", entregada: true, nueva: true });
    }) as unknown as typeof fetch;
    expect(await fetchConfigPrecheckin(fetchImpl, "http://api.local", "tok", "p1")).toEqual({ disponible: true, enlacePublico: config.enlace_publico, textoSugerido: "Hola", reglamento: "No fiestas.", reglamentoVersion: 2 });
    await guardarReglamentoPrecheckin(fetchImpl, "http://api.local", "tok", "p1", "No fiestas.");
    expect((await fetchPendientesEntrega(fetchImpl, "http://api.local", "tok", "p1")).pendientes[0]).toEqual({ reservaId: "r1", unidadId: "u1", unidadNombre: "Casa", canal: "airbnb", checkIn: "2027-03-10", checkOut: "2027-03-12", huespedNombre: null, omitidaEn: "2027-03-09T10:00:00Z" });
    expect(await fetchMensajeOta(fetchImpl, "http://api.local", "tok", "p1", "r1")).toBe("Hola");
    await marcarEntregadaManual(fetchImpl, "http://api.local", "tok", "p1", "r1");
    expect(urls).toEqual([
      "GET http://api.local/rentas/p1/acceso-huesped/precheckin",
      "PUT http://api.local/rentas/p1/acceso-huesped/precheckin",
      "GET http://api.local/rentas/p1/acceso-huesped/pendientes",
      "GET http://api.local/rentas/p1/reservas/r1/acceso-mensaje",
      "POST http://api.local/rentas/p1/reservas/r1/entrega-manual",
    ]);
    expect(bodies[0]).toEqual({ reglamento: "No fiestas." });
  });

  it("el mensaje es null cuando la base no tiene la migracion (disponible:false)", async () => {
    const fetchImpl = vi.fn(async () => ok({ disponible: false, mensaje: null })) as unknown as typeof fetch;
    expect(await fetchMensajeOta(fetchImpl, "http://api.local", "tok", "p1", "r1")).toBeNull();
  });
});
