"use client";

import { useEffect } from "react";
import { MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import type { LatLngBoundsExpression, LatLngTuple } from "leaflet";
import "leaflet/dist/leaflet.css";

interface RouteMapProps {
  points: { lat: number; lon: number }[];
}

function FitBounds({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();

  useEffect(() => {
    map.fitBounds(bounds, { padding: [24, 24] });
  }, [map, bounds]);

  return null;
}

export function RouteMap({ points }: RouteMapProps) {
  const positions: LatLngTuple[] = points.map((p) => [p.lat, p.lon]);
  const bounds: LatLngBoundsExpression = positions;

  return (
    <div className="h-80 w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <MapContainer
        center={positions[0]}
        zoom={13}
        scrollWheelZoom={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline positions={positions} pathOptions={{ color: "#dc2626", weight: 4 }} />
        <FitBounds bounds={bounds} />
      </MapContainer>
    </div>
  );
}
