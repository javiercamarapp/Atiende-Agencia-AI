# Recorrido de botones de restaurantes (PR-5 del plan de diseno-ux, seccion 7)

Alcance: `apps/web/src/verticals/restaurantes/**` (panel de gestion, repartidor, voz y bandeja). El storefront publico
(`storefront/`) no es panel y queda fuera de esta tabla.

## Metodo y limites (leer primero)

- **Estatico, sobre el codigo de esta rama**: se extrajo cada `Button`, `button`, `Link`/`a`, `TabsTrigger`, `Checkbox`,
  `NativeSelect`, `form` y `AlertDialogAction/Cancel` de las 20 paginas y de `RestaurantesShell.tsx` (184 sitios JSX con
  controles de entrada incluidos) y se leyo el handler de cada uno hasta la funcion de cliente que llama al API
  (`apps/web/src/verticals/restaurantes/lib/*-client.ts`). Resultado por control: **CABLEADO** (handler real y efecto
  verificable), RETIRAR o CABLEAR-PENDIENTE. Un control "Pronto" no cuenta como cableado.
- **Resultado: 0 controles RETIRAR y 0 CABLEAR-PENDIENTE** (ningun `disabled` fijo, ningun handler vacio, ningun `href="#"`).
- **Ejecucion real**: las capturas de este PR se tomaron en un navegador real contra una API simulada (fixtures locales),
  no contra el backend. Las pantallas con prueba de componente propia estan marcadas en la columna "Prueba"; las demas
  quedan con verificacion estatica + captura, **no** con prueba automatizada de clic.
- Nada se verifico contra la base ni el API reales (no se tocaron).

Estado de los criterios 7.3 por control: 1 handler, 2 efecto, 3 `disabled` solo por condicion, 4 exito, 5 error, 6 permiso,
7 destructivo con confirmacion, 8 teclado/AT, 9 movil, 10 oscuro. Los criterios 3, 6 y 7 se leen en el codigo (columna
Estados); 4 y 5 se resumen como "recarga/estado local + error en `EstadoError`/texto" salvo que se indique otra cosa;
8-10 salen de los primitivos de `@atiende/ui` (no se auditaron pantalla por pantalla).

## Shell, navegacion y cuenta (todas las rutas)

