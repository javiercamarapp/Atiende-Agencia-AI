import { describe, expect, it, vi } from "vitest";
import { crearConversacion, generarBorrador, registrarMensajeEntrante } from "../src/verticals/rentas/lib/mensajeria-conversaciones-client.ts";
import { fetchBandejaAprobacion } from "../src/verticals/rentas/lib/mensajeria-client.ts";

const CONVERSACION = {
  id: "conv-1",
  organizationId: "org-1",
  propertyId: "prop-1",
  unidadId: "unidad-1",
  canal: "airbnb",
  ocupacionId: null,
  huespedMinimoId: null,
  propiedadNombre: "Depa Centro",
  huespedNombre: "Ana Pérez",
  fechaCheckIn: null,
  fechaCheckOut: null,
  reservaConfirmada: false,
  creadoEn: "2026-01-01T00:00:00.000Z",
};

const MENSAJE = {
  id: "msg-1",
  conversacionId: "conv-1",
  direccion: "entrante",
  origen: "manual",
  texto: "¿Cuál es la clave del wifi?",
  redactado: false,
  creadoEn: "2026-01-01T00:01:00.000Z",
};

const BORRADOR = {
  id: "bor-1",
  conversacionId: "conv-1",
  mensajeEntranteId: "msg-1",
  canal: "airbnb",
  texto: "Hola Ana, la clave del wifi es CASA1234.",
  estado: "pendiente_aprobacion",
  generadoPor: "motor_borrador",
  redactado: false,
  aprobadoPor: null,
  aprobadoEn: null,
  rechazadoPor: null,
  rechazadoEn: null,
  motivoRechazo: null,
  mensajeEnviadoId: null,
  creadoEn: "2026-01-01T00:02:00.000Z",
  actualizadoEn: "2026-01-01T00:02:00.000Z",
  necesitaEscalamiento: false,
  senales: [],
};

describe("crearConversacion", () => {
  it("hace POST a .../unidades/:unidadId/conversaciones con el cuerpo dado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/conversaciones");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ canal: "airbnb", propiedadNombre: "Depa Centro" });
      return new Response(JSON.stringify(CONVERSACION), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await crearConversacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { canal: "airbnb", propiedadNombre: "Depa Centro" });
    expect(result).toEqual(CONVERSACION);
  });

  it("un canal fuera de CANALES_MENSAJERIA lo rechaza el servidor -> error real (400)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "canal: se esperaba uno de airbnb, vrbo, booking." }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      crearConversacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { canal: "manual" as never, propiedadNombre: "Depa Centro" }),
    ).rejects.toThrow(/se esperaba uno de/);
  });
});

describe("registrarMensajeEntrante", () => {
  it("hace POST a .../conversaciones/:conversacionId/mensajes con origen 'manual' por defecto", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/conversaciones/conv-1/mensajes");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ texto: "¿Cuál es la clave del wifi?", origen: "manual" });
      return new Response(JSON.stringify(MENSAJE), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await registrarMensajeEntrante(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "conv-1", "¿Cuál es la clave del wifi?");
    expect(result).toEqual(MENSAJE);
  });

  it("un texto vacío lo rechaza el servidor -> error real (400)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "texto: se esperaba un texto no vacío." }), { status: 400 })) as unknown as typeof fetch;
    await expect(registrarMensajeEntrante(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "conv-1", "")).rejects.toThrow(/texto no vacío/);
  });
});

describe("generarBorrador", () => {
  it("hace POST a .../conversaciones/:conversacionId/borradores con mensajeEntranteId", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/conversaciones/conv-1/borradores");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ mensajeEntranteId: "msg-1" });
      return new Response(JSON.stringify(BORRADOR), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await generarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "conv-1", { mensajeEntranteId: "msg-1" });
    expect(result.estado).toBe("pendiente_aprobacion");
    expect(result.texto).toBe(BORRADOR.texto);
  });

  it("sin llmGateway configurado y usarIa:true -> error real (503)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "La generación de borradores con agente no está habilitada en este ambiente." }), { status: 503 })) as unknown as typeof fetch;
    await expect(generarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "conv-1", { mensajeEntranteId: "msg-1", usarIa: true })).rejects.toThrow(/no está habilitada/);
  });
});

// Flujo completo (hallazgo de auditoría): crear conversación -> registrar mensaje ->
// generar borrador -> aparece en la bandeja de Aprobaciones.tsx (fetchBandejaAprobacion,
// mensajeria-client.ts) -> aprobar. Antes de esta fase, los primeros 3 pasos no tenían
// ningún cliente web -- la bandeja SIEMPRE estaba vacía en producción porque nada la
// podía sembrar.
describe("flujo completo: crear conversación -> mensaje -> borrador -> bandeja -> aprobar", () => {
  it("el borrador generado aparece pendiente en fetchBandejaAprobacion inmediatamente después", async () => {
    let borradorGuardado: typeof BORRADOR | null = null;

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones") && init?.method === "POST") {
        return new Response(JSON.stringify(CONVERSACION), { status: 201 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones/conv-1/mensajes") && init?.method === "POST") {
        return new Response(JSON.stringify(MENSAJE), { status: 201 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-1/borradores") && init?.method === "POST") {
        borradorGuardado = BORRADOR;
        return new Response(JSON.stringify(BORRADOR), { status: 201 });
      }
      if (url.endsWith("/rentas/prop-1/unidades")) {
        return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones")) {
        return new Response(JSON.stringify({ conversaciones: [CONVERSACION] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-1/borradores")) {
        return new Response(JSON.stringify({ borradores: borradorGuardado ? [borradorGuardado] : [] }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url} ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const conversacion = await crearConversacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { canal: "airbnb", propiedadNombre: "Depa Centro" });
    const mensaje = await registrarMensajeEntrante(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", conversacion.id, "¿Cuál es la clave del wifi?");
    const borrador = await generarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", conversacion.id, { mensajeEntranteId: mensaje.id });
    expect(borrador.estado).toBe("pendiente_aprobacion");

    const bandeja = await fetchBandejaAprobacion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(bandeja).toHaveLength(1);
    expect(bandeja[0]!.conversacion.id).toBe("conv-1");
    expect(bandeja[0]!.pendientes).toHaveLength(1);
    expect(bandeja[0]!.pendientes[0]!.id).toBe("bor-1");
  });
});
