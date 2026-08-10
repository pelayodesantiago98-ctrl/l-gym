# L-gym

Rutinas de gimnasio y progreso en el tiempo. En producción en
`l-gym.lepayimio.es`, detrás del inicio de sesión compartido de
[lepayimio](https://lepayimio.es).

Express + SQLite, sin dependencias de cliente: los gráficos son SVG generado a
mano. La configuración del servidor vive en
[lepayimio-infra](https://github.com/pelayodesantiago98-ctrl/lepayimio-infra).

![Progreso](assets/screenshots/progreso.png)

| Entreno del día | Rutinas | Móvil |
|---|---|---|
| ![](assets/screenshots/entreno.png) | ![](assets/screenshots/rutinas.png) | ![](assets/screenshots/movil.png) |

## La idea

Una **rutina** por grupo muscular (pecho y tríceps, espalda y bíceps, pierna…).
Dentro de cada grupo hay dos listas separadas a propósito:

- **Calentamiento** — solo una casilla. No se apunta peso porque no interesa.
- **Ejercicios** — casilla, número de series y **peso por cada serie**.

En el gimnasio eliges el grupo del día y vas marcando. Lo que apuntas se
guarda contra la fecha, y de ahí sale el progreso.

## El peso de la última vez

Al abrir un ejercicio aparecen los pesos que hiciste **el último día que lo
tocaste**, para no tener que acordarte. Eso es una **sugerencia**, no un dato
guardado: viaja en una clave aparte de la respuesta (`ultimaVez`) y no se
escribe en la sesión de hoy hasta que tocas la casilla.

Importa la distinción: si se guardara solo, un día que abres la app y no
entrenas quedaría registrado como un entreno completo con los pesos de la
semana pasada, y el progreso mentiría.

`ultimaVezDe()` solo mira series con `hecho = 1` y de fechas **anteriores** a
la de hoy, así que abrir el mismo día dos veces no se sugiere a sí mismo.

## Datos

```
grupos      un grupo muscular, por dueño
ejercicios  del grupo; tipo = calentamiento | ejercicio; con foto opcional
sesiones    un día + un grupo (única por dueño, fecha y grupo)
marcas      hecho/no hecho de los calentamientos
series      peso y repeticiones de cada serie de cada ejercicio
```

Todo lleva `dueno`, que sale del SSO. Las consultas filtran por él siempre: la
app la usa más de una persona y nadie ve la rutina de otro.

## Inicio de sesión

No tiene login propio. Usa el módulo compartido `sso.js`, que valida la cookie
`lepayimio_sesion` firmada por el portal. `app.use(sso.exigirSesion())` va
**antes** del `express.static`, así que ni los ficheros estáticos se sirven sin
sesión.

> **Ojo al desplegar.** El servicio corre como el usuario `lgym`, que no es
> `www-data`, y la clave de firma `/etc/lepayimio/sso.key` es de root. Hace
> falta darle permiso explícito:
>
> ```bash
> setfacl -m u:lgym:r /etc/lepayimio/sso.key
> ```
>
> Sin eso la app arranca igual y **falla en silencio** al validar la cookie:
> todo el mundo ve la pantalla de login para siempre. Por eso `servidor.js`
> comprueba la clave al arrancar y se niega a seguir si no puede leerla.

## Fotos de los ejercicios

Se suben desde la propia app y se procesan con sharp. Van a
`public/imagenes/`, que **no está en el repositorio**: son contenido de quien
usa la app, no del proyecto.

## Endurecimiento

La unit de systemd va con `ProtectSystem=strict` y solo dos rutas escribibles:
`datos/` y `public/imagenes/`. `MemoryMax=256M` porque el VPS tiene 1,8 GB
repartidos entre nueve servicios.

## Las capturas

`herramientas/demo.sh` levanta **una copia** de la app en `/var/tmp` con una
sesión falsa y ocho semanas de datos inventados, la fotografía y la borra. No
toca la instalación real ni su base de datos.

La copia va en `/var/tmp` y no en `/tmp`: `/tmp` aquí es un tmpfs de 921 MB
sobre 1,8 GB de RAM y no le caben ni las dependencias.

## Licencia

GPL-3.0. Ver [LICENSE](LICENSE).
