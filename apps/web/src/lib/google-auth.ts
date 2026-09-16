// Cliente compartido de "Sign in with Google" (las 6 verticales) — ver el backend
// real en `apps/api/src/routes/auth-google.ts`. Un solo lugar para las 3 piezas que
// cada Login.tsx necesita: saber si el botón debe verse habilitado
// (`verificarGoogleConfigurado`), a dónde redirigir al hacer clic
// (`urlIniciarGoogleLogin`), y qué mensaje humano mostrar por cada `google_error`
// que el callback puede mandar de vuelta (`mensajeGoogleError`) — nunca el código
// crudo al usuario.
export async function verificarGoogleConfigurado(apiBaseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/google/status`);
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: boolean };
    return body.configured === true;
  } catch {
    // Red caída/API no disponible: mismo criterio honesto que el resto de esta
    // función — nunca asumir "configurado" ante la duda.
    return false;
  }
}

export function urlIniciarGoogleLogin(apiBaseUrl: string, vertical: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/auth/google/iniciar?vertical=${encodeURIComponent(vertical)}`;
}

const MENSAJES_GOOGLE_ERROR: Record<string, string> = {
  parametros_faltantes: "Google no envió los datos esperados. Vuelve a intentarlo.",
  state_invalido: "Tu sesión de Google inició en otra pestaña o expiró. Vuelve a intentarlo desde aquí.",
  state_expirado: "Tu sesión de Google venció antes de completarse. Vuelve a intentarlo.",
  nonce_invalido: "No pudimos confirmar tu identidad de Google de forma segura. Vuelve a intentarlo.",
  correo_no_verificado: "Tu cuenta de Google no tiene el correo verificado. Verifícalo en Google e inténtalo de nuevo.",
  cuenta_no_invitada: "No existe ninguna cuenta de staff con ese correo de Google. Pide que te inviten primero.",
  codigo_invalido: "Google rechazó el intento de inicio de sesión. Vuelve a intentarlo.",
  id_token_invalido: "No se pudo verificar tu identidad de Google. Vuelve a intentarlo.",
  error_desconocido: "No se pudo completar el inicio de sesión con Google. Inténtalo de nuevo.",
};

export function mensajeGoogleError(codigo: string): string {
  return MENSAJES_GOOGLE_ERROR[codigo] ?? MENSAJES_GOOGLE_ERROR.error_desconocido!;
}

// "Continuar con correo" sin contraseña — backend real en
// `apps/api/src/routes/auth-magic-link.ts`. `iniciarMagicLink` SIEMPRE resuelve
// `{ok:true}` si el request llegó (anti-enumeración: el backend responde el
// mismo 200 exista o no ese correo) — el único caso de error real que expone es
// "no se pudo contactar al servidor", nunca "ese correo no existe".
export async function iniciarMagicLink(apiBaseUrl: string, email: string, vertical: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/magic-link/iniciar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, vertical }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

const MENSAJES_MAGIC_LINK_ERROR: Record<string, string> = {
  invalido: "El enlace no es válido. Vuelve a intentarlo desde aquí.",
  invalido_o_expirado: "Ese enlace ya se usó o venció (duran 15 minutos). Pide uno nuevo.",
};

export function mensajeMagicLinkError(codigo: string): string {
  return MENSAJES_MAGIC_LINK_ERROR[codigo] ?? "No se pudo completar el inicio de sesión. Vuelve a intentarlo.";
}