| Control | Handler / destino | Efecto | Estado |
|---|---|---|---|
| Items del Sidebar (Panel, Pedidos, Conversaciones, Turnos, Historial, Productos, Promociones, Sucursales, Clientes; Staff, Auditoria, Configuracion, Agente de voz, Privacidad solo owner/admin) | `NavLink to=/restaurantes/:org/...` | las 14 rutas existen en `App.tsx` (lineas 841-859) | CABLEADO |
| Barra inferior movil: Panel, Pedidos, Historial, Productos | `NavLink` | rutas de `App.tsx`; **Panel ahora activo solo en su ruta exacta (`end`)** | CABLEADO |
| Boton "Mas" (movil) | abre hoja con TODAS las secciones | antes 5 destinos fijos y el resto sin acceso movil | CABLEADO (probado) |
| Selector de sucursal (Sidebar y MobileHeader, solo con 2+ sucursales) | `s.selectBranch` -> persiste por organizacion y remonta el `<main>` por `key` | cambia `propertyId` del contexto | CABLEADO (probado en `useVerticalSession`, #234) |
| Campana, tema, cerrar sesion, "Chatea con tus datos" | `VerticalShellConectado` / `MobileAccountMenu` | cerrar sesion limpia `localStorage` (probado) | CABLEADO |
| Enlace "Saltar al contenido" | ancla `#contenido-principal` | foco al `<main>` | CABLEADO (probado) |
| Login: Google, "Continuar con correo" | `VerticalLogin` (compartido con citas) | `verificarGoogleConfigurado`, `iniciarMagicLink` | CABLEADO (probado en #234) |

## Pantallas

Prueba = prueba de componente existente que ejerce la pantalla (`apps/web/tests`). "No" = solo verificacion estatica.

| Pantalla | Controles (handler -> efecto) | Prueba |
|---|---|---|
| **Panel** (`Dashboard.tsx`) | Tabs de periodo -> `setPeriod` -> `fetchDashboardData` (GET `kpis/sales`, `sales/trend`, `channels`, `customers`); "Actualizar" -> `loadKpis` (`disabled` solo mientras carga) | restaurantes-dashboard-page |
| **Pedidos** | Tabs de estado; casilla de auto-impresion -> `activarAutoImpresion/desactivarAutoImpresion` (preferencia local + sondeo); selector de repartidor -> `assignRepartidor` (PATCH `orders/:id/assign-repartidor`); "Imprimir/Reimprimir ticket" y "Vista previa" -> ticket de cocina; "Marcar X" -> `updateOrderStatus` (PATCH `orders/:id/status`), cancelar pide `AlertDialog` con el nombre del cliente; casilla "Avisar al cliente" | restaurantes-pedidos-page, -recoger-page, -ticket-cocina |
| **Historial** | filtros estado/desde/hasta -> `fetchOrders`; "Cargar mas" -> siguiente cursor | No |
| **Productos** | "Crear categoria" -> `createCategory` (POST); "Crear producto" -> `createProduct` (POST); precio (al salir del campo) -> `setBranchAvailability` (PATCH `branch-availability`); "Disponible/No disponible" -> `setBranchAvailability`; casilla Popular -> `updateProduct` (PATCH); casillas "no a domicilio" -> `setNoDomicilio` (PUT) | restaurantes-productos-no-domicilio-page |
| **Promociones** | "Crear un codigo nuevo" -> `FormDialog` -> `createPromotion` (POST); "Editar vigencia" -> `FormDialog` -> `updatePromotion` (PATCH); "Activar/Desactivar" -> `updatePromotion`; tipo, canal, dias, productos (casillas) y fechas alimentan el cuerpo | restaurantes-promociones-page, -automaticas-page |
| **Clientes / ficha** | busqueda -> `fetchCustomers`; fila -> `Link` a la ficha; "Volver a clientes" -> `Link` | No |
| **Sucursales + reglas** | "Editar/Guardar/Cancelar" -> `updateBranchDetail` (PATCH); "Reglas de pedido" -> `ReglasSucursal`: turnos, minimos, propina, zonas -> `updatePoliticaSucursal`/`updateZonasReparto` (PUT); puentes -> crear/`deletePuente` (DELETE); numero -> `updateWhatsappSucursal` (PUT) | restaurantes-sucursales-page, -reglas-sucursal-page, -puentes-sucursal-page |
| **Staff** | "Invitar" -> `createStaffInvite` (POST); "Revocar" -> `revokeStaffInvite` (DELETE); selector de rol -> `updateStaffRole` (PATCH); "Dar de baja" -> **`useConfirm` (peligro, con el nombre)** -> `removeStaffMember` (DELETE); `disabled` en la propia fila con `title` del motivo | restaurantes-confirmaciones-destructivas (baja: cancelar / confirmar) |
| **Configuracion** | "Guardar" WhatsApp -> `updateWhatsappConfig` (PUT); zona horaria -> `updateBranchTimezone` (PATCH); "Agregar zona" -> `createKnownZone` (POST); icono papelera (**ahora con `aria-label`**) -> **`useConfirm`** -> `deleteKnownZone` (DELETE); seccion del agente de WhatsApp (perfil, alcance, tono, textos, motivos, "Revisar cambios", "Confirmar y guardar", "Volver al perfil por defecto", "Usar esta version", "Recargar") | restaurantes-confirmaciones-destructivas (zona), restaurantes-agente-whatsapp-seccion |
| **Conversaciones + Callbacks** | pestañas; filtros estado/canal; fila; "Tomar", "Devolver al agente", "Marcar como resuelta", "Enviar respuesta", "Agregar" nota; callbacks: "Tomar/Resolver/Liberar/Asignar/Reabrir" e intentos | restaurantes-conversaciones-page, -callbacks-panel |
| **Turnos** | "Agregar turno", "Quitar turno", "Usar el doble turno", dias y personal (casillas), "Guardar turnos" -> `guardarTurnos` | restaurantes-turnos-page |
| **Auditoria** | filtro tipo/desde/hasta -> `fetchAuditoria`; "Cargar mas" | No |
| **Agente de voz** | pestañas; "Vista previa" y "Abrir vista previa (demostracion)" (simulacion local, rotulada); habilitado, voz (`SelectorVoz`: escuchar muestra / elegir), prompt y primer mensaje; "Guardar cambios" -> `updateVozConfig` (PUT; `disabled` por condicion); "Ver transcripcion" / "Volver a la lista" | voz-agente-voz-page |
| **Privacidad** | formulario -> `guardarConfiguracionPrivacidad` (PUT); filtros; acciones del panel ARCO -> `actualizarEstadoSolicitudArco` (PATCH); "Cargar mas" | restaurantes-privacidad-page |
| **Repartidor** (`/repartidor`, fuera del shell) | "Mapa" y "Llamar" -> enlaces `https://www.google.com/maps/...` y `tel:`; "Marcar en camino/entregado" -> `updateAssignedOrderStatus` (PATCH); "Reportar incidencia" -> `AlertDialog` con nota -> misma funcion | No (solo el cliente, restaurantes-repartidor-client) |

## Hallazgos del recorrido

| # | Hallazgo | Accion en este PR |
|---|---|---|
| H-1 | Baja de staff y "quitar zona" usaban `window.confirm` (nativo, sin nombre accesible, bloqueante) | `useConfirm` con tono peligro, nombre del objeto y prueba de cancelar/confirmar |
| H-2 | Boton de solo icono (papelera) de zonas sin nombre accesible | `aria-label="Quitar zona <nombre>"` |
| H-3 | Barra inferior movil con 5 destinos fijos: Conversaciones, Turnos, Promociones, Sucursales, Clientes y todo el bloque Equipo no tenian acceso movil | 4 destinos + "Mas" con todas las secciones |
| H-4 | "Panel" de la barra movil quedaba activo en cualquier subruta (no tenia `end`) | `end: true` |
| H-5 | `Dashboard` renderizaba un `<main>` dentro del `<main>` del shell (HTML invalido) | `PageContainer` (div) |
| H-6 | Las listas de productos de una promocion eran `<select multiple>` (poco usable en movil/teclado) | grupos de casillas con `role="group"`; conservan el orden del catalogo |
| H-7 (NO corregido) | El item "Panel (KPIs)" del Sidebar de escritorio tambien se ve activo en subrutas (el `Sidebar` compartido no soporta `end`) | fuera de alcance (`packages/ui`); queda en knownGaps |
