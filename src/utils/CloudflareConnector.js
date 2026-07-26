const axios = require('axios');

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeZoneName(value) {
    return String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function normalizeRecordType(value, fallback = 'A') {
    const candidate = String(value || fallback).trim().toUpperCase();
    return candidate || fallback;
}

function normalizeRecordName(name, zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    const raw = String(name || '').trim();
    if (!raw || raw === '@') return normalizedZone;

    const cleaned = raw.toLowerCase().replace(/\.+$/, '');
    if (!normalizedZone) return cleaned;
    if (cleaned === normalizedZone || cleaned.endsWith(`.${normalizedZone}`)) return cleaned;
    return `${cleaned}.${normalizedZone}`;
}

function normalizeTtl(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.trunc(parsed);
}

function resolveApiToken() {
    const token = String(
        process.env.CF_API_TOKEN ||
        process.env.ACCOUNT_API_TOKEN ||
        process.env.AUTH_TOKEN ||
        process.env.ACCOUNT_API_KEY ||
        ''
    ).trim();

    if (!token) {
        throw new Error('Cloudflare API token is missing. Set CF_API_TOKEN or AUTH_TOKEN.');
    }

    return token;
}

async function apiRequest(method, path, { params, data } = {}) {
    const token = resolveApiToken();
    const response = await axios({
        method,
        url: `${CLOUDFLARE_API_BASE_URL}${path}`,
        params,
        data,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    if (!response.data || response.data.success !== true) {
        const details = response.data && response.data.errors
            ? JSON.stringify(response.data.errors)
            : 'Unknown Cloudflare API error';
        throw new Error(details);
    }

    return response.data.result;
}

async function listZones() {
    return apiRequest('GET', '/zones', { params: { per_page: 100 } });
}

async function getZoneByName(zoneName) {
    const normalizedZone = normalizeZoneName(zoneName);
    if (!normalizedZone) {
        throw new Error('Zone name is required.');
    }

    const zones = await apiRequest('GET', '/zones', {
        params: {
            name: normalizedZone,
            per_page: 1
        }
    });

    const zone = Array.isArray(zones) ? zones[0] : null;
    if (!zone) {
        throw new Error(`Cloudflare zone not found or not accessible: ${normalizedZone}`);
    }

    return zone;
}

async function listDnsRecords({ zoneId, zoneName, type, name, perPage = 100 } = {}) {
    let resolvedZoneId = String(zoneId || '').trim();
    if (!resolvedZoneId) {
        const zone = await getZoneByName(zoneName);
        resolvedZoneId = zone.id;
    }

    const params = { per_page: perPage };
    if (type) params.type = normalizeRecordType(type);
    if (name) params.name = normalizeRecordName(name, zoneName);

    return apiRequest('GET', `/zones/${resolvedZoneId}/dns_records`, { params });
}

function buildRecordPayload(record, zoneName) {
    const payload = {
        type: normalizeRecordType(record.type),
        name: normalizeRecordName(record.name, zoneName),
        content: String(record.content || '').trim(),
        ttl: normalizeTtl(record.ttl, 1),
        proxied: parseBool(record.proxied, true)
    };

    if (!payload.content) {
        throw new Error(`DNS record content is required for ${payload.name}`);
    }

    if (record.comment) {
        payload.comment = String(record.comment).trim();
    }

    if (Array.isArray(record.tags) && record.tags.length > 0) {
        payload.tags = record.tags.map((tag) => String(tag || '').trim()).filter(Boolean);
    }

    if (payload.type === 'TXT') {
        delete payload.proxied;
    }

    return payload;
}

function recordMatches(existing, payload) {
    if (!existing) return false;
    if (existing.type !== payload.type) return false;
    if (String(existing.name || '').toLowerCase() !== String(payload.name || '').toLowerCase()) return false;
    return true;
}

function recordNeedsUpdate(existing, payload) {
    if (String(existing.content || '') !== String(payload.content || '')) return true;
    if (Number(existing.ttl || 0) !== Number(payload.ttl || 0)) return true;

    if (payload.type !== 'TXT' && Boolean(existing.proxied) !== Boolean(payload.proxied)) {
        return true;
    }

    if (String(existing.comment || '') !== String(payload.comment || '')) return true;
    return false;
}

async function upsertDnsRecord(record) {
    const zoneName = normalizeZoneName(record.zoneName || record.zone);
    const zoneId = String(record.zoneId || '').trim();
    const zone = zoneId ? { id: zoneId, name: zoneName } : await getZoneByName(zoneName);
    const payload = buildRecordPayload(record, zone.name || zoneName);
    const existingRecords = await listDnsRecords({
        zoneId: zone.id,
        zoneName: zone.name || zoneName,
        type: payload.type,
        name: payload.name,
        perPage: 100
    });

    const existing = (existingRecords || []).find((candidate) => recordMatches(candidate, payload));

    if (!existing) {
        const created = await apiRequest('POST', `/zones/${zone.id}/dns_records`, { data: payload });
        return { action: 'created', zoneId: zone.id, zoneName: zone.name || zoneName, record: created };
    }

    if (!recordNeedsUpdate(existing, payload)) {
        return { action: 'unchanged', zoneId: zone.id, zoneName: zone.name || zoneName, record: existing };
    }

    const updated = await apiRequest('PUT', `/zones/${zone.id}/dns_records/${existing.id}`, {
        data: payload
    });

    return { action: 'updated', zoneId: zone.id, zoneName: zone.name || zoneName, record: updated };
}

async function syncDnsRecords(records = []) {
    const results = [];
    for (const record of records) {
        results.push(await upsertDnsRecord(record));
    }
    return results;
}

async function injectCloudflareGeoRoute(newServerIp, options = {}) {
    const zoneName = options.zoneName || process.env.CF_ZONE_NAME || process.env.CF_PRIMARY_ZONE || 'any.movie';
    const recordName = options.recordName || process.env.CF_RECORD_NAME || zoneName;
    const result = await upsertDnsRecord({
        zoneName,
        type: options.type || 'A',
        name: recordName,
        content: newServerIp,
        ttl: options.ttl || 1,
        proxied: options.proxied !== undefined ? options.proxied : true,
        comment: options.comment || 'Managed by movie-streamer CloudflareConnector'
    });

    console.log(`⚡ [Cloudflare Integration] ${result.action} DNS record ${recordName} -> ${newServerIp}`);
    return result;
}

module.exports = {
    listZones,
    getZoneByName,
    listDnsRecords,
    upsertDnsRecord,
    syncDnsRecords,
    injectCloudflareGeoRoute
};