# Conocimiento del menú del agente

En el repo suelto el menú se subía como un documento de Knowledge Base al proveedor de voz. En la fusión **no hay documento estático**: el agente consulta el
menú real, con el precio y la disponibilidad de **cada sucursal**, en cada conversación. Así un cambio de precio o un producto agotado se refleja en el
siguiente mensaje sin volver a subir nada.

## De dónde sale cada dato

| Dato | Fuente | Cómo lo obtiene el agente |
|---|---|---|
| Productos, nombres, presentaciones, precio y disponibilidad por sucursal | `restaurantes.branch_products` (se edita en el panel, *Productos*) | herramienta `buscar_producto` (con el `branch_slug` ya confirmado) |
| Total, mínimo, propina, promoción aplicada | motor de cotización del servidor | herramienta `cotizar_pedido`; el agente dice el total tal cual |
| Sucursal más cercana y zona de entrega | `buscar_sucursal_cercana` (coordenadas o colonia) | nunca de memoria |
| Horario, abierto ahora, mínimo por canal | política de la sucursal | herramienta `consultar_sucursal` |
| Historial y último pedido del cliente | `buscar_cliente` (por el teléfono de la conversación) | el modelo nunca elige de quién es el historial |
| Reglas generales (pagos, tiempos, promociones, presentaciones, salsas) | `perfil-pm.ts` (bloque `DATOS DEL NEGOCIO`) y la configuración editable del agente | texto del prompt |

Lo que `buscar_producto` no devuelve en una sucursal **no se vende ahí**: el agente lo dice y ofrece una alternativa (menú grande con comida regional en
Prolongación Montejo, García Lavín y Altabrisa; menú chico en las demás).

## Presentaciones y cantidades (resumen)

El taco al pastor, de rajas y de champiñón se vende por pieza; gringas y mestizas en órdenes de 2; alambres, tacos suizos y papadzules en órdenes de 5;
codzitos y cochinita en órdenes de 4; bistec, chorizo, pechuga, chuleta, costilla, arrachera y poc-chuc en órdenes de 3. El cliente dice **piezas**
(`requested_quantity`); el servidor las convierte a órdenes y rechaza las que no son múltiplo. Nunca lo hace el modelo.

## Cómo mantenerlo

1. Cambios de menú: panel *Productos* (precio y disponibilidad por sucursal). No requiere desplegar nada.
2. Cambios de reglas generales (salsas, promociones, tiempos, saludo): panel del agente (ver `agente-system-prompt.md`).
3. Carga masiva de un menú nuevo: `docs/demo-pm/runbook.md` (la demo) o el flujo de carga de onboarding (`onboarding-carga.ts`).
4. Códigos del POS por producto (SoftRestaurant): un producto sin código **no se inventa**; la comanda va a captura manual (ver `runbook-operacion.md`).

El catálogo transcrito del sitio del restaurante (245 productos de Francisco de Montejo, septiembre de 2026) que usaba el repo suelto queda como referencia
de ese repo; el repo fusionado lo sustituye por el catálogo en base de datos y por el seed de PM (`packages/domain-restaurantes/src/seed/`).
