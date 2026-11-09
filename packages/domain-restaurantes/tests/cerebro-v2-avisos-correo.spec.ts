// Cerebro v2, B7 fuera del panel (SUELTO-VS-718-V2.md «niveles/urgencia: correo/WhatsApp al dueño ABIERTO»). El suelto (alertas-operativas.ts +
// alertas-ruteo.ts + send-order-notification) manda CORREO por cada aviso del agente sin atender: nivel 1 a los 10 min (los de alto riesgo, de inmediato),
// repetición a los 20 (nivel 2, «[RECORDATORIO] ») y a los 30 escala al dueño (nivel 3, «[ESCALADA AL DUEÑO] »); niveles 1-2 al personal de ESA sucursal
// (o de alcance general), con red de seguridad al dueño si no hay nadie; nunca a repartidores; el aviso de posible baja solo el nivel 1. Aquí: mismo ruteo
// y misma escalera, por el outbox de correo existente (restaurantes.enqueue_messaging_outbox, llave idempotente por aviso, nivel y destinatario) desde el
// tick existente /internal/restaurantes/promover-programados (sin cron nuevo). Solo organizaciones con cerebro_v2 Y la opción por organización
// `avisos_correo_escalera` (migración 194; la base decide ambas). Sin PII en el correo (ni teléfono ni texto del cliente).
import { describe, expect, it } from "vitest";
import { barrerAvisosPorCorreo } from "../src/avisos-operativos.ts";
import { correoDeAviso, destinatariosAlerta, destinatariosDelEquipo, prefijoNivel } from "../src/whatsapp/cerebro-v2/avisos.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const T7 = "00000000-0000-4000-8000-0000000000a7";
const OTRA = "00000000-0000-4000-8000-0000000000a8";
const EQUIPO = [
  { email: "Duena@Ejemplo.mx", vertical_role: "owner", platform_role: "owner", property_ids: null },
  { email: "gerente.t7@ejemplo.mx", vertical_role: "admin", platform_role: "admin", property_ids: [T7] },
  { email: "general@ejemplo.mx", vertical_role: "staff", platform_role: "member", property_ids: [] },
  { email: "otra@ejemplo.mx", vertical_role: "staff", platform_role: "member", property_ids: [OTRA] },
  { email: "repartidor@ejemplo.mx", vertical_role: "repartidor", platform_role: "member", property_ids: [T7] },
  { email: null, vertical_role: "staff", platform_role: "member", property_ids: [T7] },
];

describe("ruteo de los correos de aviso (alertas-ruteo.ts del suelto, literal)", () => {
  it("niveles 1-2: el personal de la sucursal y el de alcance general; nivel 3: más el dueño; nunca repartidores ni otra sucursal", () => {
    const equipo = destinatariosDelEquipo(EQUIPO, T7);
    expect(destinatariosAlerta(equipo, T7, 1)).toEqual({ correos: ["gerente.t7@ejemplo.mx", "general@ejemplo.mx"], fallbackDueno: false });
    expect(destinatariosAlerta(equipo, T7, 2).correos).toEqual(["gerente.t7@ejemplo.mx", "general@ejemplo.mx"]);
    expect(destinatariosAlerta(equipo, T7, 3).correos).toEqual(["gerente.t7@ejemplo.mx", "general@ejemplo.mx", "duena@ejemplo.mx"]);
  });

  it("sin personal para la sucursal: red de seguridad al dueño desde el nivel 1", () => {
    const soloDueno = destinatariosDelEquipo([EQUIPO[0]!, EQUIPO[3]!, EQUIPO[4]!], T7);
    expect(destinatariosAlerta(soloDueno, T7, 1)).toEqual({ correos: ["duena@ejemplo.mx"], fallbackDueno: true });
  });

  it("prefijo del asunto por nivel y correo sin datos del cliente", () => {
    expect(prefijoNivel(1)).toBe("");
    expect(prefijoNivel(2)).toBe("[RECORDATORIO] ");
    expect(prefijoNivel(3)).toBe("[ESCALADA AL DUEÑO] ");
    const c = correoDeAviso({ nivel: 3, minutos: 31, urgente: true });
    expect(c.subject.startsWith("[ESCALADA AL DUEÑO] ")).toBe(true);
    expect(c.html).toMatch(/31 min/);
    expect(c.text).toMatch(/panel/i);
  });
});

