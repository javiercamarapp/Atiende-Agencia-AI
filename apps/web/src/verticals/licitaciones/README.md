# Vertical: licitaciones (web)

Fase 1 construida: `pages/Login.tsx` — pantalla real de login (email+password
contra `POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/hoteles/pages/Login.tsx`/`verticals/restaurantes/pages/Login.tsx`).
`lib/auth-client.ts` reutiliza las funciones genéricas de red del vertical
restaurantes y solo redefine lo específico de licitaciones: la llave de
sesión (`atiende.licitaciones.session`) y el landing path
(`/licitaciones/:slug`).

Explícitamente fuera de esta fase (ver diseño Fase 1 licitaciones §5/§6): 2FA
TOTP, Google OAuth, verificación de email, rotación de refresh token,
invitaciones de staff, y el resto del panel visual (checklist/propuesta
económica/cierre) — backend/dominio ante todo en esta fase.
