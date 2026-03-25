export function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function lognormalSample(medianMin, sigma, maxMin, rng) {
    const mu = Math.log(medianMin);
    const u1 = rng();
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    const val = Math.exp(mu + sigma * z);
    return Math.min(Math.max(val, 0.5), maxMin);
}
export function calculateHeading(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const la1 = lat1 * Math.PI / 180;
    const la2 = lat2 * Math.PI / 180;
    const x = Math.sin(dLng) * Math.cos(la2);
    const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
}
export function addGpsJitter(lat, lng, jitterM, rng) {
    const angle = rng() * 2 * Math.PI;
    const dist = jitterM * rng() / 111320;
    return [lat + dist * Math.cos(angle), lng + dist * Math.sin(angle) / Math.cos(lat * Math.PI / 180)];
}
export function createRng(seed) {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
    };
}
export function rngInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}
export function rngFloat(rng, min, max) {
    return min + rng() * (max - min);
}
export function uuid(rng) {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23)
            s += '-';
        else if (i === 14)
            s += '4';
        else if (i === 19)
            s += hex[(Math.floor(rng() * 4) + 8)];
        else
            s += hex[Math.floor(rng() * 16)];
    }
    return s;
}
