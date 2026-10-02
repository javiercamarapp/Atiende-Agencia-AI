// Rn-25 -- el cron de mensajes automaticos: SOLO crea borradores pendientes de aprobacion, es
// idempotente, omite (con marca) lo que no se puede renderizar, aisla el error de una reserva y
// degrada contra una base sin migrar.
import { describe, expect, it, vi } from "vitest";
import { InMemoryRentasMensajesAutomaticosRepository, ejecutarMensajesAutomaticos } from "../src/index.ts";
import type { CandidatoMensajeAutomatico, WithMensajesAutomaticosTx } from "../src/index.ts";

// 2030-06-08 00:30 CDMX = disparo (-48 h antes del check-in del 10) + 30 min.
const AHORA = new Date("2030-06-08T06:30:00Z");

function candidato(sobre: Partial<CandidatoMensajeAutomatico> = {}): CandidatoMensajeAutomatico {
  return {
    ocupacionId: "ocu-1",
    organizationId: "org-1",
    propertyId: "prop-1",
    unidadId: "uni-1",
    evento: "pre_llegada",
    offsetHoras: -48,
    plantillaId: "pl-1",
    plantillaCuerpo: "Hola {{huesped}}, te esperamos en {{propiedad}} el {{fecha_check_in}}.",
    plantillaAprobada: true,
    plantillaActiva: true,
    canal: "airbnb",
    checkIn: "2030-06-10",
    checkOut: "2030-06-12",
    huespedNombre: "Ana",
    propiedadNombre: "Casa Mar",
    unidadNombre: "Depto 1",
    zonaHoraria: "America/Mexico_City",
    ...sobre,
  };
}

function montar() {
  const repo = new InMemoryRentasMensajesAutomaticosRepository();
  const avisos: string[] = [];
  const withTx: WithMensajesAutomaticosTx = (fn) => fn({ repo, alCrearBorrador: async (c) => void avisos.push(c.borradorId) });
  return { repo, avisos, withTx };
}

