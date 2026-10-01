// Cliente de la pagina de notificaciones y su presentacion (rotulos de categoria alineados con el catalogo).
import { describe, expect, it, vi } from "vitest";
import { CATEGORIAS_NOTIFICACION } from "../../../packages/db/src/notificaciones/catalogo.ts";
import { NotificacionesError, enlaceInternoSeguro, listarNotificaciones, marcarLeida, marcarTodasLeidas } from "../src/lib/notificaciones-client.ts";
import { CATEGORIAS_ROTULO, SEVERIDAD_ROTULO, formatoRelativo, rotuloCategoria } from "../src/lib/notificaciones-presentacion.ts";

const filtro = { soloNoLeidas: false, categoria: null, limit: 30 } as const;

function respuesta(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
}

describe("listarNotificaciones", () => {
  it("arma la consulta con filtros y manda el token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta({ notifications: [], unreadCount: 0 }));
    await listarNotificaciones(fetchMock, "https://api.test", "tok", { soloNoLeidas: true, categoria: "operacion", before: "2026-10-01T10:00:00.000Z", limit: 30 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/notifications?limit=30&unread=1&categoria=operacion&before=2026-10-01T10%3A00%3A00.000Z");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("normaliza filas: severidad desconocida cae a info, enlace externo se descarta, base sin migrar trae campos nulos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      respuesta({
        unreadCount: 2,
        notifications: [
          { id: "a", titulo: "Pedido nuevo", cuerpo: null, createdAt: "2026-10-01T10:00:00.000Z", readAt: null, severidad: "atencion", categoria: "operacion", enlace: "/restaurantes/x/pedidos" },
          { id: "b", titulo: "Vieja", cuerpo: "texto", createdAt: "2026-09-01T10:00:00.000Z", readAt: "2026-09-02T10:00:00.000Z", severidad: "rara", enlace: "https://malo.example/x" },
          { id: 7, titulo: "sin id valido", createdAt: "x" },
        ],
      }),
    );
    const r = await listarNotificaciones(fetchMock, "https://api.test", "tok", filtro);
    expect(r.unreadCount).toBe(2);
    expect(r.notificaciones).toHaveLength(2);
    expect(r.notificaciones[0]).toMatchObject({ id: "a", severidad: "atencion", categoria: "operacion", enlace: "/restaurantes/x/pedidos", readAt: null });
    expect(r.notificaciones[1]).toMatchObject({ id: "b", severidad: "info", categoria: null, enlace: null, cuerpo: "texto" });
  });

  it("traduce 401, 500, red caida y cuerpo invalido a NotificacionesError con mensaje legible", async () => {
    const casos: Array<[() => Promise<Response>, number | null, RegExp]> = [
      [async () => respuesta({}, 401), 401, /sesión expiró/],
      [async () => respuesta({}, 500), 500, /no pudo atender/],
      [async () => Promise.reject(new TypeError("fail")), null, /conexión/],
      [async () => respuesta({ nada: true }), 200, /no es válida/],
    ];
    for (const [fn, status, mensaje] of casos) {
      const err = await listarNotificaciones(fn, "https://api.test", "tok", filtro).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotificacionesError);
      expect((err as NotificacionesError).status).toBe(status);
      expect((err as NotificacionesError).message).toMatch(mensaje);
    }
  });
});

describe("marcar leidas", () => {
  it("marcarLeida hace POST con el id escapado y devuelve el contador real", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respuesta({ ok: true, unreadCount: 4 }));
    expect(await marcarLeida(fetchMock, "https://api.test", "tok", "a/b")).toBe(4);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/notifications/a%2Fb/read");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("404 (ya no existe) y 401 se reportan; marcarTodas devuelve cuantas marco", async () => {
    await expect(marcarLeida(async () => respuesta({}, 404), "https://api.test", "tok", "x")).rejects.toMatchObject({ status: 404, message: "Esa notificación ya no existe." });
    expect(await marcarTodasLeidas(async () => respuesta({ ok: true, markedCount: 3, unreadCount: 0 }), "https://api.test", "tok")).toBe(3);
    await expect(marcarTodasLeidas(async () => respuesta({}, 401), "https://api.test", "tok")).rejects.toMatchObject({ status: 401 });
  });
});

describe("enlaceInternoSeguro", () => {
  it("solo acepta rutas internas de una barra", () => {
    expect(enlaceInternoSeguro("/hoteles/mi-hotel/tickets")).toBe("/hoteles/mi-hotel/tickets");
    for (const malo of ["https://x.test", "//x.test", "javascript:alert(1)", "hoteles/x", "/a b", "/a\\b", '/a"b', null]) expect(enlaceInternoSeguro(malo), String(malo)).toBeNull();
  });
});

describe("presentacion", () => {
  it("cada categoria del catalogo compartido tiene rotulo (y no sobran)", () => {
    expect(Object.keys(CATEGORIAS_ROTULO).sort()).toEqual([...CATEGORIAS_NOTIFICACION].sort());
    expect(rotuloCategoria("operacion")).toBe("Operación");
    expect(rotuloCategoria("nueva_cosa")).toBe("Nueva cosa");
    expect(rotuloCategoria(null)).toBeNull();
  });

  it("rotulos de severidad como Likida", () => {
    expect(SEVERIDAD_ROTULO).toEqual({ info: "Aviso", atencion: "Requiere atención", critica: "Crítica" });
  });

  it("formatoRelativo", () => {
    const ahora = Date.parse("2026-10-01T12:00:00.000Z");
    expect(formatoRelativo("2026-10-01T11:59:40.000Z", ahora)).toBe("hace un momento");
    expect(formatoRelativo("2026-10-01T11:45:00.000Z", ahora)).toBe("hace 15 min");
    expect(formatoRelativo("2026-10-01T09:00:00.000Z", ahora)).toBe("hace 3 h");
    expect(formatoRelativo("2026-09-29T12:00:00.000Z", ahora)).toBe("hace 2 d");
    expect(formatoRelativo("2026-09-10T12:00:00.000Z", ahora)).toMatch(/10/);
    expect(formatoRelativo("no-fecha", ahora)).toBe("");
  });
});
