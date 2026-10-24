import { describe, expect, it, vi } from "vitest";
import {
  fetchCatalogoCanales,
  fetchFeedTokens,
  fetchMatrizConectividad,
  pasosAsistente,
  probarUrlFeed,
  resumenSincronizacion,
  rotarFeedToken,
  sincronizarFeedAhora,
} from "../src/verticals/rentas/lib/conectividad-client.ts";
import type { CanalCatalogo, CeldaConectividad } from "../src/verticals/rentas/lib/conectividad-client.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const CANAL_WIRE = {
  codigo: "airbnb",
  nombre: "Airbnb",
  canal_atiende: "airbnb",
  via_hoy: "ical",
  via_ical: "disponible",
  descripcion_via: "iCal import/export",
  latencia: { texto: "~3 horas", confianza: "baja", fuente: "RV03", nota: "n" },
  bloqueo: { motivo: "NDA", cita: "PLAN §6" },
  requisitos: ["URL del calendario iCal de la unidad en Airbnb"],
  url_proceso_oficial: "https://www.airbnb.mx/help/article/99",
  nota_anti_paridad: "no asumas paridad",
};

describe("fetchCatalogoCanales", () => {
  it("pide GET .../canales/catalogo y mapea el wire", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/canales/catalogo");
      return json({ canales: [CANAL_WIRE] });
    }) as unknown as typeof fetch;
    const [c] = await fetchCatalogoCanales(f, "http://api.local", "tok", "prop-1");
    expect(c).toMatchObject({ codigo: "airbnb", canalAtiende: "airbnb", viaIcal: "disponible", latencia: { confianza: "baja", fuente: "RV03" }, bloqueo: { cita: "PLAN §6" }, urlProcesoOficial: "https://www.airbnb.mx/help/article/99" });
  });
});

describe("fetchMatrizConectividad", () => {
  it("mapea unidades, celdas y banderas de disponibilidad", async () => {
    const f = vi.fn(async () =>
      json({
        ahora: "2026-10-07T12:00:00.000Z",
        tokens_disponibles: false,
        canales: [CANAL_WIRE],
        unidades: [
          {
            id: "u1",
            nombre: "Suite 1",
            celdas: [
              {
                canal: "airbnb",
                estado: "solo_import",
                import: { estado: "ok", ultima_sincronizacion_exitosa_en: "2026-10-07T11:50:00Z", en_cuarentena_desde: null, motivo_cuarentena: null, intentos_fallidos_consecutivos: 0 },
                export: { estado: "no_disponible_aun", token_creado_en: null, ultimo_acceso_en: null },
              },
            ],
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const m = await fetchMatrizConectividad(f, "http://api.local", "tok", "prop-1");
    expect(m.tokensDisponibles).toBe(false);
    expect(m.unidades[0]!.celdas[0]).toEqual({
      canal: "airbnb",
      estado: "solo_import",
      import: { estado: "ok", ultimaSincronizacionExitosaEn: "2026-10-07T11:50:00Z", enCuarentenaDesde: null, motivoCuarentena: null, intentosFallidosConsecutivos: 0 },
      export: { estado: "no_disponible_aun", tokenCreadoEn: null, ultimoAccesoEn: null },
    });
  });

  it("un 403 del servidor se propaga como error legible", async () => {
    const f = vi.fn(async () => json({ message: "No tienes permiso para realizar esta acción." }, 403)) as unknown as typeof fetch;
    await expect(fetchMatrizConectividad(f, "http://api.local", "tok", "prop-1")).rejects.toThrow();
  });
});

describe("tokens de exportación", () => {
  it("fetchFeedTokens pide GET .../feed-tokens y mapea", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/u1/feed-tokens");
      return json({ disponible: true, url_uuid_activa: true, tokens: [{ canal: "airbnb", creado_en: "c", ultimo_acceso_en: null }] });
    }) as unknown as typeof fetch;
    expect(await fetchFeedTokens(f, "http://api.local", "tok", "prop-1", "u1")).toEqual({ disponible: true, urlUuidActiva: true, tokens: [{ canal: "airbnb", creadoEn: "c", ultimoAccesoEn: null }] });
  });

  it("rotarFeedToken hace POST y arma la URL completa con el origen de la API", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/u1/canales/airbnb/feed-token/rotar");
      expect(init?.method).toBe("POST");
      return json({ canal: "airbnb", token: "T".repeat(43), ruta: `/rentas/feed/${"T".repeat(43)}.ics`, creado_en: "c" }, 201);
    }) as unknown as typeof fetch;
    const r = await rotarFeedToken(f, "http://api.local", "tok", "prop-1", "u1", "airbnb");
    expect(r.url).toBe(`http://api.local/rentas/feed/${"T".repeat(43)}.ics`);
    expect(r.token).toHaveLength(43);
  });
});

describe("probarUrlFeed", () => {
  it("POST con la URL y resultado ok", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/u1/ical-feeds/probar");
      expect(JSON.parse(init!.body as string)).toEqual({ url: "https://x.example/a.ics" });
      return json({ ok: true, eventos: 3, cancelados: 1, desde: "2027-01-01", hasta: "2027-02-01", errores: [] });
    }) as unknown as typeof fetch;
    expect(await probarUrlFeed(f, "http://api.local", "tok", "prop-1", "u1", "https://x.example/a.ics")).toEqual({ ok: true, eventos: 3, cancelados: 1, desde: "2027-01-01", hasta: "2027-02-01" });
  });

  it("un fallo de parseo trae el mensaje y los errores", async () => {
    const f = vi.fn(async () => json({ ok: false, tipo: "parseo", mensaje: "no es .ics", errores: [{ codigo: "estructura_desbalanceada", mensaje: "x" }] })) as unknown as typeof fetch;
    expect(await probarUrlFeed(f, "http://api.local", "tok", "prop-1", "u1", "https://x.example/a.ics")).toEqual({ ok: false, tipo: "parseo", mensaje: "no es .ics", errores: [{ codigo: "estructura_desbalanceada", mensaje: "x" }] });
  });
});