describe("ejecutarMensajesAutomaticos", () => {
  it("renderiza la plantilla aprobada y deja un borrador pendiente_aprobacion (nunca envia) + un aviso", async () => {
    const { repo, avisos, withTx } = montar();
    repo.candidatas.push(candidato());
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r).toMatchObject({ disponible: true, candidatas: 1, borradoresCreados: 1, errores: 0 });
    expect(repo.borradores).toHaveLength(1);
    expect(repo.borradores[0]).toMatchObject({ estado: "pendiente_aprobacion", ocupacionId: "ocu-1", evento: "pre_llegada" });
    expect(repo.borradores[0]!.texto).toMatch(/^Hola Ana, te esperamos en Casa Mar el lunes,? 10 de junio de 2030\.$/);
    expect(avisos).toEqual([repo.borradores[0]!.id]);
  });

  it("es idempotente: una segunda corrida con el mismo estado no duplica el borrador ni el aviso", async () => {
    const { repo, avisos, withTx } = montar();
    repo.candidatas.push(candidato());
    await ejecutarMensajesAutomaticos(withTx, AHORA);
    const r2 = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r2.borradoresCreados).toBe(0);
    expect(repo.borradores).toHaveLength(1);
    expect(avisos).toHaveLength(1);
  });

  it("dos corridas concurrentes sobre la misma candidata dejan UN solo borrador (la marca decide)", async () => {
    const { repo, avisos, withTx } = montar();
    repo.candidatas.push(candidato());
    const [a, b] = await Promise.all([ejecutarMensajesAutomaticos(withTx, AHORA), ejecutarMensajesAutomaticos(withTx, AHORA)]);
    expect(repo.borradores).toHaveLength(1);
    expect(a.borradoresCreados + b.borradoresCreados).toBe(1);
    expect(a.yaProcesadas + b.yaProcesadas).toBe(1);
    expect(avisos).toHaveLength(1);
  });

  it("ventana por zona horaria con reloj fijo a las 23:30 CDMX: el mensaje de las 00:00 del dia siguiente NO sale todavia", async () => {
    const { repo, withTx } = montar();
    repo.candidatas.push(candidato());
    // 23:30 del 7 en CDMX = 05:30Z del 8 (el dia UTC ya es el 8).
    const antes = await ejecutarMensajesAutomaticos(withTx, new Date("2030-06-08T05:30:00Z"));
    expect(antes).toMatchObject({ borradoresCreados: 0, fueraDeVentana: 1 });
    expect(repo.borradores).toHaveLength(0);
    const despues = await ejecutarMensajesAutomaticos(withTx, new Date("2030-06-08T06:30:00Z"));
    expect(despues.borradoresCreados).toBe(1);
  });

  it("pasada la ventana de gracia de 24 h no genera el mensaje obsoleto", async () => {
    const { repo, withTx } = montar();
    repo.candidatas.push(candidato());
    const r = await ejecutarMensajesAutomaticos(withTx, new Date("2030-06-09T06:30:00Z"));
    expect(r).toMatchObject({ borradoresCreados: 0, fueraDeVentana: 1 });
  });

  it("una plantilla con una variable desconocida NO inventa valor: se omite, se deja marca y no se reintenta", async () => {
    const { repo, withTx } = montar();
    repo.candidatas.push(candidato({ plantillaCuerpo: "Tu codigo wifi es {{codigo_wifi}}" }));
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r).toMatchObject({ borradoresCreados: 0, omitidasVariableFaltante: 1, errores: 0 });
    expect(repo.borradores).toHaveLength(0);
    expect(repo.omitidos).toEqual([{ ocupacionId: "ocu-1", evento: "pre_llegada" }]);
    const r2 = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r2.candidatas).toBe(0);
  });

  it("una plantilla no aprobada (H-056) nunca se programa: cuenta como error y no crea nada", async () => {
    const { repo, withTx } = montar();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repo.candidatas.push(candidato({ plantillaAprobada: false }));
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r).toMatchObject({ borradoresCreados: 0, errores: 1 });
    expect(repo.borradores).toHaveLength(0);
    expect(log.mock.calls[0]?.slice(-1)[0]).toBe("plantilla_no_aprobada");
    log.mockRestore();
  });

  it("el error SQL de UNA reserva no detiene las demas y se cuenta como error (sin PII en el log)", async () => {
    const { repo, withTx } = montar();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repo.candidatas.push(candidato({ ocupacionId: "ocu-mala", huespedNombre: "Persona Secreta" }), candidato({ ocupacionId: "ocu-buena" }));
    repo.fallaAlCrearPara.add("ocu-mala");
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r).toMatchObject({ borradoresCreados: 1, errores: 1 });
    expect(repo.borradores.map((b) => b.ocupacionId)).toEqual(["ocu-buena"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Persona Secreta");
    expect(JSON.stringify(log.mock.calls)).toContain("40P01");
    log.mockRestore();
  });

  it("contra una base sin la migracion 029 responde disponible:false sin lanzar", async () => {
    const { repo, withTx } = montar();
    repo.migracion029Disponible = false;
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA);
    expect(r).toMatchObject({ disponible: false, borradoresCreados: 0, errores: 0 });
  });

  it("un error que NO es de migracion pendiente al listar se propaga (el cron lo reporta)", async () => {
    const { repo, withTx } = montar();
    repo.listarCandidatos = async () => {
      throw Object.assign(new Error("boom"), { code: "57014" });
    };
    await expect(ejecutarMensajesAutomaticos(withTx, AHORA)).rejects.toThrow("boom");
  });

  it("respeta el tope por corrida y avisa que quedo trabajo (truncada)", async () => {
    const { repo, withTx } = montar();
    for (let i = 0; i < 3; i++) repo.candidatas.push(candidato({ ocupacionId: `ocu-${i}` }));
    const r = await ejecutarMensajesAutomaticos(withTx, AHORA, { maxPorCorrida: 2 });
    expect(r.borradoresCreados).toBe(2);
    expect(r.truncada).toBe(true);
  });
});
