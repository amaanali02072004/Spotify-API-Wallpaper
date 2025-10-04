// server.js
// Minimal Node server to get Spotify currently playing and serve a small wallpaper page
// Dependencies: express, node-fetch (or built-in fetch if Node >= 18), spotify-web-api-node, cors
// Install: npm init -y
// npm i express spotify-web-api-node cors

import express from "express"
import dotenv from "dotenv"
dotenv.config()
import cors from "cors"
import SpotifyWebApi from "spotify-web-api-node"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = 8888
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "dedc8558315e430ab21b1d76133a8624"
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "dabb7541b5974e649e8ade4b129b6af5"
// const REDIRECT_URI = `http://localhost:${PORT}/callback`
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`

const app = express()
app.use(cors())
app.use(express.static(path.join(__dirname, "public"))) // serve wallpaper html from public/
// serve optional canvas video files from public/canvas at /canvas/
const canvasStatic = path.join(__dirname, 'public', 'canvas')
if (fs.existsSync(canvasStatic)) {
  app.use('/canvas', express.static(canvasStatic))
}

const spotifyApi = new SpotifyWebApi({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
})

// In-memory store for refresh token (for personal use). For production persist it.
let REFRESH_TOKEN = null
let ACCESS_TOKEN_EXPIRES_AT = 0

app.get("/login", (req, res) => {
  const scopes = [
    "user-read-playback-state",
    "user-read-currently-playing",
    "user-modify-playback-state",
    "user-read-private"
  ]
  // allow a return path so the app can redirect back after auth
  const returnTo = req.query.returnTo || '/'
  // encode the returnTo path into state (decoded in /callback)
  const state = encodeURIComponent(returnTo)
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state)
  res.redirect(authorizeURL)
})

app.get("/callback", async (req, res) => {
  const code = req.query.code
  if (!code) return res.status(400).send("Missing code")
  try {
    const data = await spotifyApi.authorizationCodeGrant(code)
    const accessToken = data.body["access_token"]
    const refreshToken = data.body["refresh_token"]
    const expiresIn = data.body["expires_in"] // seconds
    spotifyApi.setAccessToken(accessToken)
    spotifyApi.setRefreshToken(refreshToken)
    REFRESH_TOKEN = refreshToken
    ACCESS_TOKEN_EXPIRES_AT = Date.now() + expiresIn * 1000
    // if state contains a return path, redirect back to it; otherwise go to root
    const rawState = req.query.state || ''
    let redirectTo = '/'
    try {
      const decoded = decodeURIComponent(String(rawState))
      // simple safeguard: only allow internal paths
      if (decoded && decoded.startsWith('/')) redirectTo = decoded
    } catch (e) {
      // ignore and fall back to '/'
    }
    res.redirect(redirectTo)
  } catch (err) {
    console.error("Error exchanging code:", err)
    res.status(500).send("Auth error")
  }
})

app.post("/play", async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded()
    if (!spotifyApi.getAccessToken()) return res.status(401).json({ error: "Not authenticated. Visit /login" })
    await spotifyApi.play()
    res.json({ success: true })
  } catch (err) {
    console.error("play error", err)
    // try to surface Spotify error body if present
    const body = err?.body || err?.message || String(err)
    res.status(500).json({ error: "play failed", details: body })
  }
})

app.post("/pause", async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded()
    if (!spotifyApi.getAccessToken()) return res.status(401).json({ error: "Not authenticated. Visit /login" })
    await spotifyApi.pause()
    res.json({ success: true })
  } catch (err) {
    console.error("pause error", err)
    const body = err?.body || err?.message || String(err)
    res.status(500).json({ error: "pause failed", details: body })
  }
})

app.post("/next", async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded()
    if (!spotifyApi.getAccessToken()) return res.status(401).json({ error: "Not authenticated. Visit /login" })
    await spotifyApi.skipToNext()
    res.json({ success: true })
  } catch (err) {
    console.error("next error", err)
    const body = err?.body || err?.message || String(err)
    res.status(500).json({ error: "next failed", details: body })
  }
})

app.post("/previous", async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded()
    if (!spotifyApi.getAccessToken()) return res.status(401).json({ error: "Not authenticated. Visit /login" })
    await spotifyApi.skipToPrevious()
    res.json({ success: true })
  } catch (err) {
    console.error("previous error", err)
    const body = err?.body || err?.message || String(err)
    res.status(500).json({ error: "previous failed", details: body })
  }
})

async function refreshAccessTokenIfNeeded() {
  try {
    if (!REFRESH_TOKEN) return
    if (Date.now() < ACCESS_TOKEN_EXPIRES_AT - 30000) return // still valid (with 30s buffer)
    spotifyApi.setRefreshToken(REFRESH_TOKEN)
    const data = await spotifyApi.refreshAccessToken()
    spotifyApi.setAccessToken(data.body["access_token"])
    const expiresIn = data.body["expires_in"]
    ACCESS_TOKEN_EXPIRES_AT = Date.now() + expiresIn * 1000
    console.log("Refreshed access token, expires in", expiresIn, "s")
  } catch (e) {
    console.error("Failed to refresh token:", e)
  }
}

app.get("/now-playing", async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded()
    if (!spotifyApi.getAccessToken()) return res.status(401).json({ error: "Not authenticated. Visit /login" })

    const data = await spotifyApi.getMyCurrentPlaybackState()
    if (!data.body || data.status === 204) return res.json({ is_playing: false, item: null })

    const item = data.body.item
    const progress_ms = data.body.progress_ms || 0
    const is_playing = data.body.is_playing || false

    const out = {
      is_playing,
      progress_ms,
      timestamp: Date.now(),
      item: item
        ? {
          id: item.id,
          name: item.name,
          artists: item.artists.map(a => a.name),
          album: item.album.name,
          album_images: item.album.images, // array [ { url, height, width }, ... ]
          duration_ms: item.duration_ms,
          external_urls: item.external_urls,
        }
        : null,
    }
    // optionally serve a local canvas video if present.
    try {
      if (out.item && out.item.id) {
        // check public/canvas/<id>.(mp4|webm)
        const canvasDir = path.join(__dirname, 'public', 'canvas')
        const mp4 = path.join(canvasDir, `${out.item.id}.mp4`)
        const webm = path.join(canvasDir, `${out.item.id}.webm`)
        if (fs.existsSync(mp4)) {
          out.item.canvas_url = `/canvas/${out.item.id}.mp4`
        } else if (fs.existsSync(webm)) {
          out.item.canvas_url = `/canvas/${out.item.id}.webm`
        } else {
          // optional canvas.json mapping (trackId -> url)
          const mapFile = path.join(__dirname, 'canvas.json')
          if (fs.existsSync(mapFile)) {
            try {
              const mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
              if (mapping && mapping[out.item.id]) out.item.canvas_url = mapping[out.item.id]
            } catch (e) {
              console.error('Failed to parse canvas.json', e)
            }
          }
        }
      }
    } catch (e) {
      console.error('canvas detection error', e)
    }
    res.json(out)
  } catch (err) {
    console.error("now-playing error", err)
    res.status(500).json({ error: "failed", details: String(err) })
  }
})

// optional: serve a small status page (the wallpaper will be in public/index.html)
app.get("/", (req, res) => {
  res.redirect("/index.html")
})

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
  console.log(`Visit http://localhost:${PORT}/login to authenticate Spotify`)
})
