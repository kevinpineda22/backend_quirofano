# Backend Quirofano comercial

Backend Express independiente del frontend, listo para extraer esta carpeta a su propio repositorio y desplegar en Vercel. Usa el mismo proyecto Supabase de la intranet y su autenticacion existente. No contiene credenciales ni necesita Siigo para ejecutar las pruebas.

## Modo de consultas con anon key y sesion

Para consultar desde el frontend sin `service_role`, configurar:

```dotenv
QUIROFANO_READ_ONLY=true
SUPABASE_URL=URL_DEL_PROYECTO
SUPABASE_ANON_KEY=ANON_KEY_DEL_PROYECTO
SIIGO_USERNAME=USUARIO_API
SIIGO_ACCESS_KEY=ACCESS_KEY_API
SIIGO_PARTNER_ID=MerkahorroQuirofano
SIIGO_WRITES_ENABLED=false
```

`Partner-Id` es el nombre real de la integracion (3-100 caracteres alfanumericos, sin espacios), no una clave expedida por Siigo: [referencia oficial](https://developers.siigo.com/docs/siigoapi/partner-id/).

Reiniciar el backend con `npm start` desde esta carpeta y recargar `/quirofano`. No hace falta ejecutar SQL adicional ni cambiar RLS. El usuario debe tener sesion vigente y permiso `/quirofano`.

El frontend usa la identidad de `public/quirofano.png`, con navegacion oscura, acentos rojos y paneles claros. El tema esta limitado al modulo; conserva el menu movil/plegable, las alertas financieras y los mismos permisos y operaciones.

- Cada solicitud verifica el JWT contra Supabase y consulta `profiles`/`role_permissions` con **anon key + JWT del usuario**, mediante un cliente independiente por solicitud. No utiliza un token de usuario compartido. El editor opcional tambien usa ese cliente por sesion, sin `service_role` ni firmas adicionales: lee bajo RLS y las mutaciones requieren el permiso de edicion existente en el sistema.
- La pantalla ofrece **Consultar productos** y **Consultar compras**. El catalogo cuenta activos/inactivos y permite buscar, paginar y elegir lista. Las compras muestran renglones originales, fechas, cantidades, valores unitarios y descuentos, sin presentar IVA desconocido como costo neto.
- **Consultar productos** muestra costo sin IVA de la ultima fecha de compra vigente en Siigo, fecha del costo, precio con IVA de la lista seleccionada y margen sobre venta neta: `(precio sin IVA - costo neto) / precio sin IVA * 100`. Por regla de negocio de este catalogo, si Siigo no informa `tax_included` y no hay confirmacion manual, el valor de compra se trata como costo sin IVA; no queda pendiente de confirmar. Si Siigo informa que incluye IVA, se descuenta. Esta regla no cambia la confirmacion exigida en Analitica de facturas. Las compras de la misma fecha se ponderan por cantidad, sin inventar su orden. Se aplican descuentos con el normalizador de compras; las retenciones no reducen el costo. Compras futuras/anuladas no se usan. Si la ultima fecha tiene divisas o impuestos no soportados, costo y margen quedan sin dato con el motivo visible; no se usa un costo anterior para ocultar el problema. No es un porcentaje guardado en Siigo ni utilidad contable. La consulta requiere leer todas las compras dentro de los limites indicados y falla explicitamente si esa lectura falla.
- La navegacion del modo consulta queda solo en **Consultar productos** y **Consultar compras**. El liquidador y el historial se abren dentro del catalogo con **Liquidar / Historial**; no hay entradas separadas para analitica o simulacion. `POST /api/quirofano/products` conserva el contrato `{ query, taxConfirmations }` para consumidores existentes; la interfaz utiliza el ultimo costo y la regla de IVA anterior. El IVA explicito de Siigo prevalece y las confirmaciones nunca se comparten en el cache del servidor.
- La lectura comprueba todas las paginas e identificadores antes de presentar totales. Usa cache en memoria durante 60 segundos; **Actualizar consultas** lo invalida. No persiste los resultados.
- Limites: 50.000 productos, 1.000 facturas y 5.000 renglones de productos comprados. Si se superan, falla explicitamente; no entrega agregados truncados.
- Sin el editor opcional, el modo bloquea borradores, historial, aprobaciones, vinculacion, sincronizacion persistente y cron, incluso mediante solicitudes HTTP directas. Siigo se inicializa con escrituras deshabilitadas aunque `SIIGO_WRITES_ENABLED=true`, salvo que tambien se habilite `QUIROFANO_PRICE_EDITING_ENABLED`. El editor solo habilita las rutas acotadas descritas a continuacion; no habilita el cron ni las escrituras de compras.
- `npm run test:connection` comprueba Siigo sin acceder a tablas de Quirofano. La comprobacion de sesion y permisos se realiza al entrar por la intranet; el comando no sustituye esa validacion.
- Si Supabase no permite leer el perfil/rol del propio usuario, se muestra un error: no se salta la autorizacion ni se cambia RLS automaticamente.

El listado `GET /v1/purchases` se verifico contra la cuenta real el 2026-11-18. Esta disponibilidad se usa en **modo consulta**; el flujo persistente descrito a continuacion conserva la vinculacion por UUID y aun no descubre compras automaticamente.

## Fase 1: editor auditado por producto

Se abre desde **Consultar productos > Liquidar / Historial**. Conserva las consultas directas a Siigo y agrega historial permanente de propuestas y precios en Supabase.

### Activacion local

1. Aplicar, con revision previa, `sql/001_quirofano.sql` y despues `sql/002_editor_jwt.sql` en el Supabase de la intranet. La segunda migracion habilita lecturas autenticadas del modulo bajo RLS, sin modificar las politicas de perfiles ni conceder escrituras directas a usuarios.
2. Configurar `SUPABASE_URL` y `SUPABASE_ANON_KEY` en el `.env` del backend. Es la misma clave publica que el frontend identifica como `VITE_SUPABASE_ANON_KEY`; no es `service_role`. La sesion JWT recibida en cada solicitud determina quien puede operar.
3. Mantener `QUIROFANO_READ_ONLY=true` y agregar `QUIROFANO_PRICE_EDITING_ENABLED=true`. Con `SIIGO_WRITES_ENABLED=false` se pueden guardar propuestas y comprobar el historial, pero no se pueden aplicar precios.
4. Asignar el modulo `/quirofano` al usuario o rol desde la administracion de rutas. Ese mismo permiso habilita consultas y edicion de precios, sin otro permiso adicional. Los permisos personales siguen reemplazando los del rol.
5. Habilitar `SIIGO_WRITES_ENABLED=true` solo al autorizar cambios reales. Reiniciar `npm start` desde esta carpeta y recargar la pagina.

El editor no necesita `SUPABASE_SERVICE_ROLE_KEY`, `QUIROFANO_AUDIT_SECRET` ni registrar secretos en SQL. Si se aplico una version anterior de `sql/002_editor_jwt.sql`, volver a ejecutarla: actualiza el permiso compartido de consulta/edicion y reemplaza la RPC anterior con firma sin borrar el historial. La antigua configuracion privada, si existe, queda sin uso. Sin migracion/permisos, muestra el error de acceso al historial sin ocultar las consultas de productos y compras. No presenta un historial vacio como si hubiera sido consultado correctamente.

La tabla antirrepeticion no tiene acceso publico ni autenticado. Los usuarios autenticados solo reciben `SELECT` sobre productos, catalogos, propuestas y eventos, filtrado por el permiso de modulo. Las mutaciones pasan por una RPC `SECURITY DEFINER` que exige sesion y acceso al mismo modulo `/quirofano`; el actor se obtiene de `auth.uid()`, nunca de un identificador libre del cliente. Una solicitud vence a los dos minutos y su nonce no se puede repetir. Las RPC antiguas siguen sin permisos de ejecucion para usuarios; solo la RPC del editor puede utilizarlas en este flujo.

El historial confia en todos los usuarios con acceso al modulo: estos tambien pueden llamar directamente a la RPC con su JWT y registrar estados sin pasar por la verificacion de Siigo del backend. No es una prueba independiente de que Siigo aplico el precio. Los usuarios sin acceso al modulo o sin sesion no pueden realizar esas operaciones. Los flags del backend protegen los cambios reales en Siigo, no las llamadas directas a Supabase de un usuario autorizado.

### Calculo y aplicacion

- Margen sobre venta neta: `precio_final = costo_sin_IVA / (1 - margen/100) * (1 + IVA/100)`, redondeado hacia arriba al multiplo de COP 100. El IVA se incluye en el cobro, no en la ganancia. Ejemplo: costo 59.400, objetivo 30%, IVA 19%: precio final 101.000 y margen efectivo aproximadamente 30,01%.
- Ganancia fija: `precio_final = (ultimo_costo_sin_IVA + ganancia_fija) * (1 + IVA/100)`, con el mismo redondeo hacia arriba a COP 100.
- Precio final fijo: se respeta el valor indicado con IVA, sin redondearlo a COP 100; se muestran su ganancia y margen resultantes. Si vende bajo el costo, se advierte la perdida antes de confirmar.
- Los tres modos usan `calculatePrice()` y conservan el tratamiento tributario del producto. La retefuente se conserva como retencion, no se suma al IVA ni se descuenta del costo para inventar utilidad. Los tributos desconocidos siguen bloqueando la liquidacion.
- **Preparar cambio** vuelve a leer productos y compras, aplica la misma regla del costo del catalogo, valida la lista activa y guarda una propuesta con usuario, costo, fecha, IVA, regla y precios anterior/nuevo. No escribe en Siigo. Las confirmaciones de IVA de la pantalla quedan dentro de la propuesta para revalidar el mismo criterio.
- **Confirmar y actualizar Siigo** requiere acceso al modulo y ambos flags. Relee el costo, el precio y los impuestos; si cambiaron, no aplica la propuesta. Solo actualiza la lista seleccionada, conserva las demas listas y monedas y comprueba el resultado mediante una lectura posterior.
- Cada propuesta tiene identificador propio. Repetir una propuesta ya aplicada no repite el PUT. Un timeout de escritura queda en revision y mantiene el bloqueo del producto. **Verificar sin escribir** consulta el resultado sin repetir el PUT; una operacion en curso debe esperar al menos dos minutos.
- Los historiales muestran las compras vigentes disponibles en Siigo (incluidas las advertencias de normalizacion), la evolucion diaria del costo y las propuestas/cambios de esta herramienta en todas las listas. Los registros aplicados conservan el costo y los margenes de su momento, asi como quien preparo y quien aprobo. No se inventan cambios antiguos hechos directamente en Siigo ni se presentan propuestas no aplicadas como cambios efectivos.

Rutas autenticadas del editor:

- `POST /api/quirofano/price-scope/preview`: vista previa de todo un portafolio `{ scope: { type: "category" | "supplier", value }, position, mode, target, taxConfirmations }`; no guarda ni escribe precios.
- `POST /api/quirofano/products/:id/purchases`: historial de compras `{ query: { page }, taxConfirmations }`.
- `GET /api/quirofano/products/:id/price-history?page=1`: historial auditado del producto.
- `POST /api/quirofano/products/:id/price-preview`: prepara `{ position, mode, target, taxConfirmations, expected? }`; `mode` puede ser `margin`, `fixed` o `price` (por compatibilidad, omitirlo conserva `margin`). El snapshot opcional `expected` del portafolio bloquea una preparacion si cambio el precio, costo, fecha o IVA.
- `POST /api/quirofano/price-changes/:id/apply`: confirma una propuesta ya guardada.
- `POST /api/quirofano/price-changes/:id/verify`: verifica sin escribir.

Todas estas rutas exigen acceso a `/quirofano` en el backend, igual que las consultas. Las rutas persistentes antiguas de guardar/aprobar/verificar usan el mismo permiso.

### Proveedores, portafolios y alertas

- Productos y compras permiten buscar/seleccionar proveedor por NIT/identificador y nombre. Cuando las compras no traen el nombre, se consulta exclusivamente ese tercero mediante `GET /v1/customers/{id}` (no se descargan ni muestran todos los clientes). Las lecturas de nombres se comparten y cachean por 60 segundos; una respuesta incompleta o un error se muestra como advertencia, sin inventar el nombre. El portafolio contiene todos los productos comprados al proveedor en las facturas vigentes disponibles, aunque la ultima compra sea de otro proveedor. Facturas futuras o anuladas no lo amplian. No se inventan asociaciones para proveedores por renglon o sin identificador: se muestra una advertencia.
- **Liquidar categoria completa** y **Liquidar proveedor completo** incluyen todos los productos activos de ese grupo, no solo la pagina visible ni la interseccion con otros filtros. La vista previa muestra individualmente los precios, margenes y productos sin costo, lista o impuestos validos.
- Tras la confirmacion, cada producto genera su propia propuesta y se actualiza/verifica en secuencia mediante las rutas existentes. Un error detiene el lote; los pendientes no se envian y los cambios ya verificados no se revierten. Los resultados inciertos requieren **Verificar sin escribir** antes de continuar; no se repite un PUT a ciegas. Se puede detener despues del producto actual.
- La revalidacion consulta el producto por UUID y relee compras, impuestos y listas, sin descargar el catalogo completo por producto. El adaptador comparte un presupuesto de hasta 100 solicitudes por minuto, incluida la autenticacion, conforme al [limite de Siigo](https://developers.siigo.com/docs/siigoapi/codigos-de-estado-http/). Un lote grande puede esperar al siguiente minuto; los PUT nunca se reintentan automaticamente.
- La alerta **margen menor al 20%** se calcula antes de redondear el porcentaje, en la lista y filtros actuales y antes de paginar. Exactamente 20% no alerta; un margen faltante no equivale a cero. El filtro **Solo margenes menores al 20%** permite revisar todos esos productos. La alerta es ambar; el margen negativo conserva indicacion de perdida en el liquidador.
- No se requiere una nueva migracion SQL para estos modos o portafolios: propuestas e historial conservan los parametros y resultados en las columnas JSON existentes.

Para probar la migracion sin Supabase ni precios reales, `node --test test/editorSql.integration.js` usa exclusivamente `QF_TEST_DATABASE_URL` de una base local aislada llamada `quirofano_test`. Tambien admite `QF_TEST_PGLITE_ROOT` apuntando a una instalacion local de PGlite, en cuyo caso ejecuta todo en memoria. Nunca usa credenciales de produccion.

## Analitica de facturas y liquidador inteligente (solo consulta)

Componentes y API anteriores conservados para compatibilidad, pero sin entradas en la navegacion actual. El flujo de liquidacion vigente esta integrado en **Liquidar / Historial** y usa el ultimo costo, no el costo conservador de estos simuladores. La siguiente descripcion corresponde a su comportamiento anterior y pruebas aisladas:

1. Abrir **Analitica de facturas**. Se consultan compras y facturas de venta reales (`GET /v1/invoices`), sin mostrar datos de clientes.
2. Desplegar **Confirmar IVA de las facturas de compra** e indicar por factura si el precio unitario ingresado incluye IVA. Si Siigo informa el dato, prevalece y no se puede sustituir. Las confirmaciones se mantienen solo en el estado de la pantalla; no se guardan en la base ni en el servidor, y se pierden al recargar.
3. La tabla muestra costo ingresado ponderado, costo neto, precio final efectivamente facturado, venta neta, ganancia unitaria/total estimada y margen sobre venta neta. El precio de catalogo NO sustituye a la venta facturada.
4. El costo de cada venta es el ultimo **dia anterior** de compra confirmado, ponderado por cantidades. Una compra mas reciente sin confirmar bloquea el uso de un costo viejo. Compras del mismo dia solo generan advertencia: no se conoce el orden de los movimientos y nunca se utilizan para calcular una venta de ese dia.
5. Si faltan costos, IVA, totales o tributos soportados, el renglon queda con motivo visible. Los agregados de utilidad/margen incluyen exclusivamente renglones comparables y muestran cobertura; nunca asumen costo cero.
6. **Simular precio** abre el **Liquidador inteligente** para ese producto. Tambien se puede abrir desde el menu y buscar otro producto.

### Formulas y limites financieros

- Venta final: `items[].total / quantity`, ya descontada segun la factura.
- Venta neta: `(items[].total - suma del IVA facturado) / quantity`. No se vuelve a restar el descuento de venta. Un tributo desconocido o sin valor bloquea el renglon.
- Costo neto: precio de compra menos descuentos de renglon, separando el IVA cuando corresponde mediante el normalizador existente.
- **Retefuente en compras**: se identifica por el tipo `Retefuente` del catalogo, no por un ID fijo. Es una retencion del pago, no un descuento comercial ni IVA; no reduce el costo y no se suma a la tasa de IVA. La factura y las ventas costeadas muestran una advertencia explicativa. Verificado en la cuenta con el ID `3271` (`Retefuente 2.5%`). Los tributos desconocidos y otros tipos aun no soportados siguen bloqueados; no se omiten para hacer funcionar una prueba.
- Ganancia estimada: venta neta menos costo neto; margen: ganancia / venta neta. **No es utilidad contable/FIFO ni dinero cobrado**.
- No se descuentan notas credito, retenciones, gastos operativos ni movimientos de inventario no consultados. Las facturas explicitamente anuladas/rechazadas y las fechas futuras quedan excluidas con aviso.
- Solo COP: documentos con divisa explicita distinta de COP no se convierten; si no viene moneda explicita se usa la moneda local COP de esta integracion.
- Si en el mismo dia hay compras con IVA incluido y excluido, se compara solo su costo neto, no se presenta un promedio bruto enganoso.
- Limite adicional: 1.000 facturas de venta y 5.000 renglones de venta. Se falla explicitamente si se supera, sin aparentar cobertura completa.

### Reglas del sugerido

Se muestra la tendencia por dia, ultimo costo, promedio ponderado historico, variacion frente al dia de compra anterior y precio medio realmente facturado. El costo de referencia es `max(ultimo costo confirmado, promedio historico ponderado)`, mas el adicional unitario ingresado. Para simular se deben resolver todas las compras pendientes del producto: no se calcula un promedio incompleto silenciosamente.

El liquidador lista exclusivamente productos activos con costo positivo confirmado, ventas reales con precio neto medio positivo, impuestos soportados y precio valido en la lista seleccionada. La misma validacion controla el acceso desde la analitica y el calculo compartido. Al entrar sin un producto enviado, carga el primer producto apto como ejemplo. La tabla permite comparar costos, precios facturados y margen de referencia, y elegir **Calcular margen**. Ese margen compara el precio neto medio facturado con el costo actual de referencia (sin adicionales), no representa el margen historico de cada venta. Si no hay productos aptos, muestra el motivo general y dirige a confirmar IVA; no inventa ejemplos.

Para probar sin confirmar facturas, usar **Ver ejemplo generico (datos ficticios)**. Abre un contexto separado con `DEMO-001`: costo neto 7.000, IVA 19%, venta final 11.900, venta neta 10.000, utilidad 3.000 y margen 30%. Se pueden variar margen, utilidad fija o precio final y volver despues a productos reales. No agrega productos al catalogo, no envia confirmaciones ni escribe datos; no mezcla la muestra con las ventas de la empresa.

Objetivos:

- **Margen porcentual sobre venta neta**: `costo / (1 - margen/100)`; luego IVA y redondeo hacia arriba.
- **Ganancia fija por unidad**: `costo + ganancia`; luego IVA y redondeo hacia arriba.
- **Precio final fijo con IVA**: respeta exactamente el precio indicado, sin redondearlo, y muestra ganancia y margen resultantes, incluso si hay perdida.

Son reglas explicables de proteccion de costos, no predicciones de demanda ni garantia de ventas futuras. No aplican cambios en Siigo ni generan borradores.

La API `POST /api/quirofano/invoice-analytics` requiere la misma sesion/permisos y acepta `{ taxConfirmations: { "<uuid_compra>": true | false } }`. Es un calculo sin persistencia; no habilita otras escrituras. La funcion pura de simulacion se comparte con el frontend.

## Modo persistente: alcance y limites

Las siguientes secciones describen el modo persistente, que requiere `QUIROFANO_READ_ONLY=false` y `SUPABASE_SERVICE_ROLE_KEY` privada en el backend. **No son requisitos para el modo de consultas anterior.**

- Liquidador individual y masivo: margen sobre venta neta, incremento sobre costo o utilidad fija; costo adicional unitario, descuentos y redondeos.
- Borradores y auditoria transaccional en Supabase. Guardar no cambia Siigo.
- Aprobacion explicita, lectura de precios/impuestos antes del PUT y verificacion posterior. Conserva otras listas y monedas.
- Solo COP, productos/servicios simples e IVA porcentual. Combos, impuesto al consumo, otros tributos o configuraciones incompletas quedan bloqueados con una explicacion.
- Los precios mostrados incluyen IVA; si el producto de Siigo lo excluye, el adaptador convierte el valor sin cambiar `tax_included`.
- El margen excluye IVA descontable. Los descuentos de venta se simulan/compensan en el precio de lista; **no se crean promociones ni descuentos en Siigo**.
- La API de productos no documenta costo de compra: se usa el ultimo dia de compras vinculadas, ponderado por cantidades, o un costo neto manual confirmado y auditado. No se inventan costos cero.
- Analisis por fecha, producto, proveedor, lista y objetivo; costo anterior, promedio historico ponderado, variacion, impacto estimado en margen, anomalias y recomendacion hacia el liquidador.
- Facturas existentes vinculadas por UUID, consulta horaria, reemplazo atomico sin duplicados y consolidado diario persistente. **No se crean compras ni se ingresa mercancia**.
- **Descubrimiento automatico de todas las compras pendiente**: la referencia oficial consultada documenta `GET /v1/purchases/{id}`, no un listado general. Se implemento el flujo por IDs confirmado por el solicitante. El tablero indica cobertura parcial; no debe interpretarse como el total comprado por la empresa.
- Facturas en divisas, proveedor por item, descuentos desconocidos e impuestos no soportados requieren revision. La confirmacion de IVA al vincular se usa solo si la respuesta de Siigo omite `tax_included`.
- Historicos, recomendaciones y consolidados solo reflejan documentos vinculados. Cambios/borrados que no pueden consultarse conservan los datos anteriores **con error visible**, nunca desaparecen silenciosamente.

## Instalacion local

Desde esta carpeta:

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

Completar `.env` localmente (no pegar claves en chats ni subir el archivo):

| Variable | Uso |
|---|---|
| `SUPABASE_URL` | Proyecto actual de la intranet |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave privada del backend; valida usuario, consulta permisos y opera tablas protegidas |
| `SIIGO_USERNAME` / `SIIGO_ACCESS_KEY` | Credenciales API de Siigo |
| `SIIGO_PARTNER_ID` | Partner-Id obligatorio en peticiones Siigo |
| `SIIGO_WRITES_ENABLED` | `false` inicialmente; habilitar conscientemente tras probar consultas |
| `CRON_SECRET` | Secreto aleatorio largo exclusivo del cron |
| `QUIROFANO_ALLOWED_ORIGINS` | Origenes exactos separados por comas |
| `PORT` | `3030` por defecto |

El modo persistente no necesita `SUPABASE_ANON_KEY`; el modo consulta si la necesita, junto al JWT del usuario. No hay modo de autenticacion `off` o `report`. Las credenciales Siigo y la clave `service_role` van exclusivamente en este backend, nunca en variables `VITE_*`.

Aplicar **una vez, con revision previa**, [sql/001_quirofano.sql](sql/001_quirofano.sql) en el SQL Editor del mismo Supabase. La migracion es repetible, agrega exclusivamente objetos `quirofano_*` y no modifica las tablas existentes. Activa RLS, revoca acceso de `anon`/`authenticated` y reserva tablas y funciones a `service_role`. No aplicar el SQL de pruebas a Supabase.

En la administracion de usuarios de la intranet, asignar `/quirofano` al perfil o rol correspondiente. La entrada ya esta en el catalogo del frontend. Las rutas personales reemplazan las del rol, como en Fruver; ser administrador no concede acceso implicito.

En la raiz del **frontend**:

```powershell
npm run dev
```

Vite redirige `/api-quirofano` a `http://127.0.0.1:3030/api`. Para otro servidor:

```powershell
$env:QUIROFANO_API_PROXY="http://127.0.0.1:3030"
npm run dev
```

Abrir `/quirofano` con un usuario autorizado. `GET http://127.0.0.1:3030/api/salud` funciona incluso antes de configurar credenciales; **salud no confirma conexion a Supabase ni Siigo**. Las pantallas muestran fallos reales de configuracion.

En una tercera terminal, para sincronizacion horaria local:

```powershell
npm run cron:local
```

El programador local ejecuta una revision al arrancar y luego cada hora. Necesita el servidor local activo y el mismo `CRON_SECRET`. No depende de que una pantalla permanezca abierta.

## Despliegue independiente en Vercel

1. Publicar **solo esta carpeta** como repositorio backend, o elegirla como Root Directory del proyecto Vercel.
2. Node 22 o superior; entrada Express `app.js`. No se necesita un build del frontend ni `dist`.
3. Configurar las variables privadas anteriores en Vercel. Mantener escrituras deshabilitadas inicialmente.
4. Asignar tiempo suficiente a las funciones (al menos 180 segundos para sincronizacion; confirmar limites del plan). No extender los tiempos sin revisar tambien el bloqueo de sincronizacion de cinco minutos.
5. El cron de [vercel.json](vercel.json) llama `GET /api/cron/compras` cada hora UTC. Vercel envia `Authorization: Bearer <CRON_SECRET>`. **El plan debe permitir cron horario**; Hobby puede restringirlo a frecuencia diaria. Como alternativa, un programador externo de confianza puede invocar esa misma ruta con el secreto sin ponerlo en la URL.
6. Configurar `QUIROFANO_ALLOWED_ORIGINS` con el dominio real del frontend.
7. En el entorno del frontend configurar `VITE_QUIROFANO_API_URL=https://TU-PROYECTO.vercel.app/api` antes de su siguiente build/deploy habitual. Esta variable es publica y solo contiene la URL, nunca una clave.
8. `https://*.vercel.app` ya esta cubierto por el CSP Report-Only. Si se usa un dominio personalizado, agregarlo a `connect-src` en `public/.htaccess` e inventario de `docs/CSP_MIGRATION_GUIDE.md`. Siigo se consulta solo desde servidor y no necesita permiso CSP del navegador.

La sincronizacion de productos es paginada (50 por peticion) y el frontend continua automaticamente. Se puede pausar entre paginas; ante error continua desde la pagina fallida mientras se conserve esa vista. Salir y volver reinicia el recorrido, de forma idempotente. Una sincronizacion parcial no equivale a una lectura completa del catalogo. Los productos eliminados que dejen de aparecer no se desactivan por ausencia de una pagina: la aprobacion siempre vuelve a consultar Siigo y rechaza productos desaparecidos/cambiados.

Las compras se revisan de las mas atrasadas a las mas recientes, en lotes y con presupuesto de 90 segundos para iniciar trabajo. Una consulta en curso puede terminar despues. Si queda cola, la respuesta devuelve `hasMore`; se puede continuar manualmente o en la proxima ejecucion. Los errores se reintentan en una hora sin bloquear los demas documentos. No garantiza revisar un volumen ilimitado en cada hora.

El consolidado usa la fecha del comprobante; el dia actual se calcula en `America/Bogota`. Compara contra el ultimo **dia anterior** de compra y promedio previo ponderado. No inventa secuencia entre facturas del mismo dia. Los graficos de margen usan precios **actuales**, no ventas historicas. Solo se muestra costo unitario agregado cuando el filtro corresponde a un unico producto.

## Flujo de aprobacion y recuperacion

1. Sincronizar productos/listas/impuestos.
2. Seleccionar lista, productos y costos; guardar borradores.
3. Historial: seleccionar hasta diez y confirmar. El navegador manda una escritura por solicitud, en secuencia.
4. El servidor reclama el borrador y un bloqueo **persistente por producto**, valido para todas sus listas.
5. Si costo, precio o impuestos cambiaron desde el borrador: `conflict`, sin escritura. Sincronizar y crear otro.
6. Ante PUT fallido, timeout o lectura posterior diferente: `review`. No se reintenta PUT automaticamente ni se libera el producto.
7. Tras dos minutos, usar **Verificar sin escribir**. Si todos los precios coinciden con lo aprobado se marca `applied`, actualiza la copia local y libera el bloqueo. `applying` interrumpido tambien se recupera con esta accion.
8. Si no coincide, intervencion administrativa: comprobar el documento y listas directamente en Siigo, confirmar que no hay solicitud en curso y decidir si hubo cambio externo o rechazo. Solo un administrador de base de datos puede cerrar el incidente auditadamente con `quirofano_finish_price(id, actor_uuid, 'conflict', motivo)`. Nunca borrar bloqueos ni modificar estados a mano para repetir una escritura incierta.

Los cambios externos simultaneos en Siigo no se pueden volver atomicos con Supabase: no se presupone soporte de `ETag`/`If-Match` no documentado. Se compara inmediatamente antes y despues, se conserva el historial y cualquier discrepancia queda para revision.

La API requiere JWT Supabase en `Authorization` para todo `/api/quirofano/*`, consulta `profiles.user_id` y `role_permissions`, y siempre comprueba `/quirofano`. CORS no reemplaza esta autorizacion. Salud no expone secretos; el cron tiene autenticacion independiente. Tokens Siigo viven solo en memoria de servidor, se renuevan al vencer y se comparten entre lecturas concurrentes de una instancia. Solo los GET reintentan 401/429 de manera acotada.

## API

Base `/api/quirofano`, respuesta `{ ok: true, data }`; fallos HTTP con `{ ok: false, error }`.

| Metodo / ruta | Operacion |
|---|---|
| `GET /meta` | Estado configurado, bandera de escrituras y catalogos guardados |
| `GET /products` | Busqueda/paginacion por `search`, `category`, `position`, `page`, `target` |
| `POST /sync/products` | Sincroniza una pagina; cuerpo `{ page }`, devuelve `nextPage` |
| `POST /liquidations` | Lista y hasta 100 items; recalculo autoritativo en servidor |
| `GET /liquidations?page=1` | Historial paginado |
| `POST /liquidations/approve` | `{ ids: [uuid] }`, exactamente un borrador por solicitud |
| `POST /liquidations/:id/verify` | Reconciliacion de solo lectura contra Siigo |
| `GET /liquidations/:id/events` | Eventos de auditoria |
| `POST /purchases/sources` | `{ id: uuid, taxIncluded: boolean }`; vincula factura existente |
| `POST /sync/purchases` | Consulta fuentes vencidas; nunca escribe compras en Siigo |
| `GET /analysis` | `from`, `to`, `search`, `supplier`, `position`, `target`, `threshold` |

Limites iniciales explicitos: consultas internas paginadas hasta 50.000 registros; analisis hasta 32 dias inclusivos y 5.000 renglones resultantes. Al superarlos falla explicitamente, no entrega totales truncados. Para volumen superior migrar agregaciones/consulta al servidor SQL antes de ampliar estos limites.

## Referencia Siigo verificada

Consultada el 2026-11-17 desde [documentacion oficial Colombia](https://developers.siigo.com/docs/siigoapi/), enlazada por [el portal de Siigo](https://siigonube.portaldeclientes.siigo.com/informacion-siigo-api/).

Operaciones usadas: `POST /auth`, `GET /v1/products`, `GET /v1/products/{id}`, `PUT /v1/products/{id}`, `GET /v1/price-lists`, `GET /v1/taxes`, `GET /v1/purchases/{id}`.

Detalles que condicionan el adaptador:

- GET devuelve `account_group.id`; PUT recibe `account_group` numerico.
- Precios anidados en `prices[].currency_code` y `price_list[].position/value`; la seleccion usa **position**, no el ID del catalogo.
- GET devuelve `unit.code`; PUT recibe `unit` como codigo.
- Compra: `items[].price`, `quantity`, `discount.value/percentage`, `taxes[].id` y `supplier.identification`.
- No se presupone que compras exponga `tax_included` ni nombre comercial del proveedor en todas las cuentas.

Falta validar con una cuenta real: credenciales/Partner-Id, acceso habilitado a productos y compras, configuracion tributaria concreta, permisos de modificacion, comportamiento del PUT y posibilidad documentada de descubrir facturas automaticamente. No habilitar escrituras sin una prueba controlada con un producto/lista acordados.

## Pruebas

### 1. Preparar credenciales y tablas

Requisitos: Node >=22, acceso al SQL Editor del Supabase de la intranet, credenciales API/Partner-Id de Siigo y un usuario de la intranet autorizado para `/quirofano`.

1. Copiar `.env.example` a `.env` **solo si no existe**, completar las variables indicadas y mantener `SIIGO_WRITES_ENABLED=false`. No sobrescribir un `.env` ya configurado.
2. Ejecutar completo [sql/001_quirofano.sql](sql/001_quirofano.sql) en Supabase. Se crean 10 tablas, sus indices y 7 funciones con prefijo `quirofano_` dentro del esquema `public`. No hay que exponer un esquema adicional.
3. La migracion es para una instalacion nueva; no renombra ni copia tablas antiguas `qf_*`. Si ya existen con datos, detenerse y preparar una migracion antes de cambiar el backend.
4. Asignar `/quirofano` mediante la administracion de permisos existente. No cambiar las politicas RLS ni dar permisos directos al navegador para hacer las pruebas.
5. Tener a mano: codigo de un producto simple activo en COP, lista activa, costo neto conocido y, para compras, el **UUID de una factura existente** y su tratamiento del IVA. El numero visible del comprobante no reemplaza el UUID.

Validar los objetos desde el SQL Editor (debe devolver 10 filas):

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and left(tablename, 10) = 'quirofano_'
order by tablename;
```

Tablas: `quirofano_products`, `quirofano_catalogs`, `quirofano_liquidations`, `quirofano_price_events`, `quirofano_product_locks`, `quirofano_purchase_sources`, `quirofano_purchase_invoices`, `quirofano_purchase_lines`, `quirofano_daily_summary`, `quirofano_sync_locks`. Todas deben tener `rowsecurity=true`.

### 2. Pruebas automaticas sin servicios externos

Desde esta carpeta:

```powershell
npm test
npm run check
```

Las pruebas usan dobles de Siigo/Supabase y no modifican datos reales, aunque el `.env` este configurado. Incluyen el contrato entre nombres SQL y llamadas del servicio.

### 3. Comprobar conexiones reales sin modificar datos

Con el `.env` completo y el SQL instalado:

```powershell
npm run test:connection
```

No necesita el servidor HTTP activo. Consulta las 10 tablas y autentica contra Siigo para leer impuestos, listas y la primera pagina de productos. No imprime claves, tokens ni contenido de productos. No hace PUT, no sincroniza ni guarda datos; fuerza el adaptador Siigo a solo lectura, incluso si la bandera del entorno estuviera activada. Un fallo termina con codigo de salida distinto de cero.

Esta comprobacion **no valida** permisos de un usuario de la intranet, ejecucion de RPC, acceso a una factura concreta ni permisos de escritura en Siigo. Las siguientes pruebas cubren esas etapas.

### 4. Iniciar y probar la intranet

Terminal backend (desde esta carpeta):

```powershell
npm start
```

Otra terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3030/api/salud
```

Esperado: `ok=true`, `service=quirofano`. En la raiz del frontend ejecutar `npm run dev`, abrir la URL local que muestre Vite e ingresar a `/quirofano`. Si Vite usa otro puerto distinto de 5173, agregar su origen exacto a `QUIROFANO_ALLOWED_ORIGINS` y reiniciar el backend.

| Prueba | Accion | Resultado esperado |
|---|---|---|
| Permisos | Ingresar con usuario autorizado; probar API sin sesion y con usuario sin permiso | Acceso autorizado; API responde 401 sin sesion o 403 sin permiso |
| Estado seguro | Abrir modulo | Indica **Escrituras protegidas** |
| Catalogo | Pulsar **Sincronizar Siigo**, esperar todas las paginas | Productos, impuestos y listas en Supabase; sin cambios en Siigo |
| Busqueda | Buscar el codigo conocido y elegir su lista | Codigo, nombre, IVA y precio coinciden con Siigo |
| Calculo | Seleccionar producto; usar costo manual neto conocido | Previsualizacion coherente; sin costo no se inventa cero |
| Borrador | Guardar y abrir historial/eventos | Estado `draft`, evento `created`; precio real en Siigo sin cambios |
| Proteccion | Revisar aprobacion con bandera en `false` | Aprobacion no disponible en UI; una solicitud directa tampoco ejecuta PUT |
| Compras | En analisis, vincular UUID de factura y confirmar IVA; sincronizar | Factura y renglones persistidos; no se crea una compra en Siigo |
| Analisis | Filtrar por fecha real de la factura y su codigo | Costos/cantidades/proveedor coinciden; cobertura parcial visible |
| Repeticion | Intentar vincular de nuevo la misma factura | Rechazo explicito, sin duplicados |

Ejemplo verificable de calculo: costo neto manual `7000`, IVA `19%`, margen sobre venta neta `30%`, adicionales y descuentos `0`, redondeo hacia arriba a `100`: venta neta `10000`, precio final con IVA `11900`. Usar un producto con ese IVA; no asumir que todos lo tienen.

Volver a sincronizar una compra no debe duplicar renglones. Una factura recien revisada no se vuelve a consultar hasta que venza su siguiente revision (una hora); una respuesta sin trabajo no prueba una segunda consulta a Siigo.

Para comprobar la persistencia del borrador y la auditoria desde el SQL Editor:

```sql
select id, product_code, status, previous_value, proposed_value, created_at
from public.quirofano_liquidations order by created_at desc limit 10;

select liquidation_id, event, created_at
from public.quirofano_price_events order by created_at desc limit 20;
```

El cron es opcional en esta etapa: primero sincronizar manualmente. Despues generar un `CRON_SECRET` aleatorio privado, reiniciar backend y ejecutar `npm run cron:local` en otra terminal. Ejecuta una revision al arrancar y luego cada hora; solo lee Siigo y actualiza Supabase.

### 5. Escritura real controlada (solo despues de validar lo anterior)

**No es una simulacion ni un sandbox**: el adaptador usa `https://api.siigo.com`. Acordar un producto y una lista de prueba, registrar todos sus precios originales y confirmar que no afecta una operacion comercial.

1. Cambiar `SIIGO_WRITES_ENABLED=true` en el backend y reiniciarlo. Recargar la pantalla para actualizar el estado de escrituras.
2. Crear un borrador nuevo con los datos actuales. Aprobar **solo uno** y comprobar estado `applied`, eventos y precio directamente en Siigo. Las otras listas/monedas deben seguir iguales.
3. Si queda `review` o `applying`, no repetir la aprobacion ni borrar bloqueos: esperar al menos dos minutos y usar **Verificar sin escribir**; seguir el procedimiento de recuperacion de esta guia.
4. Restaurar el precio acordado mediante un cambio controlado y verificado. No borrar auditoria ni restaurar estados con SQL.
5. Volver a `SIIGO_WRITES_ENABLED=false`, reiniciar el backend y recargar la pantalla al terminar.

### Integracion SQL aislada (opcional, requiere PostgreSQL local)

Integracion SQL real, **exclusivamente en una base local vacia** llamada `quirofano_test`:

```powershell
$env:QF_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55439/quirofano_test"
npm run test:db
```

La prueba instala roles de prueba y migracion, verifica repetibilidad, RLS/grants, reemplazo atomico, rollback, consolidacion y bloqueos persistentes. Se niega a ejecutar contra servidores remotos. Preparar/eliminar ese cluster local fuera del Supabase de la empresa. Crear antes la base vacia y usar un usuario local con permisos de crear roles/tablas; ajustar puerto y autenticacion al cluster local.

### Pruebas del frontend

Desde la raiz del frontend:

```powershell
npx vitest run src/pages/Quirofano/components/Quirofano.test.jsx src/config/autorizacionRutas.test.js
npx eslint src/pages/Quirofano vite.config.js eslint.config.js --max-warnings 0
```

No ejecutar un build global para estas pruebas.
