#!/usr/bin/env node

/**
 * spotify-reverse-playlist
 *
 * Ensures a destination playlist contains the same tracks as a source playlist
 * in reverse order. Designed to run unattended on an hourly cron, so it is built
 * to be SOLID:
 *
 *   - Non-destructive: it never leaves the destination empty. It replaces the
 *     first batch atomically (PUT) then appends the rest, so a mid-run failure
 *     leaves a correct prefix, not an empty playlist.
 *   - Idempotent: if the destination already matches, it makes zero writes.
 *   - Resilient: every API call retries transient failures (429/5xx/network/
 *     timeout) with exponential backoff + jitter, honors Retry-After, and
 *     refreshes the token once on a 401.
 *   - Quiet by default: transient failures self-heal on the next run and exit 0
 *     (no cron email). Only genuinely actionable problems (bad credentials,
 *     deleted playlist, revoked token) alert, and at most once per 24h.
 */

const axios = require('axios');
const dotenv = require('dotenv');
const { program } = require('commander');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------
function loadEnvConfig() {
  const configLocations = [
    path.join(__dirname, '.env'),
    path.join(os.homedir(), '.config', 'spotify-reverse-playlist', '.env'),
  ];
  for (const configPath of configLocations) {
    if (fs.existsSync(configPath)) {
      dotenv.config({ path: configPath });
      console.log(`Loaded configuration from ${configPath}`);
      return;
    }
  }
  console.log('No .env file found. Using environment variables if available.');
}
loadEnvConfig();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const TRACKS_PER_REQUEST = 100; // Spotify hard limit per tracks request
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:8888/callback';
const SCOPES = 'playlist-read-private playlist-modify-private playlist-modify-public';

// Retry / resilience tuning
const MAX_RETRIES = 6;             // 7 attempts total per request
const BASE_DELAY_MS = 1000;        // first backoff
const MAX_DELAY_MS = 30000;        // backoff cap
const REQUEST_TIMEOUT_MS = 30000;  // per-request socket timeout

// Anti-spam: how long to suppress repeat alerts for the same failure, and how
// many consecutive transient failures to tolerate before surfacing one alert.
const ALERT_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_ESCALATE_AFTER = 4;

// ---------------------------------------------------------------------------
// Token + state storage
// ---------------------------------------------------------------------------
const getTokenPath = () => {
  if (process.env.SPOTIFY_TOKEN_PATH) return process.env.SPOTIFY_TOKEN_PATH;
  const scriptDirPath = path.join(__dirname, '.spotify-token.json');
  try {
    fs.accessSync(path.dirname(scriptDirPath), fs.constants.W_OK);
    return scriptDirPath;
  } catch (error) {
    const userConfigDir = path.join(os.homedir(), '.config', 'spotify-reverse-playlist');
    try { fs.mkdirSync(userConfigDir, { recursive: true }); } catch (_) { /* ignore */ }
    return path.join(userConfigDir, '.spotify-token.json');
  }
};
const TOKEN_PATH = getTokenPath();
const STATE_PATH = path.join(path.dirname(TOKEN_PATH), '.spotify-sync-state.json');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
program
  .name('spotify-reverse-playlist')
  .description('Reverses a Spotify playlist into another playlist')
  .version('2.0.0')
  .argument('<sourcePlaylistId>', 'ID of the source playlist')
  .argument('<destPlaylistId>', 'ID of the destination playlist')
  .option('--refresh', 'Force refresh of the access token')
  .option('--dry-run', 'Report what would change without modifying the playlist')
  .option('--debug', 'Show debug information')
  .parse(process.argv);

