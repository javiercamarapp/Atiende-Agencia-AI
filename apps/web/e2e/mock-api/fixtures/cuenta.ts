// Cuenta de staff de la API simulada (PL-21): "olvide mi contrasena", canje de los enlaces del correo, estado de la
// cuenta, sesiones activas y cambio de contrasena. Replica el contrato de apps/api/src/routes/auth-account.ts,
// auth-cuenta.ts: el restablecimiento responde SIEMPRE el mismo 200 (anti-enumeracion) y los enlaces canjeables son
// de un solo uso. Tokens de prueba conocidos: ver TOKEN_RESTABLECER / TOKEN_VERIFICAR.
import { fallo } from "../respuestas.ts";
import type { Peticion, Ruta } from "../tipos.ts";

export const TOKEN_RESTABLECER = "token-restablecer-e2e";
export const TOKEN_VERIFICAR = "token-verificar-e2e";
export const CONTRASENA_ACTUAL = "clave-actual-e2e-123";
const VERTICALES = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"];
const ENLACE_INVALIDO = "El enlace es inválido, ya se usó o expiró. Pide uno nuevo desde «Olvidé mi contraseña».";

interface SesionSim {
  id: string;
  startedAt: string;
  issuedAt: string;
  expiresAt: string;
  userAgent: string;
  current: boolean;
}

function sesionesIniciales(): SesionSim[] {
  return [
    { id: "00000000-0000-4000-8000-000000000001", startedAt: "2026-10-01T10:00:00Z", issuedAt: "2026-10-01T10:30:00Z", expiresAt: "2026-11-01T10:00:00Z", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0 Safari/537.36", current: true },
    { id: "00000000-0000-4000-8000-000000000002", startedAt: "2026-09-30T09:00:00Z", issuedAt: "2026-09-30T09:30:00Z", expiresAt: "2026-10-30T09:00:00Z", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", current: false },
  ];
}

function cuerpoDe(p: Peticion): Record<string, unknown> {
  return (p.cuerpo ?? {}) as Record<string, unknown>;
}

function sesionNueva(p: Peticion): { token: string; refreshToken: string } {
  const auth = typeof p.cabeceras.authorization === "string" ? p.cabeceras.authorization : "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return { token, refreshToken: token.replace(/^mock\./, "mockr.") };
}

export const rutasCuenta: readonly Ruta[] = [
  {
    metodo: "POST",
    patron: "/auth/password-reset/solicitar",
    publica: true,
    manejador: (p) => {
      const c = cuerpoDe(p);
      if (typeof c.email !== "string" || !c.email.includes("@")) return fallo(400, "email inválido");
      if (typeof c.vertical !== "string" || !VERTICALES.includes(c.vertical)) return fallo(400, "vertical inválida o ausente.");
      return { ok: true }; // el mismo 200 exista o no la cuenta
    },
  },
  {
    metodo: "POST",
    patron: "/auth/password-reset/confirmar",
    publica: true,
    manejador: (p) => {
      const c = cuerpoDe(p);
      if (typeof c.newPassword !== "string" || c.newPassword.length < 8) return fallo(400, "newPassword: mínimo 8 caracteres.");
      return c.token === TOKEN_RESTABLECER ? { ok: true } : fallo(400, ENLACE_INVALIDO);
    },
  },
  {
    metodo: "POST",
    patron: "/auth/email-verification/confirmar",
    publica: true,
    manejador: (p) => (cuerpoDe(p).token === TOKEN_VERIFICAR ? { ok: true } : fallo(400, ENLACE_INVALIDO)),
  },
  {
    metodo: "GET",
    patron: "/auth/account/estado",
    manejador: (p) => ({ email: p.persona!.email, emailVerified: true, hasPassword: true, google: { configured: false, available: true, identities: [] } }),
  },
  {
    metodo: "POST",
    patron: "/auth/sessions/listar",
    manejador: (p) => ({ available: true, sessions: p.estado.obtener("cuenta.sesiones", sesionesIniciales) }),
  },
  {
    metodo: "POST",
    patron: "/auth/sessions/cerrar",
    manejador: (p) => {
      const id = String(cuerpoDe(p).sessionId ?? "");
      const lista = p.estado.obtener("cuenta.sesiones", sesionesIniciales);
      if (!lista.some((s) => s.id === id && !s.current)) return fallo(404, "Esa sesión ya no existe.");
      p.estado.guardar("cuenta.sesiones", lista.filter((s) => s.id !== id));
      return { ok: true };
    },
  },
  {
    metodo: "POST",
    patron: "/auth/sessions/cerrar-todas",
    manejador: (p) => {
      p.estado.guardar("cuenta.sesiones", p.estado.obtener("cuenta.sesiones", sesionesIniciales).filter((s) => s.current));
      return sesionNueva(p);
    },
  },
  {
    metodo: "POST",
    patron: "/auth/change-password",
    manejador: (p) => (cuerpoDe(p).currentPassword === CONTRASENA_ACTUAL ? sesionNueva(p) : fallo(422, "La contraseña actual no es correcta.")),
  },
];
