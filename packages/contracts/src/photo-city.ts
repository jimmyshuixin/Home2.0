import { PHOTO_CITIES } from './photo-city-data';

export interface ApproximatePhotoCity { latitude: number; longitude: number; label: string }

const EARTH_RADIUS_KM = 6371.0088;
const MAX_DISTANCE_KM = 75;
const RADIANS = Math.PI / 180;
const ANGULAR_RADIUS = MAX_DISTANCE_KM / EARTH_RADIUS_KM;
const LATITUDE_MARGIN = ANGULAR_RADIUS / RADIANS;
const MAX_HAVERSINE = Math.sin(ANGULAR_RADIUS / 2) ** 2;

function firstLatitudeAtLeast(latitude: number): number {
  let low = 0, high = PHOTO_CITIES.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (PHOTO_CITIES[middle]![0] < latitude) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Find a nearby significant city without network access or returning capture GPS.
 * Output is the gazetteer's fixed place point, NOT an administrative-area lookup.
 * Natural Earth does not cover every city; points farther than 75 km return nothing.
 * "附近" is deliberate: nearest-city matching does not establish city membership,
 * and cannot promise a minimum anonymity radius in dense neighbouring cities.
 */
export function approximatePhotoCity(gps: { latitude: number; longitude: number }): ApproximatePhotoCity | undefined {
  if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude) || Math.abs(gps.latitude) > 90 || Math.abs(gps.longitude) > 180) return undefined;
  const latitude = gps.latitude * RADIANS, cosineLatitude = Math.cos(latitude);
  const longitudeMargin = Math.abs(gps.latitude) + LATITUDE_MARGIN >= 90
    ? 180 : Math.asin(Math.min(1, Math.sin(ANGULAR_RADIUS) / cosineLatitude)) / RADIANS;
  const endLatitude = gps.latitude + LATITUDE_MARGIN;
  let closest: (typeof PHOTO_CITIES)[number] | undefined, closestDistance = MAX_HAVERSINE;
  // Latitude-sorted data bounds the scan; the longitude box further limits trig.
  for (let index = firstLatitudeAtLeast(gps.latitude - LATITUDE_MARGIN); index < PHOTO_CITIES.length; index++) {
    const city = PHOTO_CITIES[index]!;
    if (city[0] > endLatitude) break;
    const longitudeDelta = Math.min(Math.abs(city[1] - gps.longitude), 360 - Math.abs(city[1] - gps.longitude));
    if (longitudeDelta > longitudeMargin) continue;
    const distance = Math.sin((city[0] - gps.latitude) * RADIANS / 2) ** 2
      + cosineLatitude * Math.cos(city[0] * RADIANS) * Math.sin(longitudeDelta * RADIANS / 2) ** 2;
    if (distance <= closestDistance && (!closest || distance < closestDistance)) { closest = city; closestDistance = distance; }
  }
  // Return a fresh value so callers cannot mutate the shared gazetteer.
  return closest ? { latitude: closest[0], longitude: closest[1], label: `${closest[2]}附近` } : undefined;
}
