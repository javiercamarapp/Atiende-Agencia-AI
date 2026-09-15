# Shell de la app

Login, selector de organización/vertical activa y layout común de `apps/web` — ya
construido (barrido de documentación, rondas 13/14/16: este README describía
"reservado, aún no construido", desactualizado). `AceptarInvitacion.tsx` (acepta el
token de `/auth/accept-invite`), `SeleccionarOrganizacion.tsx` (cuando el staff
pertenece a más de una organización) y `SinOrganizacion.tsx` (estado vacío honesto
cuando el login no resuelve ninguna membership) son las 3 pantallas reales;
`use-document-title.ts` es el hook compartido de título de pestaña.
