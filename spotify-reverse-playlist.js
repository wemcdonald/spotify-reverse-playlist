#!/usr/bin/env node

/**
 * spotify-reverse-playlist
 * 
 * A CLI tool that takes a source playlist ID and a destination playlist ID,
 * then ensures the destination playlist contains the same tracks as the source
 * but in reverse order.
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

// Load environment variables
dotenv.config();

// Constants
const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const TRACKS_PER_REQUEST = 100; // Spotify API limit for tracks per request
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:8888/callback';
const SCOPES = 'playlist-read-private playlist-modify-private playlist-modify-public';
const TOKEN_PATH = path.join(__dirname, '.spotify-token.json');

// CLI setup
program
  .name('spotify-reverse-playlist')
  .description('Reverses a Spotify playlist into another playlist')
  .version('1.0.0')
  .argument('<sourcePlaylistId>', 'ID of the source playlist')
  .argument('<destPlaylistId>', 'ID of the destination playlist')
  .option('--refresh', 'Force refresh of the access token')
  .option('--debug', 'Show debug information')
  .parse(process.argv);

const [sourcePlaylistId, destPlaylistId] = program.args;
const options = program.opts();

/**
 * Open URL in the default browser
 */
function openBrowser(url) {
  let command;
  switch (process.platform) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
      break;
  }

  exec(command, (error) => {
    if (error) {
      console.log('Could not open browser automatically. Please open this URL manually:');
      console.log(url);
    }
  });
}

// Main function
async function main() {
  try {
    console.log(`Starting playlist reversal process...`);
    console.log(`Source playlist: ${sourcePlaylistId}`);
    console.log(`Destination playlist: ${destPlaylistId}`);

    // Validate inputs
    if (!sourcePlaylistId || !destPlaylistId) {
      throw new Error('Both source and destination playlist IDs are required');
    }

    if (sourcePlaylistId === destPlaylistId) {
      throw new Error('Source and destination playlists must be different');
    }

    // Check for required environment variables
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in environment variables or .env file');
    }

    if (options.debug) {
      console.log('Debug info:');
      console.log(`- Client ID: ${process.env.SPOTIFY_CLIENT_ID.substring(0, 5)}...`);
      console.log(`- Redirect URI: ${REDIRECT_URI}`);
      console.log(`- Scopes: ${SCOPES}`);
    }

    // Get access token
    const accessToken = await getAccessToken(options.refresh);

    // Verify playlists exist and are accessible
    await verifyPlaylist(accessToken, sourcePlaylistId, 'Source');
    await verifyPlaylist(accessToken, destPlaylistId, 'Destination');

    // Get all tracks from source playlist
    const sourceTracks = await getAllPlaylistTracks(accessToken, sourcePlaylistId);
    console.log(`Retrieved ${sourceTracks.length} tracks from source playlist`);

    // Reverse the tracks
    const reversedTracks = [...sourceTracks].reverse();

    // Update destination playlist
    await updateDestinationPlaylist(accessToken, destPlaylistId, reversedTracks);

    console.log('Playlist reversal completed successfully!');
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
    process.exit(1);
  }
}

/**
 * Get Spotify API access token using Authorization Code flow
 */
async function getAccessToken(forceRefresh = false) {
  try {
    // Check if we have a saved token
    if (fs.existsSync(TOKEN_PATH) && !forceRefresh) {
      const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH));
      
      // Check if token is still valid (with 60 seconds buffer)
      if (tokenData.expires_at && Date.now() < tokenData.expires_at - 60000) {
        console.log('Using existing access token');
        return tokenData.access_token;
      }
      
      // Token expired, try to refresh
      if (tokenData.refresh_token) {
        console.log('Refreshing expired access token...');
        return await refreshAccessToken(tokenData.refresh_token);
      }
    }
    
    // No valid token, start authorization flow
    console.log('Starting authorization flow...');
    return await startAuthFlow();
  } catch (error) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

/**
 * Start the authorization code flow
 */
