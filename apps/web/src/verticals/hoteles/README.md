# Vertical: hoteles (web)

Fase 1 construida: `pages/Login.tsx` — pantalla real de login (email+password contra
`POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/restaurantes/pages/Login.tsx`). `lib/auth-client.ts` reutiliza las
funciones genéricas de red del vertical restaurantes y solo redefine lo específico de
hoteles: la llave de sesión (`atiende.hoteles.session`) y el landing path
(`/hoteles/:slug`).

El resto del dashboard visual (recepción/folios/pedidos F&B) queda deliberadamente
sin portar en esta fase (backend/dominio ante todo, ver el diseño Fase 1 hoteles).
