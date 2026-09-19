# Shell de la app

Login, selector de organización/vertical activa y layout común de `apps/web` — ya
construido (barrido de documentación, rondas 13/14/16: este README describía
"reservado, aún no construido", desactualizado). Son 5 pantallas reales:
`AceptarInvitacion.tsx` (acepta el token de `/auth/accept-invite`),
`SeleccionarOrganizacion.tsx` (cuando el staff pertenece a más de una
organización), `SinOrganizacion.tsx` (estado vacío honesto cuando el login no
resuelve ninguna membership), `SeleccionarVertical.tsx` (picker de vertical en
"/", reemplaza el redirect fijo anterior a `/restaurantes/login`) y
`GoogleCallback.tsx` (puente compartido de retorno de "Sign in with Google" y de
magic-link — llama a `POST /auth/exchange-code` para canjear el código opaco de
la URL por `{token, refreshToken}` antes de persistir sesión, usado por las 6
verticales); `use-document-title.ts` es el hook compartido de título de pestaña.