async function startAuthFlow() {
  return new Promise((resolve, reject) => {
    // Generate a random state value for security
    const state = crypto.randomBytes(16).toString('hex');
    
    // Create the authorization URL
    const authUrl = new URL(SPOTIFY_AUTH_URL);
    authUrl.searchParams.append('client_id', process.env.SPOTIFY_CLIENT_ID);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('scope', SCOPES);
    
    if (options.debug) {
      console.log(`Authorization URL: ${authUrl.toString()}`);
    }
    
    // Create a server to handle the callback
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url, true);
        
        if (options.debug) {
          console.log(`Received callback: ${req.url}`);
        }
        
        if (parsedUrl.pathname === '/callback') {
          // Check state to prevent CSRF attacks
          if (parsedUrl.query.state !== state) {
            throw new Error('State mismatch - possible CSRF attack');
          }
          
          if (parsedUrl.query.error) {
            throw new Error(`Authorization error: ${parsedUrl.query.error}`);
          }
          
          if (!parsedUrl.query.code) {
            throw new Error('No authorization code received');
          }
          
          // Exchange code for access token
          try {
            const tokenResponse = await axios({
              method: 'post',
              url: SPOTIFY_TOKEN_URL,
              params: {
                grant_type: 'authorization_code',
                code: parsedUrl.query.code,
                redirect_uri: REDIRECT_URI,
                client_id: process.env.SPOTIFY_CLIENT_ID,
                client_secret: process.env.SPOTIFY_CLIENT_SECRET
              },
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            });
            
            // Save token data with expiration time
            const tokenData = {
              ...tokenResponse.data,
              expires_at: Date.now() + (tokenResponse.data.expires_in * 1000)
            };
            
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData));
            
            // Send success response to browser
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p></body></html>');
            
            // Close the server and resolve the promise
            server.close();
            console.log('Authentication successful');
            resolve(tokenData.access_token);
          } catch (error) {
            if (options.debug && error.response) {
              console.error('Token exchange error:', error.response.data);
            }
            throw error;
          }
        } else {
          // Handle other routes
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        // Handle errors
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authentication Error</h1><p>${error.message}</p></body></html>`);
        
        server.close();
        reject(error);
      }
    });
    
    // Start the server
    server.listen(8888, () => {
      console.log('Waiting for authentication...');
      console.log('Opening browser for Spotify authorization...');
      
      // Open the browser for the user to authenticate
      openBrowser(authUrl.toString());
    });
    
    // Handle server errors
    server.on('error', (error) => {
      reject(new Error(`Server error: ${error.message}`));
    });
  });
}

/**
 * Refresh an expired access token
 */
async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios({
      method: 'post',
      url: SPOTIFY_TOKEN_URL,
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    // Update saved token data
    const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH));
    const newTokenData = {
      ...response.data,
      refresh_token: response.data.refresh_token || tokenData.refresh_token, // Use new refresh token if provided, otherwise keep the old one
      expires_at: Date.now() + (response.data.expires_in * 1000)
    };
    
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(newTokenData));
    
    console.log('Token refreshed successfully');
    return newTokenData.access_token;
  } catch (error) {
    throw new Error(`Failed to refresh token: ${error.message}`);
  }
}

/**
 * Verify that a playlist exists and is accessible
 */
async function verifyPlaylist(accessToken, playlistId, playlistType) {
  try {
    console.log(`Verifying ${playlistType.toLowerCase()} playlist (${playlistId})...`);
    
    await retryOperation(async () => {
      await axios({
        method: 'get',
        url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}`,
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
    });

    console.log(`${playlistType} playlist verified`);
  } catch (error) {
    throw new Error(`${playlistType} playlist verification failed: ${error.message}`);
  }
}

/**
 * Get all tracks from a playlist with pagination
 */
async function getAllPlaylistTracks(accessToken, playlistId) {
  try {
    console.log('Fetching all tracks from source playlist...');
    
    let allTracks = [];
    let offset = 0;
    let hasMoreTracks = true;

    while (hasMoreTracks) {
      const response = await retryOperation(async () => {
        return await axios({
          method: 'get',
          url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
          headers: {
            'Authorization': `Bearer ${accessToken}`
          },
          params: {
            offset: offset,
            limit: TRACKS_PER_REQUEST,
            fields: 'items(track(uri)),next'
          }
        });
      });

      const tracks = response.data.items
        .filter(item => item.track) // Filter out null tracks
        .map(item => item.track.uri);
      
      allTracks = [...allTracks, ...tracks];
      
      if (response.data.next) {
        offset += TRACKS_PER_REQUEST;
        console.log(`Retrieved ${allTracks.length} tracks so far...`);
      } else {
        hasMoreTracks = false;
      }
    }

    // Filter out any potentially invalid URIs
    const validTracks = allTracks.filter(isValidSpotifyURI);
    
    if (validTracks.length < allTracks.length) {
      console.log(`Filtered out ${allTracks.length - validTracks.length} invalid track URIs`);
    }

    return validTracks;
  } catch (error) {
    throw new Error(`Failed to fetch tracks: ${error.message}`);
  }
}

