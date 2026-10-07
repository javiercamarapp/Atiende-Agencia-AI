import { describe, expect, it, vi } from "vitest";
import {
  aprobarBorrador,
  avisoPoliticaCanal,
  fetchBandejaAprobacion,
  fetchBorradores,
  fetchConversaciones,
  fetchHilo,
  filtrarBandeja,
  filtrosAQuery,
  filtrosDesdeQuery,
  FILTROS_VACIOS,
  ordenarBandeja,
  rechazarBorrador,
  requiereAtencion,
  senalesPendientes,
} from "../src/verticals/rentas/lib/mensajeria-client.ts";

const CONVERSACION = {
  id: "conv-1",
  organizationId: "org-1",
  propertyId: "prop-1",
  unidadId: "unidad-1",
  canal: "airbnb",
  ocupacionId: "ocu-1",
  huespedMinimoId: null,
  propiedadNombre: "Depa Centro",
  huespedNombre: "Ana Pérez",
  fechaCheckIn: "2026-12-01",
  fechaCheckOut: "2026-12-03",
  reservaConfirmada: true,
  creadoEn: "2026-01-01T00:00:00.000Z",
};

const BORRADOR_PENDIENTE = {
  id: "bor-1",
  conversacionId: "conv-1",
  mensajeEntranteId: "msg-1",
  canal: "airbnb",
  texto: "Hola Ana, tu check-in es el 1 de diciembre.",
  estado: "pendiente_aprobacion",
  generadoPor: "motor_borrador",
  redactado: false,
  necesitaEscalamiento: false,
  senales: [],
  aprobadoPor: null,
  aprobadoEn: null,
  rechazadoPor: null,
  rechazadoEn: null,
  motivoRechazo: null,
  mensajeEnviadoId: null,
  creadoEn: "2026-01-02T00:00:00.000Z",
  actualizadoEn: "2026-01-02T00:00:00.000Z",
};

describe("fetchConversaciones", () => {
  it("pide GET /rentas/:propertyId/unidades/:unidadId/conversaciones y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/conversaciones");
      return new Response(JSON.stringify({ conversaciones: [CONVERSACION] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchConversaciones(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1");
    expect(result).toEqual([CONVERSACION]);
  });
});

describe("fetchBorradores", () => {
  it("pide GET /rentas/:propertyId/conversaciones/:conversacionId/borradores y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/conversaciones/conv-1/borradores");
      return new Response(JSON.stringify({ borradores: [BORRADOR_PENDIENTE] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchBorradores(fetchImpl, "http://api.local", "tok", "prop-1", "conv-1");
    expect(result).toEqual([BORRADOR_PENDIENTE]);
  });
});

describe("aprobarBorrador", () => {
  it("hace POST real a .../borradores/:id/aprobar sin body relevante", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/borradores/bor-1/aprobar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ...BORRADOR_PENDIENTE, estado: "enviado", aprobadoPor: "user-1", aprobadoEn: "2026-01-02T00:05:00.000Z", mensajeEnviadoId: "msg-2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await aprobarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1");
    expect(result.estado).toBe("enviado");
    expect(result.aprobadoPor).toBe("user-1");
  });

  it("aprobación requerida ya cumplida por otro actor -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El borrador ya no está pendiente de aprobación." }), { status: 409 })) as unknown as typeof fetch;
    await expect(aprobarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1")).rejects.toThrow(/ya no está pendiente/);
  });
});

