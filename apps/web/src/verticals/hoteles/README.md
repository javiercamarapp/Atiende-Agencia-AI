# Vertical: hoteles (web)

Fase 1: `pages/Login.tsx` — pantalla real de login (email+password contra
`POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/restaurantes/pages/Login.tsx`). `lib/auth-client.ts` reutiliza las
funciones genéricas de red del vertical restaurantes y solo redefine lo específico de
hoteles: la llave de sesión (`atiende.hoteles.session`) y el landing path
(`/hoteles/:slug`).

Fase 7 — primera UI de staff real del vertical, más allá del login (el gap que
dejó pendiente la Fase 1: "el resto del dashboard visual queda deliberadamente sin
portar"). Mismo patrón exacto que `verticals/restaurantes` (shell + páginas +
lib/*-client.ts, estilos inline, sin design system nuevo, `fetchImpl` siempre
inyectado para poder probar la lógica de red con vitest en entorno "node"):

- `HotelesShell.tsx` — resuelve sesión + property (vía `lib/discovery-client.ts`,
  que a su vez llama a `GET /v1/hoteles/:orgSlug/admin/propiedades`, ruta nueva de
  esta fase — ver `apps/api/src/routes/verticals/hoteles/admin-discovery.ts` y su
  comentario de cabecera: plumbing indispensable, mismo criterio que el helper
  equivalente de restaurantes) y da nav lateral a las páginas nuevas.
- `pages/Reservas.tsx` (`lib/reservas-client.ts`) — recepción: crear reserva,
  listar/filtrar por estado, avanzar la máquina de estados (check-in → en estancia →
  check-out → cerrada) y cancelar. Como esta fase del backend NO expone un catálogo
  de tipos de habitación por HTTP, `roomTypeId` se captura como texto libre en el
  formulario (el servidor sigue siendo la única autoridad: un id inválido regresa 404
  real, nunca se inventa una lista).
- `pages/Folio.tsx` (`lib/folios-client.ts`) — caja de un folio: cargos, descuentos,
  reversos, pagos (efectivo/transferencia — tarjeta queda fuera: exige un token real
  de pasarela, nunca un número de tarjeta capturado a mano) y cierre
  (saldo-cero/cuenta-por-cobrar). Se llega desde "Ver folio" en una fila de Reservas.
- `pages/Mantenimiento.tsx` (`lib/housekeeping-client.ts`) — tickets correctivos:
  crear/listar/filtrar/cerrar con costo real. Los turnos de camaristas/lavandería
  (REQ-HK-008, LFT) NO están en esta página — flujo de programación semanal propio,
  de forma distinta al resto de este panel, queda pendiente.
- `pages/Fraude.tsx` (`lib/fraude-client.ts`) — cola de fraude interno: ejecutar
  escaneo determinista (nunca LLM) y confirmar/descartar alertas.

Fase 15 — hallazgo de auditoría (severidad ALTA, "Pedidos F&B con guardia de
alergias: backend real sin pantalla"): `GET/POST pedidos-fnb`, `GET .../:orderId`,
`POST .../confirmar-cocina` y `POST .../asegurar-seguridad`
(`apps/api/.../pedidosFnb.ts`) ya estaban montados y probados del lado del
servidor, pero el rol `fnb` no tenía ninguna superficie en el panel:

- `pages/PedidosFnb.tsx` (`lib/pedidos-fnb-client.ts`) — tomar pedido (roomId +
  platillos + notas + flag de alergia), confirmar en cocina y asegurar la guardia
  de seguridad al huésped. El link "Pedidos F&B" del nav de `HotelesShell.tsx` y
  los botones de confirmar/asegurar se ocultan cosméticamente según
  `TOMAR_PEDIDO_ROLES`/`CONFIRMAR_COCINA_ROLES` (mismo espejo de
  `domain-hoteles/src/roles.ts` que ya usa `RestaurantesShell.tsx` con
  `STAFF_NAV_ROLES`) — el enforcement real sigue siendo `assertVerticalRole` en
  `pedidosFnb.ts`, nunca el cliente. El botón "Asegurar seguridad" se deshabilita
  cuando `puedeAsegurarSeguridad` (calculado en vivo por el servidor desde
  `fnbAllergyGuard.ts`) es `false`, para que el staff vea la regla de negocio en
  vez de descubrirla con un 409.

## Explícitamente pendiente después de esta fase

Portado real, no fingido — lo que sigue sin UI, para que quede honesto en vez de
asumido:

- **CFDI de hospedaje** (`apps/api/.../cfdi.ts`) — emitir/consultar/cancelar CFDI
  no tiene página propia todavía.
- **Night audit** (`apps/api/.../night-audit.ts`) — sin panel de corridas/resumen.
- **Turnos de housekeeping/lavandería** (REQ-HK-008) — el endpoint LFT existe, la
  UI de publicar/consultar turnos no.
- **Transferir cargo entre folios / split de folio** — los endpoints existen
  (`folios.ts`), el formulario de Folio.tsx no los expone todavía (cargo/descuento/
  reverso/pago/cierre sí).
- **Selector visual de property** — igual que restaurantes/citas, el shell usa la
  primera property de la organización; un selector para organizaciones multi-hotel
  reales queda para una fase futura.
