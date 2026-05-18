import { latLngToCell, cellToLatLng, gridDisk } from 'h3-js';

// Resolution 8 ≈ 460m edge / ~0.7km² area. Núñez (~3km²) → ~15-20 cells before
// the auto-merge pass consolidates them down to 3-5 super-cells with ~150
// listings each. Coarser than the original res-9 we used to run (which left
// us with 140 tiny cells in Núñez, half of them with <3 listings).
export const H3_RES = 8;

export function computeSubZone(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return latLngToCell(lat, lng, H3_RES);
}

export function subZoneCenter(cellId) {
  if (!cellId) return null;
  try {
    const [lat, lng] = cellToLatLng(cellId);
    return { lat, lng };
  } catch {
    return null;
  }
}

// Hexes adjacent to `cellId` at the given ring (1 = 6 immediate neighbors,
// 2 = 18 neighbors out to two-hex distance). Used by auto-merge (ring 1 first,
// ring 2 fallback) and by rent-match's "expanded subzone" tier.
export function neighborCells(cellId, ring = 1) {
  try {
    return gridDisk(cellId, ring).filter((c) => c !== cellId);
  } catch {
    return [];
  }
}