describe("sincronizarFeedAhora", () => {
  it("POST a .../ical-feeds/:canal/sincronizar y resume el resultado", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/u1/ical-feeds/airbnb/sincronizar");
      expect(init?.method).toBe("POST");
      return json({ canal: "airbnb", ok: true, resultado: "exito_con_eventos", eventos_aplicados: 2, reservas_nuevas: 1, conflictos_detectados: 1 });
    }) as unknown as typeof fetch;
    const r = await sincronizarFeedAhora(f, "http://api.local", "tok", "prop-1", "u1", "airbnb");
    expect(resumenSincronizacion(r)).toBe("Sincronizado: 2 eventos aplicados, 1 reserva nueva, 1 conflicto por revisar.");
  });

  it("un 409 'ya se está sincronizando' llega como error", async () => {
    const f = vi.fn(async () => json({ message: "Este feed ya se está sincronizando. Vuelve a intentar en unos segundos." }, 409)) as unknown as typeof fetch;
    await expect(sincronizarFeedAhora(f, "http://api.local", "tok", "prop-1", "u1", "airbnb")).rejects.toThrow(/ya se está sincronizando/);
  });

  it("resumenSincronizacion distingue fallo y sin cambios", () => {
    expect(resumenSincronizacion({ ok: false, resultado: "fallo_red", eventosAplicados: 0, reservasNuevas: 0, conflictosDetectados: 0, mensaje: "No se pudo sincronizar el feed; se reintentará." })).toContain("No se pudo");
    expect(resumenSincronizacion({ ok: true, resultado: "no_modificado", eventosAplicados: 0, reservasNuevas: 0, conflictosDetectados: 0, mensaje: null })).toBe("El canal no tiene cambios desde la última vez.");
  });
});

describe("pasosAsistente", () => {
  const canal = {
    codigo: "airbnb",
    nombre: "Airbnb",
    canalAtiende: "airbnb",
    viaHoy: "ical",
    viaIcal: "disponible",
    descripcionVia: "x",
    latencia: { texto: "~3 horas", confianza: "baja", fuente: "RV03", nota: "" },
    bloqueo: null,
    requisitos: ["URL del calendario iCal de la unidad en Airbnb"],
    urlProcesoOficial: null,
    notaAntiParidad: "",
  } satisfies CanalCatalogo;
  const celda = (parcial: Partial<CeldaConectividad>): CeldaConectividad => ({
    canal: "airbnb",
    estado: "sin_conectar",
    import: { estado: "sin_conectar", ultimaSincronizacionExitosaEn: null, enCuarentenaDesde: null, motivoCuarentena: null, intentosFallidosConsecutivos: 0 },
    export: { estado: "sin_token", tokenCreadoEn: null, ultimoAccesoEn: null },
    ...parcial,
  });
  const hechos = (pasos: ReturnType<typeof pasosAsistente>) => pasos.map((p) => p.hecho);

  it("sin nada conectado: solo el paso manual queda sin verificar y el resto pendiente", () => {
    expect(hechos(pasosAsistente(canal, celda({})))).toEqual([null, false, false, false, false]);
  });

  it("marca cada paso con evidencia real: feed conectado, sincronizado, token creado y consultado por la OTA", () => {
    const pasos = pasosAsistente(
      canal,
      celda({
        estado: "conectado",
        import: { estado: "ok", ultimaSincronizacionExitosaEn: "2026-10-07T11:50:00Z", enCuarentenaDesde: null, motivoCuarentena: null, intentosFallidosConsecutivos: 0 },
        export: { estado: "consultado", tokenCreadoEn: "2026-10-01T00:00:00Z", ultimoAccesoEn: "2026-10-07T11:55:00Z" },
      }),
    );
    expect(hechos(pasos)).toEqual([null, true, true, true, true]);
    expect(pasos[4]!.evidencia).toContain("Última consulta de Airbnb");
  });

  it("un feed conectado que nunca sincronizó no marca la primera sincronización; en cuarentena muestra el motivo", () => {
    const pendiente = pasosAsistente(canal, celda({ import: { estado: "pendiente", ultimaSincronizacionExitosaEn: null, enCuarentenaDesde: null, motivoCuarentena: null, intentosFallidosConsecutivos: 0 } }));
    expect(hechos(pendiente)).toEqual([null, true, false, false, false]);
    const cuarentena = pasosAsistente(canal, celda({ import: { estado: "en_cuarentena", ultimaSincronizacionExitosaEn: null, enCuarentenaDesde: "x", motivoCuarentena: "3 intentos fallidos", intentosFallidosConsecutivos: 3 } }));
    expect(cuarentena[2]!.evidencia).toContain("3 intentos fallidos");
  });

  it("sin la migración de tokens declara la exportación 'no disponible aún'", () => {
    const pasos = pasosAsistente(canal, celda({ export: { estado: "no_disponible_aun", tokenCreadoEn: null, ultimoAccesoEn: null } }));
    expect(pasos[3]!.hecho).toBe(false);
    expect(pasos[3]!.evidencia).toContain("No disponible aún");
  });
});