const [sourcePlaylistId, destPlaylistId] = program.args;
const options = program.opts();

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
// PERMANENT = needs a human (bad config, revoked token, deleted playlist).
// TRANSIENT = should succeed on retry / next run (network, 429, 5xx).
class AppError extends Error {
  constructor(message, permanent) {
    super(message);
    this.permanent = permanent;
  }
}
const permanent = (msg) => new AppError(msg, true);
const transient = (msg) => new AppError(msg, false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network-level errors (no HTTP response) that are worth retrying.
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'ECONNABORTED', 'ERR_NETWORK', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

function isRetryable(error) {
  if (error.response) {
    const s = error.response.status;
    return s === 429 || s === 408 || (s >= 500 && s < 600);
  }
  // No response => connection/timeout error.
  return RETRYABLE_NET_CODES.has(error.code) || /socket hang up|timeout/i.test(error.message || '');
}

function backoffDelay(attempt, error) {
  // Honor Retry-After (seconds) when the server provides it.
  const ra = error.response && error.response.headers && error.response.headers['retry-after'];
  if (ra && !Number.isNaN(parseInt(ra, 10))) {
    return Math.min(parseInt(ra, 10) * 1000 + 250, MAX_DELAY_MS + 5000);
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * 1000); // full-ish jitter
}

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------
let accessToken = null;

function readToken() {
  return JSON.parse(fs.readFileSync(TOKEN_PATH));
}

async function refreshAccessToken(refreshToken) {
  let response;
  try {
    response = await axios({
      method: 'post',
      url: SPOTIFY_TOKEN_URL,
      timeout: REQUEST_TIMEOUT_MS,
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (error) {
    // invalid_grant / 400 => the refresh token is revoked or invalid: a human
    // must re-authenticate. Network/5xx => transient.
    const status = error.response && error.response.status;
    const body = error.response && error.response.data;
    const invalidGrant = body && body.error === 'invalid_grant';
    if (invalidGrant || status === 400 || status === 401) {
      throw permanent('Spotify refresh token is invalid/revoked — re-authenticate by running this script manually once.');
    }
    if (isRetryable(error)) throw transient(`Token refresh failed (transient): ${error.message}`);
    throw permanent(`Token refresh failed: ${error.message}`);
  }

  const prev = fs.existsSync(TOKEN_PATH) ? readToken() : {};
  const tokenData = {
    ...response.data,
    refresh_token: response.data.refresh_token || prev.refresh_token,
    expires_at: Date.now() + response.data.expires_in * 1000,
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData));
  console.log('Token refreshed successfully');
  return tokenData.access_token;
}

async function getAccessToken(forceRefresh = false) {
  if (fs.existsSync(TOKEN_PATH) && !forceRefresh) {
    let tokenData;
    try { tokenData = readToken(); } catch (_) { tokenData = null; }
    if (tokenData) {
      if (tokenData.expires_at && Date.now() < tokenData.expires_at - 60000) {
        console.log('Using existing access token');
        return tokenData.access_token;
      }
      if (tokenData.refresh_token) {
        console.log('Refreshing expired access token...');
        return await refreshAccessToken(tokenData.refresh_token);
      }
    }
  }
  if (forceRefresh && fs.existsSync(TOKEN_PATH)) {
    const tokenData = readToken();
    if (tokenData.refresh_token) {
      console.log('Force-refreshing access token...');
      return await refreshAccessToken(tokenData.refresh_token);
    }
  }

  // No usable token: interactive auth is the only path. Never do this under
  // cron (it would hang waiting for a browser callback).
  if (!process.stdout.isTTY) {
    throw permanent('No valid Spotify token and no TTY — run this script manually once to authenticate.');
  }
  console.log('Starting authorization flow...');
  return await startAuthFlow();
}

// ---------------------------------------------------------------------------
// Interactive auth (manual first-time setup only)
// ---------------------------------------------------------------------------
function openBrowser(u) {
  const command = process.platform === 'darwin' ? `open "${u}"`
    : process.platform === 'win32' ? `start "${u}"` : `xdg-open "${u}"`;
  exec(command, (error) => {
    if (error) { console.log('Open this URL manually:'); console.log(u); }
  });
}

async function startAuthFlow() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = new URL(SPOTIFY_AUTH_URL);
    authUrl.searchParams.append('client_id', process.env.SPOTIFY_CLIENT_ID);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('scope', SCOPES);

    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url, true);
        if (parsedUrl.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        if (parsedUrl.query.state !== state) throw new Error('State mismatch - possible CSRF attack');
        if (parsedUrl.query.error) throw new Error(`Authorization error: ${parsedUrl.query.error}`);
        if (!parsedUrl.query.code) throw new Error('No authorization code received');

        const tokenResponse = await axios({
          method: 'post', url: SPOTIFY_TOKEN_URL, timeout: REQUEST_TIMEOUT_MS,
          params: {
            grant_type: 'authorization_code', code: parsedUrl.query.code,
            redirect_uri: REDIRECT_URI, client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
          },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = { ...tokenResponse.data, expires_at: Date.now() + tokenResponse.data.expires_in * 1000 };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
        server.close();
        console.log('Authentication successful');
        resolve(tokenData.access_token);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authentication Error</h1><p>${error.message}</p></body></html>`);
        server.close();
        reject(error);
      }
    });
    server.listen(8888, () => {
      console.log('Waiting for authentication... opening browser.');
      openBrowser(authUrl.toString());
    });
    server.on('error', (error) => reject(new Error(`Server error: ${error.message}`)));
  });
}

// ---------------------------------------------------------------------------
// Core resilient request helper
// ---------------------------------------------------------------------------
// Applies auth, timeout, retries (429/5xx/network), Retry-After, and a single
// token refresh on 401. Throws a classified AppError on give-up.
async function apiRequest(config, { label = 'request' } = {}) {
  let refreshedOn401 = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios({
        ...config,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { ...(config.headers || {}), Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      const status = error.response && error.response.status;

      // Token expired mid-run: refresh once, then retry immediately.
      if (status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        try {
          const td = readToken();
          if (td.refresh_token) { accessToken = await refreshAccessToken(td.refresh_token); continue; }
        } catch (e) {
          if (e instanceof AppError && e.permanent) throw e;
        }
        throw permanent(`Unauthorized (${label}) and token could not be refreshed.`);
      }

      if (isRetryable(error) && attempt < MAX_RETRIES) {
        const delay = backoffDelay(attempt, error);
        console.log(`${label}: transient error (${status || error.code || error.message}); retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }

      if (isRetryable(error)) {
        throw transient(`${label} failed after ${MAX_RETRIES + 1} attempts: ${status || error.code || error.message}`);
      }
      // Non-retryable HTTP error (4xx other than 429/408): permanent.
      const detail = error.response && error.response.data ? JSON.stringify(error.response.data).slice(0, 200) : error.message;
      throw permanent(`${label} failed (${status || 'no status'}): ${detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Playlist operations
// ---------------------------------------------------------------------------
function isValidSpotifyURI(uri) {
  return typeof uri === 'string' && /^spotify:(track|episode):[a-zA-Z0-9]{22}$/.test(uri);
}

async function verifyPlaylist(playlistId, playlistType) {
  console.log(`Verifying ${playlistType.toLowerCase()} playlist (${playlistId})...`);
  try {
    await apiRequest(
      { method: 'get', url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}`, params: { fields: 'id' } },
      { label: `${playlistType} playlist verify` },
    );
  } catch (error) {
    if (error instanceof AppError && error.permanent && /\(404\)/.test(error.message)) {
      throw permanent(`${playlistType} playlist ${playlistId} not found (deleted or no access).`);
    }
    throw error;
  }
  console.log(`${playlistType} playlist verified`);
}

async function getAllPlaylistTracks(playlistId, label) {
  console.log(`Fetching all tracks from ${label} playlist...`);
  let all = [];
  let offset = 0;
  for (;;) {
    const response = await apiRequest(
      {
        method: 'get',
        url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
        params: { offset, limit: TRACKS_PER_REQUEST, fields: 'items(track(uri)),next' },
      },
      { label: `${label} tracks (offset ${offset})` },
    );
    const uris = response.data.items.filter((i) => i.track).map((i) => i.track.uri);
    all = all.concat(uris);
    if (response.data.next) { offset += TRACKS_PER_REQUEST; console.log(`Retrieved ${all.length} tracks so far...`); }
    else break;
  }
  const valid = all.filter(isValidSpotifyURI);
  if (valid.length < all.length) console.log(`Filtered out ${all.length - valid.length} invalid track URIs`);
  return valid;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Set the destination playlist to exactly `tracks`, in order, non-destructively.
// PUT replaces the first batch atomically (so the playlist is never emptied),
// then POST appends the remainder. A failure mid-append leaves a correct prefix.
async function setDestinationTracks(playlistId, tracks) {
  const first = tracks.slice(0, TRACKS_PER_REQUEST);
  await apiRequest(
    {
      method: 'put',
      url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
      headers: { 'Content-Type': 'application/json' },
      data: { uris: first },
    },
    { label: 'replace first batch' },
  );
  console.log(`Set first ${first.length} of ${tracks.length} tracks`);

  for (let i = TRACKS_PER_REQUEST; i < tracks.length; i += TRACKS_PER_REQUEST) {
    const batch = tracks.slice(i, i + TRACKS_PER_REQUEST);
    try {
      await apiRequest(
        {
          method: 'post',
          url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
          headers: { 'Content-Type': 'application/json' },
          data: { uris: batch },
        },
        { label: `append batch @${i}` },
      );
    } catch (error) {
      // A single bad/unavailable URI can 400 a whole batch. Fall back to adding
      // one at a time so one bad track doesn't sink the run.
      if (error instanceof AppError && error.permanent && /\(400\)/.test(error.message) && batch.length > 1) {
        console.log(`Batch @${i} rejected; adding individually and skipping bad tracks...`);
        for (const uri of batch) {
          try {
            await apiRequest(
              {
                method: 'post',
                url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
                headers: { 'Content-Type': 'application/json' },
                data: { uris: [uri] },
              },
              { label: `append single ${uri}` },
            );
          } catch (e) {
            console.warn(`Skipped track ${uri}: ${e.message}`);
          }
        }
      } else {
        throw error;
      }
    }
    console.log(`Set ${Math.min(i + batch.length, tracks.length)} of ${tracks.length} tracks`);
  }
}

// ---------------------------------------------------------------------------
// Failure state (anti-spam)
// ---------------------------------------------------------------------------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH)); }
  catch (_) { return { consecutiveFailures: 0, lastAlertAt: 0 }; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (_) { /* fail open */ }
}
function recordSuccess() {
  writeState({ consecutiveFailures: 0, lastAlertAt: 0 });
}

// Decide whether to surface a failure (exit 1 => cron email) or stay quiet
// (exit 0 => self-heals next run). Permanent errors alert once per debounce
// window; transient errors only after several consecutive failures.
function handleFailure(error) {
  const isPermanent = error instanceof AppError ? error.permanent : true;
  const state = readState();
  const now = Date.now();
  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;

  const debounced = now - (state.lastAlertAt || 0) < ALERT_DEBOUNCE_MS;
  const escalate = isPermanent || state.consecutiveFailures >= TRANSIENT_ESCALATE_AFTER;
  const shouldAlert = escalate && !debounced;

  if (shouldAlert) state.lastAlertAt = now;
  writeState(state);

  const kind = isPermanent ? 'PERMANENT' : 'transient';
  if (shouldAlert) {
    console.error(`ERROR (${kind}): ${error.message}`);
    process.exit(1); // -> cron email (once per ${ALERT_DEBOUNCE_MS}ms)
  } else {
    console.warn(`WARN (${kind}, suppressed — will self-heal or already alerted): ${error.message}`);
    process.exit(0); // -> no email
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  try {
    console.log('Starting playlist reversal process...');
    console.log(`Source playlist: ${sourcePlaylistId}`);
    console.log(`Destination playlist: ${destPlaylistId}`);
    console.log(`Using token storage: ${TOKEN_PATH}`);

    if (!sourcePlaylistId || !destPlaylistId) throw permanent('Both source and destination playlist IDs are required');
    if (sourcePlaylistId === destPlaylistId) throw permanent('Source and destination playlists must be different');
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      throw permanent('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set (env or .env)');
    }

    accessToken = await getAccessToken(options.refresh);

    await verifyPlaylist(sourcePlaylistId, 'Source');
    await verifyPlaylist(destPlaylistId, 'Destination');

    const sourceTracks = await getAllPlaylistTracks(sourcePlaylistId, 'source');
    console.log(`Retrieved ${sourceTracks.length} tracks from source playlist`);
    const reversed = [...sourceTracks].reverse();

    // Idempotency: skip all writes if the destination already matches.
    const destTracks = await getAllPlaylistTracks(destPlaylistId, 'destination');
    if (arraysEqual(destTracks, reversed)) {
      console.log('Destination already in sync — no changes needed.');
      recordSuccess();
      return;
    }

    if (options.dryRun) {
      console.log(`[dry-run] Would set destination to ${reversed.length} tracks (currently ${destTracks.length}).`);
      recordSuccess();
      return;
    }

    await setDestinationTracks(destPlaylistId, reversed);
    console.log('Playlist reversal completed successfully!');
    recordSuccess();
  } catch (error) {
    handleFailure(error);
  }
}

main();