describe("rechazarBorrador", () => {
  it("hace POST real a .../borradores/:id/rechazar con el motivo", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/borradores/bor-1/rechazar");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ motivo: "Tono incorrecto" });
      return new Response(JSON.stringify({ ...BORRADOR_PENDIENTE, estado: "rechazado", rechazadoPor: "user-1", motivoRechazo: "Tono incorrecto" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await rechazarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1", "Tono incorrecto");
    expect(result.estado).toBe("rechazado");
    expect(result.motivoRechazo).toBe("Tono incorrecto");
  });
});

describe("fetchBandejaAprobacion", () => {
  it("recorre unidades -> conversaciones -> borradores y arma la bandeja con pendientes primero", async () => {
    const otraConversacion = { ...CONVERSACION, id: "conv-2", unidadId: "unidad-1", huespedNombre: "Luis Ruiz", creadoEn: "2026-01-03T00:00:00.000Z" };
    const borradorEnviado = { ...BORRADOR_PENDIENTE, id: "bor-0", conversacionId: "conv-2", estado: "enviado" };

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/rentas/prop-1/unidades")) {
        return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones")) {
        return new Response(JSON.stringify({ conversaciones: [CONVERSACION, otraConversacion] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-1/borradores")) {
        return new Response(JSON.stringify({ borradores: [BORRADOR_PENDIENTE] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-2/borradores")) {
        return new Response(JSON.stringify({ borradores: [borradorEnviado] }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchBandejaAprobacion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(2);
    // conv-1 tiene un pendiente -> va primero aunque conv-2 se haya creado después.
    expect(result[0]!.conversacion.id).toBe("conv-1");
    expect(result[0]!.pendientes).toHaveLength(1);
    expect(result[0]!.historial).toHaveLength(0);
    expect(result[1]!.conversacion.id).toBe("conv-2");
    expect(result[1]!.pendientes).toHaveLength(0);
    expect(result[1]!.historial).toHaveLength(1);
  });

  it("una unidad sin ninguna conversación no aparece en la bandeja", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/rentas/prop-1/unidades")) {
        return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones")) {
        return new Response(JSON.stringify({ conversaciones: [] }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchBandejaAprobacion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([]);
  });
});

describe("Rn-P3-20/21/22 -- hilo, escalamiento y filtros (funciones puras)", () => {
  const json = (body: unknown, status = 200) => vi.fn(async (_url: string) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response);

  it("fetchHilo pide GET .../conversaciones/:id/hilo y normaliza borradores de un API anterior a la migración (sin los campos nuevos)", async () => {
    const { necesitaEscalamiento: _n, senales: _s, ...viejo } = BORRADOR_PENDIENTE;
    const fetchImpl = json({ conversacion: CONVERSACION, mensajes: [], borradores: [viejo] });
    const hilo = await fetchHilo(fetchImpl as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "conv-1");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/rentas/prop-1/conversaciones/conv-1/hilo");
    expect(hilo.borradores[0]).toMatchObject({ necesitaEscalamiento: false, senales: [] });
  });

  const item = (id: string, canal: string, huesped: string, pendientes: unknown[], creadoEn = "2026-10-01T00:00:00Z") =>
    ({ unidad: { id: "u", name: "Depa 101", nombre: "Depa 101" }, conversacion: { ...CONVERSACION, id, canal, huespedNombre: huesped, creadoEn }, pendientes, historial: [] }) as never;
  const rutina = { ...BORRADOR_PENDIENTE, id: "r" };
  const urgente = { ...BORRADOR_PENDIENTE, id: "u", necesitaEscalamiento: true, senales: ["vip", "emergencia"] };

  it("requiereAtencion y senalesPendientes miran solo los borradores PENDIENTES, en orden de gravedad", () => {
    expect(requiereAtencion(item("a", "airbnb", "Ana", [rutina]))).toBe(false);
    expect(requiereAtencion(item("a", "airbnb", "Ana", [urgente]))).toBe(true);
    expect(senalesPendientes(item("a", "airbnb", "Ana", [urgente, rutina]))).toEqual(["emergencia", "vip"]);
    const decidido = { ...(item("a", "airbnb", "Ana", []) as object), historial: [{ ...urgente, estado: "enviado" }] } as never;
    expect(requiereAtencion(decidido)).toBe(false);
  });

  it("ordenarBandeja pone primero lo escalado, luego lo que tiene pendientes, luego lo más reciente", () => {
    const orden = ordenarBandeja([
      item("reciente", "airbnb", "A", [], "2026-10-09T00:00:00Z"),
      item("pendiente", "airbnb", "B", [rutina]),
      item("escalado", "airbnb", "C", [urgente], "2026-09-01T00:00:00Z"),
    ]).map((i) => i.conversacion.id);
    expect(orden).toEqual(["escalado", "pendiente", "reciente"]);
  });

  it("filtrarBandeja combina canal, con pendientes, requiere atención y búsqueda sin acentos", () => {
    const items = [item("a", "airbnb", "Ana López", [rutina]), item("b", "vrbo", "Beto", [urgente]), item("c", "airbnb", "Carla Núñez", [])];
    const ids = (f: Partial<typeof FILTROS_VACIOS>) => filtrarBandeja(items, { ...FILTROS_VACIOS, ...f }).map((i) => i.conversacion.id);
    expect(ids({})).toEqual(["a", "b", "c"]);
    expect(ids({ canal: "airbnb" })).toEqual(["a", "c"]);
    expect(ids({ conPendientes: true })).toEqual(["a", "b"]);
    expect(ids({ requiereAtencion: true })).toEqual(["b"]);
    expect(ids({ busqueda: "nunez" })).toEqual(["c"]);
    expect(ids({ busqueda: "depa 101", canal: "vrbo" })).toEqual(["b"]);
  });

  it("los filtros viajan a la URL y vuelven; un canal desconocido se ignora y no se escriben filtros vacíos", () => {
    const f = { canal: "vrbo", conPendientes: true, requiereAtencion: true, busqueda: " Ana " } as const;
    expect(filtrosAQuery(f).toString()).toBe("canal=vrbo&pendientes=1&atencion=1&q=Ana");
    expect(filtrosDesdeQuery(new URLSearchParams("canal=vrbo&pendientes=1&atencion=1&q=Ana"))).toEqual({ ...f, busqueda: "Ana" });
    expect(filtrosDesdeQuery(new URLSearchParams("canal=inventado&pendientes=0"))).toEqual(FILTROS_VACIOS);
    expect(filtrosAQuery(FILTROS_VACIOS).toString()).toBe("");
  });

  it("avisoPoliticaCanal dice solo lo que la política declara", () => {
    const airbnb = { canal: "airbnb", maxCaracteres: 4000, permiteContactoDirectoPreReserva: false, permiteAutomatizacionPreReserva: true, accionAntePreReservaProhibida: "bloquear" } as const;
    expect(avisoPoliticaCanal(airbnb)).toContain("se bloquea");
    expect(avisoPoliticaCanal(airbnb)).not.toContain("No se automatizan");
    const booking = { ...airbnb, canal: "booking", permiteAutomatizacionPreReserva: false, accionAntePreReservaProhibida: "redactar" } as const;
    expect(avisoPoliticaCanal(booking)).toContain("se enmascaran");
    expect(avisoPoliticaCanal(booking)).toContain("No se automatizan");
  });
});
