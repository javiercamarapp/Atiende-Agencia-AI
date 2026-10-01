// Rutas de autenticacion del mock. El "login" real de la SPA es magic link / Google: la pagina de retorno
// (`/:vertical/auth/google/callback?code=…`) canjea un codigo opaco en POST /auth/exchange-code y luego lee
// GET /auth/me. Aqui el codigo es "<escenario>~<persona>" (p. ej. "t1~restaurantes-owner") y los tokens
// repiten ambos datos para aislar el estado por prueba. Ver docs/QA-E2E.md.
import { fallo } from "../respuestas.ts";
import { organizacionesDe, resolverPersona } from "../personas.ts";
import type { Persona, Ruta } from "../tipos.ts";
import { leerToken } from "../tokens.ts";

function sesionDe(persona: Persona, escenario: string, n: number) {
  return {
    token: `mock.${escenario}.${persona.id}.${n}`,
    refreshToken: `mockr.${escenario}.${persona.id}.${n}`,
    email: persona.email,
    fullName: persona.fullName,
    organizations: organizacionesDe(persona),
  };
}

export const rutasAuth: readonly Ruta[] = [
  { metodo: "GET", patron: "/health", publica: true, manejador: () => ({ ok: true, mock: true }) },
  { metodo: "GET", patron: "/auth/google/status", publica: true, manejador: () => ({ configured: false }) },
  {
    metodo: "POST",
    patron: "/auth/magic-link/iniciar",
    publica: true,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { email?: unknown };
      return typeof cuerpo.email === "string" && cuerpo.email.includes("@") ? { ok: true } : fallo(400, "Correo invalido");
    },
  },
  {
    metodo: "POST",
    patron: "/auth/exchange-code",
    publica: true,
    manejador: (p) => {
      const code = String(((p.cuerpo ?? {}) as { code?: unknown }).code ?? "");
      const [escenario, personaId] = code.split("~");
      const persona = personaId ? resolverPersona(personaId) : null;
      if (!escenario || !persona) return fallo(400, "Codigo invalido o vencido");
      const s = sesionDe(persona, escenario, 1);
      return { token: s.token, refreshToken: s.refreshToken };
    },
  },
  {
    metodo: "GET",
    patron: "/auth/me",
    manejador: (p) => {
      const persona = p.persona!;
      return {
        email: persona.email,
        fullName: persona.fullName,
        organizations: organizacionesDe(persona),
        isPlatformSuperadmin: persona.isPlatformSuperadmin,
      };
    },
  },
  {
    metodo: "POST",
    patron: "/auth/refresh",
    publica: true,
    manejador: (p) => {
      const refresh = String(((p.cuerpo ?? {}) as { refreshToken?: unknown }).refreshToken ?? "");
      const datos = leerToken(refresh);
      if (!datos) return fallo(401, "Sesion expirada");
      const n = Number(refresh.split(".")[3] ?? "1") + 1;
      return sesionDe(datos.persona, datos.escenario, n);
    },
  },
  { metodo: "POST", patron: "/auth/logout", publica: true, manejador: () => ({ ok: true }) },
];