describe("barrido de avisos por correo en el tick (cerebro v2 + opción por organización)", () => {
  const ahora = new Date("2026-10-13T20:00:00Z");
  const hace = (min: number) => new Date(ahora.getTime() - min * 60_000).toISOString();
  const AVISOS = [
    // 31 min sin atender: nivel 3 (dueño incluido).
    { id: "00000000-0000-4000-8000-0000000000e1", organization_id: ORG, property_id: T7, created_at: hace(31), urgente: false, solo_primer_aviso: false },
    // Urgente de hace 2 min: nivel 1 de inmediato (suelto: encolarAlertaInmediata).
    { id: "00000000-0000-4000-8000-0000000000e2", organization_id: ORG, property_id: T7, created_at: hace(2), urgente: true, solo_primer_aviso: false },
    // Posible baja de hace 35 min: solo el nivel 1.
    { id: "00000000-0000-4000-8000-0000000000e3", organization_id: ORG, property_id: T7, created_at: hace(35), urgente: false, solo_primer_aviso: true },
  ];

  function sesion() {
    const encolados: Array<{ org: string; canal: string; evento: string; llave: string; payload: Record<string, unknown> }> = [];
    const session = new AbortAwareFakeSession([
      { match: /avisos_para_correo/, respond: () => AVISOS },
      { match: /equipo_para_avisos_correo/, respond: () => EQUIPO },
      { match: /enqueue_messaging_outbox/, respond: () => [{ enqueue_messaging_outbox: "00000000-0000-4000-8000-0000000000f1" }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (/enqueue_messaging_outbox/.test(sql)) {
        const p = params ?? [];
        encolados.push({ org: String(p[0]), canal: String(p[1]), evento: String(p[2]), llave: String(p[3]), payload: JSON.parse(String(p[4])) as Record<string, unknown> });
      }
      return original(sql, params);
    }) as typeof session.query;
    return { session, encolados };
  }

  it("encola un correo por aviso, nivel y destinatario, con la llave idempotente del nivel", async () => {
    const { session, encolados } = sesion();
    const r = await barrerAvisosPorCorreo(session, ahora);
    expect(r).toMatchObject({ disponible: true, candidatos: 3, encolados: 3 + 2 + 2, errores: 0 });
    expect(encolados.every((e) => e.canal === "email" && e.org === ORG && e.evento === "alerta.aviso_sin_atender")).toBe(true);
    const de = (sufijo: string) => encolados.filter((e) => e.llave.startsWith(`aviso-correo:00000000-0000-4000-8000-0000000000${sufijo}:`));
    expect(de("e1").map((e) => e.payload.to).sort()).toEqual(["duena@ejemplo.mx", "general@ejemplo.mx", "gerente.t7@ejemplo.mx"]);
    expect(de("e1").every((e) => /:n3:/.test(e.llave) && String(e.payload.subject).startsWith("[ESCALADA AL DUEÑO] "))).toBe(true);
    expect(de("e2").map((e) => e.payload.to).sort()).toEqual(["general@ejemplo.mx", "gerente.t7@ejemplo.mx"]);
    expect(de("e2").every((e) => /:n1:/.test(e.llave))).toBe(true);
    expect(de("e3").every((e) => /:n1:/.test(e.llave))).toBe(true);
    // Sin PII: la llave lleva una huella del correo, no el correo; el cuerpo no lleva teléfonos.
    expect(encolados.some((e) => e.llave.includes("@"))).toBe(false);
    expect(encolados.some((e) => /\d{10}/.test(String(e.payload.html)))).toBe(false);
    // Dos barridos: mismas llaves (el outbox deduplica por llave).
    const otra = sesion();
    await barrerAvisosPorCorreo(otra.session, ahora);
    expect(otra.encolados.map((e) => e.llave).sort()).toEqual(encolados.map((e) => e.llave).sort());
  });

  it("base sin la 194 (42883): nada que barrer y la sesión sigue viva", async () => {
    const err = Object.assign(new Error("function restaurantes.avisos_para_correo(timestamp with time zone, integer) does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /avisos_para_correo/, respond: () => err },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const r = await barrerAvisosPorCorreo(session, ahora);
    expect(r.disponible).toBe(false);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});