/**
 * Check if a string is a valid Spotify URI
 */
function isValidSpotifyURI(uri) {
  // Basic validation for Spotify URIs
  if (!uri || typeof uri !== 'string') {
    return false;
  }
  
  // Check if it's a valid Spotify URI format (spotify:type:id)
  const spotifyUriPattern = /^spotify:(track|episode):[a-zA-Z0-9]{22}$/;
  return spotifyUriPattern.test(uri);
}

/**
 * Update destination playlist with reversed tracks
 */
async function updateDestinationPlaylist(accessToken, playlistId, tracks) {
  try {
    console.log('Updating destination playlist...');

    // First, clear the destination playlist
    await retryOperation(async () => {
      await axios({
        method: 'put',
        url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          uris: []
        }
      });
    });

    console.log('Destination playlist cleared');

    // Add tracks in batches
    for (let i = 0; i < tracks.length; i += TRACKS_PER_REQUEST) {
      const trackBatch = tracks.slice(i, i + TRACKS_PER_REQUEST);
      
      if (options.debug) {
        console.log(`Adding batch of ${trackBatch.length} tracks (${i} to ${i + trackBatch.length - 1})`);
        if (trackBatch.length > 0) {
          console.log(`First track in batch: ${trackBatch[0]}`);
          console.log(`Last track in batch: ${trackBatch[trackBatch.length - 1]}`);
        }
      }
      
      try {
        await retryOperation(async () => {
          await axios({
            method: 'post',
            url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            data: {
              uris: trackBatch
            }
          });
        });
        
        console.log(`Added ${i + trackBatch.length} of ${tracks.length} tracks to destination playlist`);
      } catch (error) {
        if (options.debug && error.response) {
          console.error('Error adding tracks:', error.response.data);
        }
        
        // If we get a 400 error, try adding tracks one by one to identify problematic tracks
        if (error.response && error.response.status === 400 && trackBatch.length > 1) {
          console.log('Encountered an error. Trying to add tracks one by one...');
          
          for (let j = 0; j < trackBatch.length; j++) {
            try {
              await retryOperation(async () => {
                await axios({
                  method: 'post',
                  url: `${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`,
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                  },
                  data: {
                    uris: [trackBatch[j]]
                  }
                });
              });
              
              if (options.debug) {
                console.log(`Successfully added track: ${trackBatch[j]}`);
              }
            } catch (singleTrackError) {
              console.error(`Failed to add track ${trackBatch[j]}: ${singleTrackError.message}`);
              if (options.debug && singleTrackError.response) {
                console.error('Error details:', singleTrackError.response.data);
              }
            }
          }
          
          console.log(`Processed ${i + trackBatch.length} of ${tracks.length} tracks (some may have failed)`);
        } else {
          throw error;
        }
      }
    }

    console.log('Destination playlist update completed');
  } catch (error) {
    throw new Error(`Failed to update destination playlist: ${error.message}`);
  }
}

/**
 * Retry an operation with exponential backoff
 */
async function retryOperation(operation) {
  let retries = 0;
  let lastError;

  while (retries < MAX_RETRIES) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Check if error is recoverable
      if (error.response) {
        const status = error.response.status;
        
        // If rate limited or server error, retry
        if (status === 429 || (status >= 500 && status < 600)) {
          const retryAfter = error.response.headers['retry-after'] 
            ? parseInt(error.response.headers['retry-after']) * 1000 
            : RETRY_DELAY_MS * Math.pow(2, retries);
          
          console.log(`Rate limited or server error. Retrying in ${retryAfter/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          retries++;
          continue;
        }
      }
      
      // For other errors, don't retry
      throw error;
    }
  }

  throw new Error(`Operation failed after ${MAX_RETRIES} retries: ${lastError.message}`);
}

// Run the program
main(); 