import { describe, expect, it, vi } from 'vitest';
import { approximatePhotoCity } from '../src/photo-city';
import { PHOTO_CITIES } from '../src/photo-city-data';

describe('offline city-level photo location', () => {
  it('replaces capture GPS with fixed nearby city points and honest labels', () => {
    expect(approximatePhotoCity({ latitude: 31.123456, longitude: 121.654321 })).toEqual({ latitude: 31.218398, longitude: 121.434559, label: '上海附近' });
    expect(approximatePhotoCity({ latitude: 32.05, longitude: 118.8 })).toEqual({ latitude: 32.051965, longitude: 118.778029, label: '南京附近' });
    expect(approximatePhotoCity({ latitude: 31.82, longitude: 117.227 })).toEqual({ latitude: 31.851977, longitude: 117.278068, label: '合肥附近' });
  });

  it('gives nearby photos the same city coordinate without copying private metadata', () => {
    const first = { latitude: 32.05, longitude: 118.8, cameraSerial: 'private' };
    const result = approximatePhotoCity(first)!;
    expect(result).toEqual(approximatePhotoCity({ latitude: 32.08, longitude: 118.79 }));
    expect(Object.keys(result).sort()).toEqual(['label', 'latitude', 'longitude']);
    expect(result.latitude).not.toBe(first.latitude);
    expect(result.longitude).not.toBe(first.longitude);
    result.latitude = 0;
    expect(approximatePhotoCity(first)?.latitude).toBe(32.051965);
  });

  it('does not invent a city for open ocean, polar regions or invalid GPS', () => {
    for (const gps of [
      { latitude: 0, longitude: -140 }, { latitude: 0, longitude: 0 },
      { latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 },
      { latitude: NaN, longitude: 1 }, { latitude: Infinity, longitude: 1 },
      { latitude: 91, longitude: 1 }, { latitude: 1, longitude: -181 },
      { latitude: '31', longitude: 121 }, null,
    ]) expect(approximatePhotoCity(gps as { latitude: number; longitude: number })).toBeUndefined();
  });

  it('enforces the distance cutoff around an isolated island city', () => {
    // Funafuti's fixed point; these synthetic positions are 74 and 76 km north.
    const center = PHOTO_CITIES.find(city => city[2] === '富纳富提')!;
    const latitudeFor = (km: number) => center[0] + km / 6371.0088 * 180 / Math.PI;
    expect(approximatePhotoCity({ latitude: latitudeFor(74), longitude: center[1] })?.label).toBe('富纳富提附近');
    expect(approximatePhotoCity({ latitude: latitudeFor(76), longitude: center[1] })).toBeUndefined();
    // +180 and -180 describe the same meridian, outside this city's 75 km radius.
    expect(approximatePhotoCity({ latitude: center[0], longitude: 180 })).toEqual(approximatePhotoCity({ latitude: center[0], longitude: -180 }));
  });

  it('agrees with an independent full-scan spherical reference near sampled world cities', () => {
    // A vector chord reference guards latitude/longitude pruning, not just fixtures.
    const radians = Math.PI / 180;
    const vector = (lat: number, lon: number) => [Math.cos(lat * radians) * Math.cos(lon * radians), Math.cos(lat * radians) * Math.sin(lon * radians), Math.sin(lat * radians)];
    const maximum = (2 * Math.sin(75 / 6371.0088 / 2)) ** 2;
    for (let i = 0; i < PHOTO_CITIES.length; i += 97) {
      const city = PHOTO_CITIES[i]!, gps = { latitude: city[0] + 0.2, longitude: city[1] > 179.5 ? city[1] - 0.3 : city[1] + 0.3 };
      const origin = vector(gps.latitude, gps.longitude);
      let closest: typeof city | undefined, best = maximum;
      for (const candidate of PHOTO_CITIES) {
        const point = vector(candidate[0], candidate[1]);
        const distance = point.reduce((sum, value, axis) => sum + (value - origin[axis]!) ** 2, 0);
        if (distance < best) { best = distance; closest = candidate; }
      }
      expect(approximatePhotoCity(gps)).toEqual(closest ? { latitude: closest[0], longitude: closest[1], label: `${closest[2]}附近` } : undefined);
    }
  });

  it('bounds expensive candidate calculations for a 100-photo publishing batch', () => {
    const sine = vi.spyOn(Math, 'sin');
    try {
      for (let index = 0; index < 100; index++) approximatePhotoCity({ latitude: 31.1 + index / 1000, longitude: 121.6 });
      expect(sine.mock.calls.length).toBeLessThan(5000);
    } finally { sine.mockRestore(); }
  });
});
