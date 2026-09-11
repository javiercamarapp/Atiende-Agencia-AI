# Vertical: hoteles (api)

Fase 1 construida — los 3 flujos elegidos (ver diseño Fase 1 hoteles), montados con
`authMiddleware` + `dbSession` + `requirePropertyMembership("propertyId")` (sin
`allowedRoles` de plataforma) y `assertVerticalRole(...)` fino dentro de cada handler,
a diferencia de las rutas de restaurantes de esta misma fase (públicas/sin sesión de
staff):

- `folios.ts` — `GET/POST /hoteles/:propertyId/folios/...` +
  `GET /hoteles/:propertyId/reservas/:reservationId/folios`: cargos/descuentos/
  reverso/transferencia/split/pagos/cierre, con sus 3 capas anti-doble-captura +
  identidad (Idempotency-Key obligatorio, REQ-AB-012, impuesto siempre recalculado
  server-side).
- `pedidosFnb.ts` — `GET/POST /hoteles/:propertyId/pedidos-fnb/...`: guardia de
  alergias (REQ-AB-004).
- `quotes.ts` — `POST /hoteles/:propertyId/quotes`: motor de cotización determinista,
  guardia anti-alucinación de precio (REQ-REV-001/REQ-RES-002).
- `hoteles.ts` — agregador, montado en `apps/api/src/app.ts`.

Toda la lógica de negocio vive en `@atiende/domain-hoteles` — ninguna ruta aquí toca
SQL directamente. `admin`/`backoffice`/`mensajeria`/voz quedan reservados para una
fase posterior (ver diseño Fase 1 hoteles §6).
