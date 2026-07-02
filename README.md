# GIS Gang: GeoServer + PostGIS Lab

โปรเจกต์นี้เป็น lab สำหรับเรียนรู้ GeoServer + PostGIS โดยเฉพาะ ใช้ Docker Compose เพื่อรันบริการหลัก 3 ตัว:

- PostGIS: เก็บข้อมูลพิกัด route, point, polygon และใช้ spatial query
- GeoServer: publish ข้อมูล GIS ออกเป็น WMS/WFS/GeoJSON
- pgAdmin: ดู database และลอง query PostGIS

Next.js app ยังอยู่ในโปรเจกต์ แต่รอบนี้ยังไม่แตะ UI.

## Requirements

- Docker Desktop
- Docker Compose v2 (`docker compose`)

## Start the Lab

```bash
docker compose up -d
```

เปิดใช้งาน:

- GeoServer: <http://localhost:8080/geoserver>
  - Username: `admin`
  - Password: `geoserver`
- pgAdmin: <http://localhost:5050>
  - Email: `admin@example.com`
  - Password: `adminpass`
- PostGIS:
  - Host from your machine: `localhost`
  - Host from another container: `postgis`
  - Port: `5432`
  - Database: `gis`
  - User: `gis`
  - Password: `gispass`

## View the Data in Next.js

The Next.js app renders the published `lab:bus_stops` layer with MapLibre.

Start the app:

```bash
pnpm dev
```

Open <http://localhost:3000>.

The page calls the local proxy endpoint:

```text
http://localhost:3000/api/bus-stops
```

That endpoint forwards to GeoServer WFS and returns GeoJSON to the browser. Click a red bus stop point on the map to see its name.

## Seed Data

PostGIS จะรันไฟล์ใน `init/` ตอนสร้าง volume ครั้งแรก:

- `init/01-sample.sql`

ไฟล์นี้สร้าง:

- PostGIS extension
- table `bus_stops`
- จุดตัวอย่าง 3 จุด
- GiST index บน column `geom`

ถ้าเคยรัน container ไปแล้วและอยาก init database ใหม่:

```bash
docker compose down -v
docker compose up -d
```

คำสั่งนี้ลบ named volumes ของ lab นี้ด้วย ดังนั้นข้อมูลใน PostGIS และ GeoServer data directory จะหาย.

## Connect pgAdmin to PostGIS

ใน pgAdmin ให้เพิ่ม server ใหม่โดยใช้ค่าประมาณนี้:

- Name: `lab-postgis`
- Host name/address: `postgis`
- Port: `5432`
- Maintenance database: `gis`
- Username: `gis`
- Password: `gispass`

ถ้าต่อจากเครื่อง host โดยตรง ให้ใช้ host `localhost` แทน `postgis`.

## Try PostGIS Queries

ดูข้อมูลจุด:

```sql
SELECT name, ST_AsText(geom) FROM bus_stops;
```

ลองหาระยะห่างระหว่างจุด:

```sql
SELECT
  a.name,
  b.name,
  ST_DistanceSphere(a.geom, b.geom) AS distance_meters
FROM bus_stops a
JOIN bus_stops b ON a.id < b.id;
```

## Connect GeoServer to PostGIS

ใน GeoServer:

1. เข้า <http://localhost:8080/geoserver>
2. Login ด้วย `admin` / `geoserver`
3. ไปที่ `Stores`
4. กด `Add new Store`
5. เลือก `PostGIS`
6. ใส่ค่าประมาณนี้:
   - Workspace: สร้างใหม่ เช่น `lab`
   - Data Source Name: `postgis_lab`
   - host: `postgis`
   - port: `5432`
   - database: `gis`
   - schema: `public`
   - user: `gis`
   - passwd: `gispass`
7. กด `Save`
8. Publish layer `bus_stops`

จุดสำคัญคือ GeoServer อยู่ใน container อีกตัว ดังนั้น host ของ database ต้องใช้ชื่อ service ใน Docker network คือ `postgis` ไม่ใช่ `localhost`.

## Preview Layer

หลัง publish layer แล้ว:

1. ไปที่ `Layer Preview`
2. หา layer `bus_stops`
3. เปิดแบบ `OpenLayers`

ควรเห็นจุดตัวอย่างบนแผนที่.

## Fetch GeoJSON from WFS

หลังสร้าง workspace `lab` และ publish layer แล้ว ลองเปิด URL นี้:

```text
http://localhost:8080/geoserver/lab/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=lab:bus_stops&outputFormat=application/json
```

GeoJSON นี้สามารถเอาไปแสดงต่อใน MapLibre หรือ Leaflet ได้.

## Learning Flow

1. เข้าใจ PostGIS ก่อน: query table, ดู WKT, ลองคำนวณระยะทาง
2. Publish layer ผ่าน GeoServer: ต่อ PostGIS store แล้ว publish `bus_stops`
3. ดึงข้อมูลผ่าน WFS เป็น GeoJSON
4. เอา GeoJSON ไปต่อ frontend map เช่น MapLibre + mapcn หรือ Leaflet

ภาพรวม stack:

```text
PostGIS   -> เก็บข้อมูลพิกัด / route / polygon / spatial query
GeoServer -> publish ข้อมูลออกเป็น WMS / WFS / GeoJSON
pgAdmin   -> ดูและลอง query database
Frontend  -> MapLibre / Leaflet สำหรับแสดงผลบนแผนที่
```

## Useful Commands

```bash
docker compose ps
docker compose logs -f postgis
docker compose logs -f geoserver
docker compose logs -f pgadmin
docker compose down
```
