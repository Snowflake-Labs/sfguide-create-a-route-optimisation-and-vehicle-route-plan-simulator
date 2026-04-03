const MAX_ENTRIES = 500;
const buffer = [];
const startTime = Date.now();
export function log(level, tag, message, extra) {
    const entry = { ts: new Date().toISOString(), level, tag, message, ...extra };
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES)
        buffer.shift();
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn(`[${tag}] ${message}${extra?.detail ? ' | ' + JSON.stringify(extra.detail).slice(0, 300) : ''}`);
}
export function getEntries(filter) {
    let entries = [...buffer];
    if (filter?.level)
        entries = entries.filter(e => e.level === filter.level);
    if (filter?.tag)
        entries = entries.filter(e => e.tag === filter.tag);
    if (filter?.jobId)
        entries = entries.filter(e => e.jobId === filter.jobId);
    if (filter?.since) {
        const s = filter.since;
        entries = entries.filter(e => e.ts >= s);
    }
    return entries.slice(-(filter?.limit || 200));
}
export function clearEntries() {
    buffer.length = 0;
}
export function getUptimeMs() {
    return Date.now() - startTime;
}
