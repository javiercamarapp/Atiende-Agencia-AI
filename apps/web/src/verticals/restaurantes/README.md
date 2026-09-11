# Vertical: restaurantes (web)

Fase 1 construida: `pages/Login.tsx` — pantalla real de login (email+password contra
`POST /auth/login` de `@atiende/core-auth`, reemplaza el magic-link/OAuth de Google de
`restaurantes/src/pages/AdminLogin.tsx`). El resto del dashboard visual
(`AdminDashboard`, `ClientesSection`, etc.) queda deliberadamente sin portar en esta
fase (backend/dominio ante todo) — ver el brief de Fase 1.
