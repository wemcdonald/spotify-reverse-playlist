# Spotify Reverse Playlist

A command-line tool that takes a source Spotify playlist and creates a reversed version in a destination playlist.

This solves the problem of (e.g.) dealing with cars with a terrible Spotify implementation that doesn't support reverse-chronological playlists.

## Prerequisites

- Node.js (v12 or higher)
- npm
- Spotify Developer account and API credentials

## Installation

1. Clone this repository or download the script
2. Install dependencies:

```bash
npm install
```

3. Make the script executable:

```bash
chmod +x spotify-reverse-playlist.js
```

4. Create a `.env` file with your Spotify API credentials:

```bash
cp .env.example .env
```

Then edit the `.env` file and add your Spotify Client ID and Client Secret.

## Getting Spotify API Credentials

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Log in with your Spotify account
3. Create a new application
4. Copy the Client ID and Client Secret to your `.env` file
5. Add `http://localhost:8888/callback` as a Redirect URI in your Spotify app settings (or your custom redirect URI if you've configured one)

## Configuration

The following environment variables can be set in the `.env` file:

- `SPOTIFY_CLIENT_ID` - Your Spotify application's client ID (required)
- `SPOTIFY_CLIENT_SECRET` - Your Spotify application's client secret (required)
- `SPOTIFY_REDIRECT_URI` - Custom redirect URI for authentication (optional, defaults to `http://localhost:8888/callback`)
- `SPOTIFY_TOKEN_PATH` - Custom path for storing the authentication token (optional)

If you change the redirect URI, make sure to add it to your Spotify app settings in the Developer Dashboard.

### Configuration File Locations

The script will look for the `.env` file in the following locations (in order):

1. The script's directory
2. `~/.config/spotify-reverse-playlist/`

This makes it easy to run the script from cron jobs or other scheduled tasks.

### Token Storage

The authentication token is stored in a JSON file. The location is determined as follows:

1. If `SPOTIFY_TOKEN_PATH` is set in the environment or `.env` file, that location is used
2. If the script directory is writable, the token is stored there as `.spotify-token.json`
3. Otherwise, it's stored in `~/.config/spotify-reverse-playlist/.spotify-token.json`

## Usage

```bash
./spotify-reverse-playlist.js <sourcePlaylistId> <destinationPlaylistId>
```

Example:

```bash
./spotify-reverse-playlist.js 37i9dQZF1DXcBWIGoYBM5M 1234567890abcdefghij
```

The first time you run the script, it will open a browser window asking you to authorize the application with your Spotify account. After authorization, the script will save the token locally and reuse it for future runs.

To force a refresh of the token, use the `--refresh` flag:

```bash
./spotify-reverse-playlist.js <sourcePlaylistId> <destinationPlaylistId> --refresh
```

For debugging, use the `--debug` flag:

```bash
./spotify-reverse-playlist.js <sourcePlaylistId> <destinationPlaylistId> --debug
```

### Finding Playlist IDs

Playlist IDs can be found in the Spotify URL:

- Open the playlist in Spotify
- The ID is the string after "playlist/" in the URL
  - Example: `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M` → ID is `37i9dQZF1DXcBWIGoYBM5M`

## Important Notes

- You must have permission to modify both playlists
- The script requires the `playlist-read-private`, `playlist-modify-public`, and `playlist-modify-private` scopes
- For large playlists, the process may take some time due to Spotify API rate limits

## Running as a Scheduled Task

### Using cron (Linux/macOS)

Add a line to your crontab to run the script nightly:

```bash
# Run at 2 AM every day
0 2 * * * /path/to/spotify-reverse-playlist.js <sourcePlaylistId> <destinationPlaylistId> >> /path/to/logfile.log 2>&1
```

For cron jobs, it's recommended to:

1. Use absolute paths to the script
2. Set up the `.env` file in `~/.config/spotify-reverse-playlist/`
3. Run the script manually once to authenticate before setting up the cron job

### Using Task Scheduler (Windows)

1. Open Task Scheduler
2. Create a new Basic Task
3. Set the trigger to run daily
4. Set the action to start a program
5. Enter the path to Node.js as the program and the full path to the script with arguments as the arguments

## Troubleshooting

- **Authentication errors**:

  - Make sure your Client ID and Client Secret are correct
  - Verify that you've added the correct redirect URI in your Spotify app settings
  - Try running with the `--refresh` flag to force a new authentication
  - Delete the token file to start fresh

- **Permission errors**:

  - Ensure you've authorized the app with the correct Spotify account
  - Check that you have permission to modify the destination playlist

- **Rate limiting**:

  - The script includes retry logic, but you may need to run it during off-peak hours for very large playlists

- **Cron job not working**:
  - Check that the script has execute permissions
  - Verify that the `.env` file is in the correct location
  - Make sure the token file exists and is valid
  - Check the cron job's log file for errors

## License

MIT
