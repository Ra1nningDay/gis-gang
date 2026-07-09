# GIS Gang: GeoServer + PostGIS Lab

A small Docker lab for learning **GeoServer**, **PostGIS**, and basic GIS data publishing.

This project runs:

* **PostGIS** for storing spatial data such as points, routes, and polygons
* **GeoServer** for publishing GIS data as WMS, WFS, and GeoJSON
* **pgAdmin** for viewing the database and testing SQL queries
* **Next.js + MapLibre** for displaying a local GeoTIFF layer from GeoServer WMS

## Requirements

* Docker Desktop
* Docker Compose v2
* Node.js / pnpm

## Start Docker Services

```bash
docker compose up -d
```

Services:

```text
GeoServer: http://localhost:8080/geoserver
Username: admin
Password: geoserver

pgAdmin: http://localhost:5050
Email: admin@example.com
Password: adminpass

PostGIS:
Host from host machine: localhost
Host from Docker containers: postgis
Port: 5432
Database: gis
User: gis
Password: gispass
```

## Start the Next.js App

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

The app shows OpenStreetMap as the base map and overlays the GeoTIFF raster layer from GeoServer using WMS.

The local proxy endpoint is:

```text
http://localhost:3000/api/satellite-wms?bbox=...
```

Use **Zoom to satellite** if the map is outside the GeoTIFF area.
Use the **Satellite** toggle and **Opacity** control to compare the raster with the base map.

The dashed orange box shows the GeoTIFF extent.

## Create NDVI from Red and NIR Bands

The app can create an NDVI GeoTIFF from an existing multispectral GeoTIFF in
`data/`:

1. Start Docker Desktop.
2. Start GeoServer with `docker compose up -d`.
3. Start the app with `pnpm dev`.
4. In the `NDVI` toolbar, select a source GeoTIFF.
5. Set the Red and NIR band numbers for that image.
6. Optional: click `Draw AOI`, draw a polygon on the map, then click `Finish`.
7. Click `Create NDVI`.

The app runs GDAL through Docker, writes the result to `data/derived/`, then
uses the existing `Scan & Publish` flow to publish the new `ndvi_*` layer to
GeoServer. NDVI layers receive a default color ramp style in GeoServer.
When an AOI polygon is drawn, the app crops the NDVI output to that polygon
before publishing it.

NDVI uses:

```text
(NIR - Red) / (NIR + Red)
```

The default inputs are Red band `3` and NIR band `4`, but verify the actual
band order for each source image before processing. The app does not infer the
band mapping from the file name.

## Seed Data

PostGIS runs the SQL files inside the `init/` folder when the database volume is created for the first time.

Current seed file:

```text
init/01-sample.sql
```

It creates:

* PostGIS extension
* `bus_stops` table
* 3 sample bus stop points
* GiST index on the `geom` column

To reset the database and GeoServer data:

```bash
docker compose down -v
docker compose up -d
```

This removes the lab volumes, so all saved data will be deleted.

## Connect pgAdmin to PostGIS

In pgAdmin, add a new server:

```text
Name: lab-postgis
Host: postgis
Port: 5432
Maintenance database: gis
Username: gis
Password: gispass
```

Use `localhost` instead of `postgis` only when connecting directly from your host machine.

## Try PostGIS Queries

View sample points:

```sql
SELECT name, ST_AsText(geom)
FROM bus_stops;
```

Calculate distance between points:

```sql
SELECT
  a.name,
  b.name,
  ST_DistanceSphere(a.geom, b.geom) AS distance_meters
FROM bus_stops a
JOIN bus_stops b ON a.id < b.id;
```

## Connect GeoServer to PostGIS

In GeoServer:

1. Open `http://localhost:8080/geoserver`
2. Login with `admin` / `geoserver`
3. Go to **Stores**
4. Click **Add new Store**
5. Select **PostGIS**
6. Use these values:

```text
Workspace: lab
Data Source Name: postgis_lab
host: postgis
port: 5432
database: gis
schema: public
user: gis
passwd: gispass
```

7. Save
8. Publish the `bus_stops` layer

GeoServer runs inside Docker, so the database host must be `postgis`, not `localhost`.

## Publish Local GeoTIFF as WMS

The local `data/` folder is mounted into GeoServer:

```text
./data -> /data
```

In GeoServer:

1. Go to **Stores**
2. Click **Add new Store**
3. Select **GeoTIFF**
4. Use these values:

```text
Workspace: lab
Data Source Name: satellite_20241012
URL: file:///data/drive-download-20260702T033920Z-3-002/IMG_T2V_20241012033956_ORTHO_PMS_32_2.tif
```

5. Save
6. Publish the layer
7. Set **Declared SRS** to `EPSG:32647`
8. Click **Compute from native bounds**
9. Click **Compute from lat/lon bounds**
10. Save

WMS preview:

```text
http://localhost:8080/geoserver/lab/wms?service=WMS&version=1.1.0&request=GetMap&layers=lab:satellite_20241012&styles=&bbox=100.426870,14.649284,100.454905,14.676227&width=768&height=512&srs=EPSG:4326&format=image/png
```

MapLibre uses this proxy endpoint:

```text
http://localhost:3000/api/satellite-wms?bbox={bbox-epsg-3857}
```

The current CRS assumption is `EPSG:32647`.
If the image appears in the wrong place, fix the SRS in GeoServer first.

## Preview Layer

After publishing the layer:

1. Go to **Layer Preview**
2. Find `bus_stops`
3. Open it with **OpenLayers**

You should see the sample points on the map.

## Fetch GeoJSON from WFS

After publishing `bus_stops`, open:

```text
http://localhost:8080/geoserver/lab/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=lab:bus_stops&outputFormat=application/json
```

This returns GeoJSON that can be used in MapLibre or Leaflet.

## Learning Flow

1. Learn PostGIS basics
2. Query spatial data with SQL
3. Publish PostGIS data through GeoServer
4. Fetch data from WFS as GeoJSON
5. Display the data on a frontend map

## Stack Overview

```text
PostGIS   -> Stores spatial data and runs spatial queries
GeoServer -> Publishes data as WMS, WFS, and GeoJSON
pgAdmin   -> Views and queries the database
Frontend  -> Displays map layers with MapLibre or Leaflet
```

## Useful Commands

```bash
docker compose ps
docker compose logs -f postgis
docker compose logs -f geoserver
docker compose logs -f pgadmin
docker compose down
```
