# Vertical: citas (web)

Fase 1 construida: `pages/Login.tsx` — pantalla real de login (email+password contra
`POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/hoteles/pages/Login.tsx`). `lib/auth-client.ts` reutiliza las funciones
genéricas de red del lib compartido y solo redefine lo específico de citas: la llave
de sesión (`atiende.citas.session`) y el landing path (`/citas/:slug`).

**Bloqueante de producto, NO de esta fase de construcción** (ver diseño Fase 1 citas
§7.1): antes de dar de baja el login viejo de `citas-reservaciones`
(magic-link + "Continuar con Google", `AdminLogin.tsx`), hay que confirmar con
Javier si el Supabase de producción de citas (ref `jfvfoettxagcqgizenum`) tiene
`tenant_staff`/`auth.users` con filas reales — a diferencia de restaurantes/hoteles,
aquí no se verificó que esté vacío. Si hay staff real, falta además un flujo de
`POST /auth/set-initial-password` (no existe todavía, trabajo genuino nuevo) antes de
poder cortar el login viejo.

El resto del dashboard visual (agenda/calendario, gestión de proveedores/servicios,
lista de espera) queda deliberadamente sin portar en esta fase (backend/dominio ante
todo, ver el diseño Fase 1 citas §6).
