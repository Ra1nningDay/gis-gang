CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE bus_stops (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  geom GEOMETRY(Point, 4326)
);

INSERT INTO bus_stops (name, geom) VALUES
('BU Main Campus Gate', ST_SetSRID(ST_MakePoint(100.6169, 14.0392), 4326)),
('BU Library', ST_SetSRID(ST_MakePoint(100.6178, 14.0401), 4326)),
('BU Tram Stop A', ST_SetSRID(ST_MakePoint(100.6185, 14.0388), 4326));

CREATE INDEX bus_stops_geom_idx
ON bus_stops
USING GIST (geom);
