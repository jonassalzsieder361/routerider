"use client";

import { useEffect } from "react";
import { MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
import type { LatLngBoundsExpression, LatLngTuple } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MatchedSegment } from "@/lib/mapMatching";

interface RouteMapProps {
  points: { lat: number; lon: number }[];
  matchedSegments?: MatchedSegment[];
}

const SEGMENT_COLORS: Record<MatchedSegment["status"], string> = {
  matched: "#16a34a",
  ambiguous: "#f59e0b",
  unmatched: "#71717a",
};

function FitBounds({ bounds }: { bounds: LatLngBoundsExpression }) {
  const map = useMap();

  useEffect(() => {
    map.fitBounds(bounds, { padding: [24, 24] });
  }, [map, bounds]);

  return null;
}

export function RouteMap({ points, matchedSegments }: RouteMapProps) {
  const positions: LatLngTuple[] = points.map((p) => [p.lat, p.lon]);
  const bounds: LatLngBoundsExpression = positions;

  return (
    // Shorter on phones so there's always page area outside the map to scroll with — one-finger
    // drags that start on the map pan it (Leaflet), drags elsewhere scroll the page.
    <div className="h-60 w-full overflow-hidden sm:h-80 rounded-xl border border-zinc-200 dark:border-zinc-800">
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
        {matchedSegments ? (
          matchedSegments.map((segment, i) => (
            <Polyline
              key={i}
              positions={[
                [segment.start.lat, segment.start.lon],
                [segment.end.lat, segment.end.lon],
              ]}
              pathOptions={{ color: SEGMENT_COLORS[segment.status], weight: 5 }}
            />
          ))
        ) : (
          <Polyline positions={positions} pathOptions={{ color: "#dc2626", weight: 4 }} />
        )}
        <FitBounds bounds={bounds} />
      </MapContainer>
    </div>
  );
}
