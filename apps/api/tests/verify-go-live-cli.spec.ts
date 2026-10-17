// CLI `npm run verify:go-live` (scripts/verify-go-live): argumentos, lectura SOLO LECTURA (begin read only ... rollback, jamas commit ni escritura),
// reporte sin secretos y codigo de salida. La conexion es un doble que contesta por SQL; el calculo es el mismo `evaluarPreflight` de la ruta.
import { describe, expect, it } from "vitest";
import { GoLiveError, codigoDeSalida, formatearReporte, leerEntrada, parseArgs, parseEnvFile } from "../../../scripts/verify-go-live/verify-go-live.ts";
import { evaluarPreflight } from "../src/superadmin-preflight/verificaciones.ts";

const SA = "00000000-0000-4000-8000-0000000000aa";
const ORG = { id: "11111111-1111-4111-8111-111111111111", name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes", status: "trial" };
const SECRETO = "valor-secreto-que-jamas-debe-salir";

interface Doble {
  readonly sqls: string[];
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function doble(opciones: { org?: typeof ORG | null; esSuperadmin?: boolean; sinRol?: boolean; heartbeats?: unknown[] | Error } = {}): Doble {
  const sqls: string[] = [];
  return {
    sqls,
    async query(sql: string) {
      sqls.push(sql.replace(/\s+/g, " ").trim());
      if (/from core\.organization where slug/.test(sql)) return { rows: opciones.org === null ? [] : [opciones.org ?? ORG] };
      if (/set local role authenticated/.test(sql)) {
        if (opciones.sinRol) throw new Error("permission denied to set role");
        return { rows: [] };
      }
      if (/core\.is_platform_superadmin/.test(sql)) return { rows: [{ es: opciones.esSuperadmin ?? true }] };
      if (/list_org_team_for_superadmin/.test(sql)) return { rows: [{ equipo: { miembros: [{ userId: "u1", correo: "d***@x.mx", rol: "owner", platformRole: "owner", propertyIds: null, altaEn: "2026-10-01T00:00:00.000Z" }], invitaciones: [], sucursales: [{ id: "s1", nombre: "García Lavín", estado: "active" }] } }] };
      if (/get_org_preflight_restaurantes_for_superadmin/.test(sql)) return { rows: [{ hechos: { vertical: "restaurantes", restaurantes: { sucursales: [], whatsappGeneral: false, agente: { configurada: false, conNombre: false }, hayPedidos: false, privacidad: null } } }] };
      if (/list_cron_heartbeats_for_superadmin/.test(sql)) {
        if (opciones.heartbeats instanceof Error) throw opciones.heartbeats;
        return { rows: opciones.heartbeats ?? [] };
      }
      if (/superadmin_mfa_get_factor/.test(sql)) return { rows: [{ secret_ciphertext: "x", status: "active", last_used_step: null, locked_until: null }] };
      return { rows: [] };
    },
  };
}

const ARGS = { org: "los-taquitos-de-pm", superadmin: SA };
const ENV = { VERCEL_ENV: "production", APP_BASE_URL: "https://app.lostaquitos.mx", INTERNAL_SECRET: SECRETO, CRON_SECRET: SECRETO, OPENROUTER_API_KEY: SECRETO };

describe("parseArgs", () => {
  it("--org y --superadmin (o GO_LIVE_SUPERADMIN_ID); --env-file opcional; ambos estilos de valor", () => {
    expect(parseArgs(["--org", "taquitos", "--superadmin", SA], {})).toEqual({ org: "taquitos", superadmin: SA, envFile: null });
    expect(parseArgs([`--org=taquitos`, "--env-file", ".env.production.local"], { GO_LIVE_SUPERADMIN_ID: SA })).toEqual({ org: "taquitos", superadmin: SA, envFile: ".env.production.local" });
  });
  it("uso incorrecto: sin org, slug invalido, sin superadmin o uuid malo, opcion desconocida -> GoLiveError(2)", () => {
    for (const argv of [[], ["--org", "A B"], ["--org", "taquitos"], ["--org", "taquitos", "--superadmin", "no-uuid"], ["--org", "taquitos", "--superadmin", SA, "--url", "x"], ["taquitos"], ["--org"]]) {
      expect(() => parseArgs(argv, {}), JSON.stringify(argv)).toThrow(GoLiveError);
    }
    try {
      parseArgs([], {});
    } catch (e) {
      expect((e as GoLiveError).codigoSalida).toBe(2);
    }
  });
});

describe("parseEnvFile", () => {
  it("KEY=VALUE con comillas, export y comentarios; ignora lo que no es asignacion", () => {
    const env = parseEnvFile(`# comentario\nexport A=1\nB="dos palabras"\nC='x'\nD=valor # nota\n\nlinea suelta\n`);
    expect(env).toEqual({ A: "1", B: "dos palabras", C: "x", D: "valor" });
  });
});

describe("leerEntrada: solo lectura", () => {
  it("una transaccion `begin read only` que SIEMPRE termina en rollback; nunca commit ni escritura", async () => {
    const c = doble();
    const entrada = await leerEntrada(c, ARGS, ENV);
    expect(c.sqls[0]).toBe("begin read only");
    expect(c.sqls[c.sqls.length - 1]).toBe("rollback");
    expect(c.sqls.some((s) => /^(commit|insert|update|delete|create|drop|alter|truncate)\b/i.test(s))).toBe(false);
    expect(entrada.organizacion).toMatchObject({ slug: "los-taquitos-de-pm", vertical: "restaurantes" });
    expect(entrada.equipo.estado).toBe("ok");
    expect(entrada.hechos.estado).toBe("ok");
    expect(entrada.mfaDelConsultante).toBe(true);
    expect(entrada.crons).toEqual(expect.any(Array));
  });

  it("organizacion inexistente: GoLiveError(3) y rollback", async () => {
    const c = doble({ org: null });
    await expect(leerEntrada(c, ARGS, ENV)).rejects.toMatchObject({ codigoSalida: 3 });
    expect(c.sqls[c.sqls.length - 1]).toBe("rollback");
  });

  it("el usuario no es superadmin, o la conexion no puede cambiar de rol: GoLiveError(3) y rollback", async () => {
    const a = doble({ esSuperadmin: false });
    await expect(leerEntrada(a, ARGS, ENV)).rejects.toMatchObject({ codigoSalida: 3 });
    expect(a.sqls[a.sqls.length - 1]).toBe("rollback");
    const b = doble({ sinRol: true });
    await expect(leerEntrada(b, ARGS, ENV)).rejects.toMatchObject({ codigoSalida: 3 });
    expect(b.sqls[b.sqls.length - 1]).toBe("rollback");
  });

  it("una lectura de latidos que falla deja los crons en null (con su savepoint) y no tumba el resto", async () => {
    const c = doble({ heartbeats: new Error("boom") });
    const entrada = await leerEntrada(c, ARGS, ENV);
    expect(entrada.crons).toBeNull();
    expect(c.sqls).toContain("rollback to savepoint preflight_crons");
    expect(entrada.equipo.estado).toBe("ok");
  });
});

describe("reporte y codigo de salida", () => {
  it("lista cada verificacion con su estado y como resolverla; nunca imprime un secreto", async () => {
    const entrada = await leerEntrada(doble(), ARGS, ENV);
    const r = evaluarPreflight(entrada);
    const texto = formatearReporte(entrada, r);
    expect(texto).toContain("Los Taquitos de PM");
    expect(texto).toContain("[FALTA   ] WhatsApp / Meta");
    expect(texto).toContain("-> ");
    expect(texto).toContain(`${r.resumen.pendientes} pendiente(s)`);
    expect(texto).not.toContain(SECRETO);
  });

  it("sale 1 si hay algun 'falta' y 0 si no", async () => {
    const entrada = await leerEntrada(doble(), ARGS, ENV);
    const r = evaluarPreflight(entrada);
    expect(r.resumen.falta).toBeGreaterThan(0);
    expect(codigoDeSalida(r)).toBe(1);
    expect(codigoDeSalida({ ...r, resumen: { ...r.resumen, falta: 0, pendientes: 0, listo: true } })).toBe(0);
  });

  it("sin 'falta' pero con una fuente sin leer sale 1 y el reporte dice NO LISTO por la fuente", async () => {
    const entrada = await leerEntrada(doble(), ARGS, ENV);
    const r = evaluarPreflight(entrada);
    const sinLeer = { ...r, resumen: { ...r.resumen, falta: 0, pendientes: 0, listo: false } };
    expect(codigoDeSalida(sinLeer)).toBe(1);
    expect(formatearReporte(entrada, sinLeer)).toContain("NO LISTO: alguna fuente no se pudo leer");
  });
});
