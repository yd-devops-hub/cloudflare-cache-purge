const core = require('@actions/core');

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

const maskId = (id) => `****${id.slice(-4)}`;

/**
 * Walks hostname parts from most-specific to least-specific (e.g.
 * sub.example.com → example.com) until a matching active Cloudflare zone
 * is found. Returns the zone ID, or throws if none is found.
 */
async function resolveZoneId(apiToken, hostname, cache) {
  if (cache.has(hostname)) return cache.get(hostname);

  const parts = hostname.split('.');

  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = parts.slice(i).join('.');

    if (cache.has(candidate)) {
      const zoneId = cache.get(candidate);
      cache.set(hostname, zoneId);
      return zoneId;
    }

    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/zones?name=${encodeURIComponent(candidate)}&status=active`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const data = await response.json();

    if (!data.success) {
      const errors = (data.errors ?? []).map((e) => `[${e.code}] ${e.message}`).join('; ');
      throw new Error(`Cloudflare zones lookup failed for "${candidate}": ${errors}`);
    }

    if (data.result.length > 0) {
      const zoneId = data.result[0].id;
      core.info(`  Resolved zone for "${candidate}": ${maskId(zoneId)}`);
      cache.set(candidate, zoneId);
      cache.set(hostname, zoneId);
      return zoneId;
    }
  }

  throw new Error(`No active Cloudflare zone found for hostname: ${hostname}`);
}

async function run() {
  try {
    const apiToken = core.getInput('cloudflare-api-token', { required: true });
    const purgeUrlsInput = core.getInput('purge-urls', { required: true });

    let purgeUrls;
    try {
      purgeUrls = JSON.parse(purgeUrlsInput);
    } catch (err) {
      core.setFailed(`Failed to parse purge-urls as JSON: ${err.message}`);
      return;
    }

    if (!Array.isArray(purgeUrls) || purgeUrls.length === 0) {
      core.setFailed('purge-urls must be a non-empty JSON array of URL strings');
      return;
    }

    // Group URLs by zone ID (one API call per unique hostname, cached).
    core.info('Resolving Cloudflare zones from URLs...');
    const zoneCache = new Map();
    const urlsByZone = new Map();

    for (const url of purgeUrls) {
      let hostname;
      try {
        hostname = new URL(url).hostname;
      } catch {
        core.setFailed(`Invalid URL: ${url}`);
        return;
      }

      const zoneId = await resolveZoneId(apiToken, hostname, zoneCache);

      if (!urlsByZone.has(zoneId)) urlsByZone.set(zoneId, []);
      urlsByZone.get(zoneId).push(url);
    }

    // Purge each zone's URLs in a single API call.
    const purgeIds = [];

    for (const [zoneId, urls] of urlsByZone) {
      core.info(`Purging ${urls.length} URL(s) from zone ${maskId(zoneId)}:`);
      urls.forEach((u) => core.info(`  - ${u}`));

      const response = await fetch(
        `${CLOUDFLARE_API_BASE}/zones/${zoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: urls }),
        }
      );

      const data = await response.json();

      if (!data.success) {
        const errors = (data.errors ?? []).map((e) => `[${e.code}] ${e.message}`).join('; ');
        core.setFailed(`Cache purge failed for zone ${zoneId}: ${errors || 'unknown error'}`);
        return;
      }

      const purgeId = data.result?.id ?? '';
      core.info(`  Purge successful! Purge ID: ${purgeId}`);
      purgeIds.push(purgeId);
    }

    core.setOutput('purge-ids', JSON.stringify(purgeIds));
  } catch (err) {
    core.setFailed(`Unexpected error: ${err.message}`);
  }
}

run();
