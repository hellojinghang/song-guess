/* Song Guess Aid - zero-backend GitHub Pages edition */
(() => {
  'use strict'

  const APP_VERSION = 1
  const STORAGE_KEY = 'songGuessAid.hostGame.v1'
  const PLAYER_DRAFT_KEY = 'songGuessAid.playerDraft.v1'
  const EXPIRY_MS = 60 * 60 * 1000
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('song-guess-aid') : null

  const app = document.getElementById('app')
  const toastEl = document.getElementById('toast')

  let ytReady = false
  let ytPlayer = null
  let ytPlayerReady = false
  let playbackWatcher = null
  let scanner = null
  let relaySource = null
  let activeView = null

  const params = new URLSearchParams(location.search)
  const mode = params.get('mode') || ''

  window.onYouTubeIframeAPIReady = () => {
    ytReady = true
    if (activeView === 'game') mountYouTubePlayer()
  }

  function now() { return Date.now() }

  function htmlEscape(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  function randomId(length = 6) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
  }

  function shuffle(array) {
    const copy = [...array]
    for (let i = copy.length - 1; i > 0; i--) {
      const bytes = new Uint32Array(1)
      crypto.getRandomValues(bytes)
      const j = bytes[0] % (i + 1)
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }

  function base64UrlEncode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj))
    let binary = ''
    bytes.forEach(b => { binary += String.fromCharCode(b) })
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  }

  function base64UrlDecode(text) {
    const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  }


  function bytesToBase64Url(bytes) {
    let binary = ''
    bytes.forEach(b => { binary += String.fromCharCode(b) })
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  }

  function base64UrlToBytes(text) {
    const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  }

  function randomSecret(byteLength = 24) {
    const bytes = new Uint8Array(byteLength)
    crypto.getRandomValues(bytes)
    return bytesToBase64Url(bytes)
  }

  function ensureRelay(game) {
    let changed = false
    if (!game.relayTopic) { game.relayTopic = `sga_${randomId(36)}`; changed = true }
    if (!game.relayKey) { game.relayKey = randomSecret(32); changed = true }
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(game)) } catch (_) {}
    }
    return { topic: game.relayTopic, key: game.relayKey }
  }

  async function encryptRelayPayload(keyText, payload) {
    const keyBytes = base64UrlToBytes(keyText)
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const plaintext = new TextEncoder().encode(JSON.stringify(payload))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
    return `SGR1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`
  }

  async function decryptRelayPayload(keyText, message) {
    const parts = String(message || '').split('.')
    if (parts.length !== 3 || parts[0] !== 'SGR1') throw new Error('Unsupported relay message.')
    const keyBytes = base64UrlToBytes(keyText)
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
    const iv = base64UrlToBytes(parts[1])
    const ciphertext = base64UrlToBytes(parts[2])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return JSON.parse(new TextDecoder().decode(plaintext))
  }

  async function sendRelaySubmission(relay, payload) {
    if (!relay?.topic || !relay?.key) throw new Error('Direct submission is unavailable for this invitation.')
    const encrypted = await encryptRelayPayload(relay.key, payload)
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(relay.topic)}`, {
      method: 'POST',
      body: encrypted,
      headers: { 'Cache': 'no', 'Firebase': 'no' }
    })
    if (!response.ok) throw new Error(`Relay returned HTTP ${response.status}.`)
  }

  function stopRelayListener() {
    try { relaySource?.close?.() } catch (_) {}
    relaySource = null
  }

  function setRelayStatus(text, ok = false) {
    const el = document.getElementById('relayStatus')
    if (!el) return
    el.textContent = text
    el.classList.toggle('ok', ok)
  }

  function startRelayListener(game) {
    stopRelayListener()
    if (game.stage !== 'lobby') return
    const relay = ensureRelay(game)
    setRelayStatus('Connecting live submissions…', false)
    try {
      relaySource = new EventSource(`https://ntfy.sh/${encodeURIComponent(relay.topic)}/sse`)
      relaySource.addEventListener('open', () => setRelayStatus('Live submissions connected', true))
      relaySource.onmessage = async (event) => {
        try {
          const envelope = JSON.parse(event.data)
          if (envelope.event !== 'message' || !envelope.message) return
          const payload = await decryptRelayPayload(relay.key, envelope.message)
          const changed = importPlayer(game, payload, { relay: true })
          if (changed) {
            toast(`${payload.name} submitted`)
            renderHost(game)
          }
        } catch (_) {
          // Ignore unrelated, malformed, or undecryptable traffic on this random topic.
        }
      }
      relaySource.onerror = () => setRelayStatus('Live relay reconnecting…', false)
    } catch (_) {
      setRelayStatus('Live relay unavailable; offline fallback still works', false)
    }
  }

  function toast(message) {
    toastEl.textContent = message
    toastEl.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 1800)
  }

  function extractYouTubeId(input) {
    const raw = input.trim()
    if (!raw) return null
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw
    try {
      const u = new URL(raw)
      const host = u.hostname.replace(/^www\./, '').toLowerCase()
      if (host === 'youtu.be') {
        const id = u.pathname.split('/').filter(Boolean)[0]
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null
      }
      if (host.endsWith('youtube.com')) {
        const v = u.searchParams.get('v')
        if (/^[A-Za-z0-9_-]{11}$/.test(v || '')) return v
        const parts = u.pathname.split('/').filter(Boolean)
        if (['shorts', 'embed', 'live'].includes(parts[0])) {
          return /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '') ? parts[1] : null
        }
      }
    } catch (_) {}
    return null
  }

  function touchHost(game, rerender = false) {
    game.lastActivity = now()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(game))
    broadcastGame(game)
    if (rerender) renderHost(game)
  }

  function loadHostGame() {
    try {
      const game = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (!game) return null
      if (!game.lastActivity || now() - game.lastActivity > EXPIRY_MS) {
        localStorage.removeItem(STORAGE_KEY)
        return null
      }
      return game
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
  }

  function clearHostGame() {
    localStorage.removeItem(STORAGE_KEY)
    broadcastGame(null)
  }

  function broadcastGame(game) {
    const state = publicDisplayState(game)
    channel?.postMessage(state)
    try { localStorage.setItem('songGuessAid.displayState.v1', JSON.stringify(state)) } catch (_) {}
  }

  function publicDisplayState(game) {
    if (!game || game.stage !== 'game' || !game.questions?.length) {
      return { type: 'display', stage: game?.stage || 'idle', updatedAt: now() }
    }
    const q = game.questions[game.currentIndex]
    return {
      type: 'display',
      stage: 'game',
      updatedAt: now(),
      round: game.currentIndex + 1,
      total: game.questions.length,
      duration: game.selectedDuration || 1,
      revealed: !!q.revealed,
      videoId: q.revealed ? q.videoId : null,
      providers: q.revealed ? q.providers : [],
      ended: !!game.ended
    }
  }

  function makeInviteUrl(game) {
    const relay = ensureRelay(game)
    const url = new URL(location.href)
    url.search = ''
    url.hash = ''
    url.searchParams.set('mode', 'submit')
    url.searchParams.set('g', game.id)
    url.searchParams.set('n', String(game.songsPerPlayer))
    url.searchParams.set('t', relay.topic)
    url.searchParams.set('k', relay.key)
    return url.toString()
  }

  function makeSubmissionCode(payload) {
    return `SGS1.${base64UrlEncode(payload)}`
  }

  function parseSubmissionCode(code) {
    const clean = code.trim()
    if (!clean.startsWith('SGS1.')) throw new Error('This is not a Song Guess submission code.')
    const payload = base64UrlDecode(clean.slice(5))
    if (payload.v !== APP_VERSION || !payload.g || !payload.name || !Array.isArray(payload.songs)) {
      throw new Error('Submission code is invalid or unsupported.')
    }
    return payload
  }

  function buildQuestions(players) {
    const byVideo = new Map()
    players.forEach(player => {
      player.songs.forEach(videoId => {
        const existing = byVideo.get(videoId) || { videoId, providers: [], startSeconds: null, revealed: false }
        if (!existing.providers.includes(player.name)) existing.providers.push(player.name)
        byVideo.set(videoId, existing)
      })
    })

    // Greedy shuffle: try to avoid a provider appearing in consecutive questions when possible.
    const remaining = shuffle([...byVideo.values()])
    const ordered = []
    while (remaining.length) {
      const prev = ordered.at(-1)
      let candidates = remaining.map((q, i) => ({ q, i }))
      if (prev) {
        const nonOverlap = candidates.filter(({ q }) => !q.providers.some(p => prev.providers.includes(p)))
        if (nonOverlap.length) candidates = nonOverlap
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      ordered.push(remaining.splice(pick.i, 1)[0])
    }
    return ordered
  }

  function renderHome() {
    stopRelayListener()
    activeView = 'home'
    app.innerHTML = `
      <main class="center-page">
        <section class="card">
          <div class="brand"><span class="note">♫</span> SONG GUESS AID</div>
          <h1>Tiny clips.<br>Big guesses.</h1>
          <p>One free GitHub Pages website. No player login or database. Invitation links support direct live submission from phone, tablet, laptop, or desktop.</p>
          <div class="stack" style="margin-top:26px">
            <button class="btn block" id="hostBtn">Host a game</button>
            <button class="btn secondary block" id="playerBtn">Submit songs</button>
          </div>
          <div class="divider" style="margin:22px 0"></div>
          <p class="small">For the cleanest guessing screen, the host can open an Audience Display tab/window on the same computer and put that window on the TV or projector.</p>
        </section>
      </main>`
    document.getElementById('hostBtn').onclick = () => {
      const existing = loadHostGame()
      if (existing) renderHost(existing)
      else renderCreateHost()
    }
    document.getElementById('playerBtn').onclick = () => renderManualJoin()
  }

  function renderCreateHost() {
    stopRelayListener()
    activeView = 'create'
    app.innerHTML = `
      <main class="center-page">
        <section class="card">
          <div class="between"><div class="brand"><span class="note">♫</span> HOST</div><button class="btn ghost" id="backBtn">Back</button></div>
          <h2 style="margin-top:18px">Create a game</h2>
          <p>Choose the number of players and the same song quota for everyone.</p>
          <form id="createForm" class="stack-lg" style="margin-top:22px">
            <div class="grid-2">
              <label class="label">Players
                <select class="select" id="playersSelect">${Array.from({length:11},(_,i)=>i+2).map(n=>`<option value="${n}" ${n===4?'selected':''}>${n}</option>`).join('')}</select>
              </label>
              <label class="label">Songs per player
                <select class="select" id="songsSelect">${Array.from({length:10},(_,i)=>i+1).map(n=>`<option value="${n}" ${n===3?'selected':''}>${n}</option>`).join('')}</select>
              </label>
            </div>
            <button class="btn block">Create game</button>
          </form>
        </section>
      </main>`
    document.getElementById('backBtn').onclick = renderHome
    document.getElementById('createForm').onsubmit = (e) => {
      e.preventDefault()
      const game = {
        v: APP_VERSION,
        id: randomId(6),
        expectedPlayers: Number(document.getElementById('playersSelect').value),
        songsPerPlayer: Number(document.getElementById('songsSelect').value),
        players: [],
        stage: 'lobby',
        createdAt: now(),
        lastActivity: now(),
        questions: [],
        currentIndex: 0,
        selectedDuration: 1,
        ended: false,
        relayTopic: `sga_${randomId(36)}`,
        relayKey: randomSecret(32)
      }
      touchHost(game)
      renderHost(game)
    }
  }

  function renderHost(game) {
    stopScanner()
    stopPlaybackWatcher()
    if (game.stage === 'game') return renderGame(game)
    activeView = 'host'
    const invite = makeInviteUrl(game)
    const ready = game.players.length === game.expectedPlayers
    app.innerHTML = `
      <main class="center-page">
        <section class="card wide">
          <div class="between">
            <div><div class="brand"><span class="note">♫</span> HOST LOBBY</div><div class="code-display" style="margin-top:12px">${htmlEscape(game.id)}</div></div>
            <button class="btn ghost" id="homeBtn">Home</button>
          </div>
          <div class="grid-2" style="margin-top:24px;align-items:start">
            <div class="stack-lg">
              <div class="panel stack">
                <div class="between"><h3 style="margin:0">Player invitation</h3><span class="pill">${game.songsPerPlayer} songs each</span></div>
                <p class="small">Players can scan this on a phone, or you can copy the link to any phone or desktop browser.</p>
                <div id="inviteQr" class="qr-wrap"></div>
                <div class="row">
                  <button class="btn secondary" id="copyInviteBtn">Copy invite link</button>
                </div>
              </div>
              <div class="panel stack">
                <div class="between"><h3 style="margin:0">Live submissions</h3><span class="pill" id="relayStatus">Connecting…</span></div>
                <p class="small">Players who open your invitation link can now submit directly. Their name and songs will appear here automatically.</p>
                <div class="info-box">Keep this host lobby open while players submit. The relay message is encrypted in the player's browser and sent without server-side message caching.</div>
                <details>
                  <summary class="muted" style="cursor:pointer">Offline fallback: import a submission code</summary>
                  <div class="stack" style="margin-top:12px">
                    <textarea class="textarea" id="submissionCode" placeholder="Paste SGS1... code here"></textarea>
                    <div class="grid-2">
                      <button class="btn" type="button" id="importBtn">Import code</button>
                      <button class="btn secondary" type="button" id="scanBtn">Scan QR</button>
                    </div>
                    <div id="scannerArea"></div>
                    <div id="importError"></div>
                  </div>
                </details>
              </div>
            </div>
            <div class="stack-lg">
              <div class="panel">
                <div class="between"><h3 style="margin:0">Players received</h3><span class="pill ${ready?'ok':''}">${game.players.length} / ${game.expectedPlayers}</span></div>
                <div class="player-list" style="margin-top:14px">
                  ${game.players.length ? game.players.map((p,i)=>`
                    <div class="player-item">
                      <div><div class="player-name">${htmlEscape(p.name)}</div><div class="small muted">${p.songs.length} songs</div></div>
                      <button class="btn ghost removePlayerBtn" data-index="${i}">Remove</button>
                    </div>`).join('') : `<div class="muted">Waiting for player submissions…</div>`}
                </div>
              </div>
              <div class="panel stack">
                <div class="info-box">Different players may submit the same YouTube video. It becomes one question and all matching providers are revealed together.</div>
                <button class="btn good block" id="startBtn" ${ready?'':'disabled'}>Start game</button>
                ${!ready ? `<div class="small muted">Receive exactly ${game.expectedPlayers} players before starting.</div>` : ''}
                <button class="btn danger block" id="endBtn">Delete this game</button>
              </div>
            </div>
          </div>
        </section>
      </main>`

    renderQr('inviteQr', invite, 230)
    startRelayListener(game)
    document.getElementById('homeBtn').onclick = renderHome
    document.getElementById('copyInviteBtn').onclick = async () => { await copyText(invite); toast('Invite link copied') }
    document.getElementById('importBtn').onclick = () => importSubmissionFromInput(game)
    document.getElementById('scanBtn').onclick = () => startScanner(game)
    document.querySelectorAll('.removePlayerBtn').forEach(btn => btn.onclick = () => {
      game.players.splice(Number(btn.dataset.index), 1)
      touchHost(game)
      renderHost(game)
    })
    document.getElementById('startBtn').onclick = () => {
      if (game.players.length !== game.expectedPlayers) return
      game.questions = buildQuestions(game.players)
      game.stage = 'game'
      game.currentIndex = 0
      game.selectedDuration = 1
      game.ended = false
      touchHost(game)
      renderGame(game)
    }
    document.getElementById('endBtn').onclick = () => {
      if (confirm('Delete this game from this browser?')) { clearHostGame(); renderHome() }
    }
  }

  function importSubmissionFromInput(game) {
    const box = document.getElementById('submissionCode')
    const err = document.getElementById('importError')
    try {
      const payload = parseSubmissionCode(box.value)
      importPlayer(game, payload)
      box.value = ''
      err.innerHTML = ''
      toast('Player imported')
      renderHost(game)
    } catch (e) {
      err.innerHTML = `<div class="error-box">${htmlEscape(e.message)}</div>`
    }
  }

  function importPlayer(game, payload, options = {}) {
    if (payload.g !== game.id) throw new Error(`This submission belongs to game ${payload.g}, not ${game.id}.`)
    if (payload.songs.length !== game.songsPerPlayer) throw new Error(`This player must submit exactly ${game.songsPerPlayer} songs.`)
    if (new Set(payload.songs).size !== payload.songs.length) throw new Error('This submission contains a repeated song.')
    if (payload.songs.some(id => !/^[A-Za-z0-9_-]{11}$/.test(id))) throw new Error('One or more YouTube video IDs are invalid.')
    const duplicateName = game.players.findIndex(p => p.name.toLowerCase() === payload.name.trim().toLowerCase())
    const player = { name: payload.name.trim().slice(0,40), songs: payload.songs }
    if (!player.name) throw new Error('Player name is missing.')
    if (duplicateName >= 0) {
      const sameSongs = JSON.stringify(game.players[duplicateName].songs) === JSON.stringify(player.songs)
      if (options.relay) {
        if (sameSongs) return false
        game.players[duplicateName] = player
      } else {
        if (!confirm(`${player.name} already exists. Replace their submission?`)) throw new Error('Import cancelled.')
        game.players[duplicateName] = player
      }
    } else {
      if (game.players.length >= game.expectedPlayers) throw new Error('All player slots are already filled.')
      game.players.push(player)
    }
    touchHost(game)
    return true
  }

  function renderManualJoin() {
    activeView = 'manualJoin'
    app.innerHTML = `
      <main class="center-page">
        <section class="card">
          <div class="between"><div class="brand"><span class="note">♫</span> PLAYER</div><button class="btn ghost" id="backBtn">Back</button></div>
          <h2 style="margin-top:18px">Submit songs</h2>
          <p>If the host gave you an invitation link or QR, use that instead. Otherwise enter the game code and the required number of songs.</p>
          <form id="manualForm" class="stack-lg" style="margin-top:22px">
            <label class="label">Game code
              <input class="input" id="gameId" maxlength="6" placeholder="ABC123" required>
            </label>
            <label class="label">Songs per player
              <select class="select" id="songCount">${Array.from({length:10},(_,i)=>i+1).map(n=>`<option value="${n}">${n}</option>`).join('')}</select>
            </label>
            <button class="btn block">Continue</button>
          </form>
        </section>
      </main>`
    document.getElementById('backBtn').onclick = renderHome
    document.getElementById('manualForm').onsubmit = (e) => {
      e.preventDefault()
      const g = document.getElementById('gameId').value.trim().toUpperCase()
      const n = Number(document.getElementById('songCount').value)
      if (!/^[A-Z2-9]{6}$/.test(g)) return toast('Check the 6-character game code')
      renderPlayerSubmission(g, n)
    }
  }

  function renderPlayerSubmission(gameId, songsPerPlayer, relay = null) {
    activeView = 'submit'
    const safeN = Math.max(1, Math.min(10, Number(songsPerPlayer) || 1))
    let draft = null
    try {
      draft = JSON.parse(localStorage.getItem(PLAYER_DRAFT_KEY) || 'null')
      if (!draft || draft.g !== gameId || draft.n !== safeN) draft = null
    } catch (_) {}
    app.innerHTML = `
      <main class="center-page">
        <section class="card">
          <div class="between"><div class="brand"><span class="note">♫</span> PLAYER SUBMISSION</div><span class="pill">Game ${htmlEscape(gameId)}</span></div>
          <h2 style="margin-top:18px">Choose ${safeN} song${safeN===1?'':'s'}</h2>
          <p>Paste YouTube links. The same player cannot submit the same video twice.${relay?.topic && relay?.key ? ' When you press Submit, your songs go directly to the host.' : ''}</p>
          <form id="submitForm" class="stack-lg" style="margin-top:20px">
            <label class="label">Your name
              <input class="input" id="playerName" maxlength="40" value="${htmlEscape(draft?.name || '')}" placeholder="e.g. Sarah" required>
            </label>
            <div class="stack">
              ${Array.from({length:safeN},(_,i)=>`
                <label class="song-input-row">
                  <span class="song-number">${i+1}</span>
                  <textarea class="textarea songUrl" inputmode="url" autocomplete="off" placeholder="Paste full YouTube link here" rows="2" required>${htmlEscape(draft?.urls?.[i] || '')}</textarea>
                </label>`).join('')}
            </div>
            <div id="submitError"></div>
            <button class="btn block" id="submitBtn">${relay?.topic && relay?.key ? 'Submit songs to host' : 'Create submission code'}</button>
          </form>
          <button class="btn ghost block" id="homeBtn" style="margin-top:12px">Home</button>
        </section>
      </main>`

    const inputs = [...document.querySelectorAll('.songUrl')]
    const nameInput = document.getElementById('playerName')
    const saveDraft = () => localStorage.setItem(PLAYER_DRAFT_KEY, JSON.stringify({g:gameId,n:safeN,name:nameInput.value,urls:inputs.map(x=>x.value)}))
    inputs.forEach(i => i.addEventListener('input', saveDraft))
    nameInput.addEventListener('input', saveDraft)
    document.getElementById('homeBtn').onclick = renderHome
    document.getElementById('submitForm').onsubmit = async (e) => {
      e.preventDefault()
      const err = document.getElementById('submitError')
      const submitBtn = document.getElementById('submitBtn')
      const name = nameInput.value.trim()
      const ids = inputs.map(x => extractYouTubeId(x.value))
      if (!name) return
      if (ids.some(id => !id)) {
        err.innerHTML = '<div class="error-box">At least one YouTube link is not recognized. Please use a normal YouTube, youtu.be, Shorts, or Live URL.</div>'
        return
      }
      if (new Set(ids).size !== ids.length) {
        err.innerHTML = '<div class="error-box">You submitted the same YouTube video more than once. Replace the duplicate.</div>'
        return
      }
      const payload = { v: APP_VERSION, g: gameId, name, songs: ids }
      localStorage.removeItem(PLAYER_DRAFT_KEY)
      if (relay?.topic && relay?.key) {
        submitBtn.disabled = true
        submitBtn.textContent = 'Sending to host…'
        err.innerHTML = ''
        try {
          await sendRelaySubmission(relay, payload)
          renderPlayerReady(payload, { direct: true, relay })
          return
        } catch (_) {
          renderPlayerReady(payload, { direct: false, relay, failed: true })
          return
        }
      }
      renderPlayerReady(payload, { direct: false, relay: null })
    }
  }

  function renderPlayerReady(payload, options = {}) {
    activeView = 'playerReady'
    const code = makeSubmissionCode(payload)
    const direct = !!options.direct
    const relay = options.relay || null
    const failed = !!options.failed
    app.innerHTML = `
      <main class="center-page">
        <section class="card">
          <div class="brand"><span class="note">♫</span> ${direct ? 'SUBMITTED' : 'READY'}</div>
          <h2 style="margin-top:18px">${direct ? 'Songs sent to the host ✓' : failed ? 'Direct send did not connect' : 'Give this to the host'}</h2>
          <p>${direct ? 'Your submission was sent through the live relay. Ask the host to confirm your name appears in the lobby.' : failed ? 'No songs were lost. Use the fallback below so the host can import your submission.' : 'Use the fallback code or QR so the host can import your songs.'}</p>
          <div class="stack-lg" style="margin-top:22px">
            ${direct ? `<div class="info-box">You are finished. You can close this page. The fallback below is only needed if the host says your name did not appear.</div>` : ''}
            <details ${direct ? '' : 'open'}>
              <summary class="muted" style="cursor:pointer">${direct ? 'Offline fallback' : 'Submission fallback'}</summary>
              <div class="stack" style="margin-top:12px">
                <div id="playerQr" class="qr-wrap"></div>
                <button class="btn ${direct ? 'secondary' : ''} block" id="copyBtn">Copy submission code</button>
                <textarea class="textarea" readonly id="codeBox">${htmlEscape(code)}</textarea>
              </div>
            </details>
            <button class="btn ghost block" id="newBtn">Create another submission</button>
          </div>
        </section>
      </main>`
    renderQr('playerQr', code, 240)
    document.getElementById('copyBtn').onclick = async () => { await copyText(code); toast('Submission code copied') }
    document.getElementById('newBtn').onclick = () => renderPlayerSubmission(payload.g, payload.songs.length, relay)
  }

  function renderGame(game) {
    stopRelayListener()
    activeView = 'game'
    stopScanner()
    stopPlaybackWatcher()
    const q = game.questions[game.currentIndex]
    const canPrev = game.currentIndex > 0
    const canNext = game.currentIndex < game.questions.length - 1
    app.innerHTML = `
      <main class="card wide" style="margin:0 auto">
        <div class="between">
          <div><div class="brand"><span class="note">♫</span> HOST CONTROLLER</div><div class="round-line" style="margin-top:8px">Round ${game.currentIndex+1} of ${game.questions.length}</div></div>
          <div class="row"><button class="btn ghost" id="displayBtn">Audience display</button><button class="btn ghost" id="fullscreenBtn">Fullscreen</button></div>
        </div>
        <div class="host-grid" style="margin-top:20px">
          <section class="panel stack-lg">
            <div>
              <div class="round-line">Guessing screen</div>
              <div class="game-title">${q.revealed ? 'Answer revealed' : 'Guess the song'}</div>
              ${q.revealed ? `<div class="display-providers" style="font-size:clamp(22px,4vw,38px);margin-top:0">Submitted by ${humanList(q.providers)}</div>` : `<p>No provider information is shown until Reveal.</p>`}
            </div>
            <div>
              <div class="label" style="margin-bottom:9px">Clip length</div>
              <div class="duration-grid">
                ${Array.from({length:10},(_,i)=>(i+1)/2).map(d=>`<button class="duration-btn ${game.selectedDuration===d?'active':''}" data-duration="${d}">${d.toFixed(1)}s</button>`).join('')}
              </div>
            </div>
            <div class="game-actions">
              <button class="btn" id="playBtn">▶ Play clip</button>
              <button class="btn secondary" id="revealBtn">${q.revealed ? 'Revealed ✓' : 'Reveal answer'}</button>
              <button class="btn ghost" id="prevBtn" ${canPrev?'':'disabled'}>← Previous</button>
              <button class="btn ghost" id="nextBtn">${canNext ? 'Next →' : 'Finish game'}</button>
            </div>
            <div id="gameMsg" class="small muted">The YouTube player is intentionally visible on the host controller. Keep this controller facing the host, not the guessers.</div>
          </section>
          <section class="panel stack">
            <div class="between"><h3 style="margin:0">YouTube player</h3><span class="pill">Host only</span></div>
            <div class="youtube-shell"><div id="youtubePlayer"></div></div>
            <div class="small muted">The fixed random start point is created after YouTube reports the video's duration, then reused for every clue length.</div>
          </section>
        </div>
        <div class="row" style="margin-top:18px;justify-content:flex-end">
          <button class="btn danger" id="endGameBtn">End & delete game</button>
        </div>
      </main>`

    document.querySelectorAll('.duration-btn').forEach(btn => btn.onclick = () => {
      game.selectedDuration = Number(btn.dataset.duration)
      touchHost(game)
      renderGame(game)
    })
    document.getElementById('playBtn').onclick = () => playQuestionClip(game)
    document.getElementById('revealBtn').onclick = () => {
      q.revealed = true
      touchHost(game)
      renderGame(game)
    }
    document.getElementById('prevBtn').onclick = () => {
      if (!canPrev) return
      game.currentIndex--
      touchHost(game)
      renderGame(game)
    }
    document.getElementById('nextBtn').onclick = () => {
      if (canNext) {
        game.currentIndex++
        touchHost(game)
        renderGame(game)
      } else {
        game.ended = true
        game.stage = 'ended'
        touchHost(game)
        renderEnd(game)
      }
    }
    document.getElementById('displayBtn').onclick = () => openDisplay(game)
    document.getElementById('fullscreenBtn').onclick = () => document.documentElement.requestFullscreen?.()
    document.getElementById('endGameBtn').onclick = () => {
      if (confirm('End and delete this game from this browser?')) { destroyPlayer(); clearHostGame(); renderHome() }
    }

    setTimeout(() => mountYouTubePlayer(q.videoId), 0)
    broadcastGame(game)
  }

  function mountYouTubePlayer(videoId) {
    if (activeView !== 'game' || !document.getElementById('youtubePlayer')) return
    if (!ytReady || !window.YT?.Player) {
      setTimeout(() => mountYouTubePlayer(videoId), 300)
      return
    }
    destroyPlayer()
    ytPlayerReady = false
    ytPlayer = new YT.Player('youtubePlayer', {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => { ytPlayerReady = true },
        onError: (e) => {
          const msg = document.getElementById('gameMsg')
          if (msg) msg.innerHTML = `<span class="danger-text">YouTube cannot play this video here (error ${htmlEscape(e.data)}). You can skip to the next question.</span>`
        }
      }
    })
  }

  function destroyPlayer() {
    stopPlaybackWatcher()
    try { ytPlayer?.destroy?.() } catch (_) {}
    ytPlayer = null
    ytPlayerReady = false
  }

  function chooseStartSeconds(duration) {
    if (!duration || duration <= 0) return 0
    if (duration < 20) return Math.max(0, duration * 0.1)
    const min = duration * .15
    const max = Math.max(min, duration * .85 - 5)
    return min + Math.random() * Math.max(0, max - min)
  }

  function playQuestionClip(game) {
    const q = game.questions[game.currentIndex]
    const msg = document.getElementById('gameMsg')
    if (!ytPlayerReady || !ytPlayer) {
      if (msg) msg.textContent = 'YouTube is still loading. Tap Play again in a moment.'
      return
    }
    const duration = Number(ytPlayer.getDuration?.() || 0)
    if (!duration) {
      ytPlayer.playVideo?.()
      setTimeout(() => ytPlayer.pauseVideo?.(), 250)
      if (msg) msg.textContent = 'Loading video timing. Tap Play again once the video is ready.'
      return
    }
    if (q.startSeconds == null) {
      q.startSeconds = chooseStartSeconds(duration)
      touchHost(game)
    }
    const start = Math.min(q.startSeconds, Math.max(0, duration - game.selectedDuration - .1))
    const target = start + game.selectedDuration
    ytPlayer.seekTo(start, true)
    ytPlayer.playVideo()
    stopPlaybackWatcher()
    playbackWatcher = setInterval(() => {
      if (!ytPlayer) return stopPlaybackWatcher()
      const current = Number(ytPlayer.getCurrentTime?.() || 0)
      if (current >= target - .035) {
        ytPlayer.pauseVideo?.()
        stopPlaybackWatcher()
      }
    }, 35)
    if (msg) msg.textContent = `Playing ${game.selectedDuration.toFixed(1)} seconds from the question's fixed random point.`
    touchHost(game)
  }

  function stopPlaybackWatcher() {
    if (playbackWatcher) clearInterval(playbackWatcher)
    playbackWatcher = null
  }

  function humanList(names) {
    const safe = names.map(htmlEscape)
    if (safe.length <= 1) return safe[0] || ''
    if (safe.length === 2) return `${safe[0]} & ${safe[1]}`
    return `${safe.slice(0,-1).join(', ')} & ${safe.at(-1)}`
  }

  function renderEnd(game) {
    stopRelayListener()
    activeView = 'ended'
    destroyPlayer()
    app.innerHTML = `
      <main class="center-page">
        <section class="card wide">
          <div class="brand"><span class="note">♫</span> GAME OVER</div>
          <h2 style="margin-top:18px">${game.questions.length} unique song${game.questions.length===1?'':'s'} played</h2>
          <p>Cross-player duplicates were merged automatically.</p>
          <div class="end-list" style="margin-top:20px">
            ${game.questions.map((q,i)=>`<div class="end-item"><strong>${i+1}. YouTube video ${htmlEscape(q.videoId)}</strong><div class="small muted" style="margin-top:4px">Submitted by ${humanList(q.providers)}</div></div>`).join('')}
          </div>
          <div class="grid-2" style="margin-top:20px">
            <button class="btn secondary" id="restartBtn">Back to lobby</button>
            <button class="btn danger" id="deleteBtn">Delete game</button>
          </div>
        </section>
      </main>`
    broadcastGame(game)
    document.getElementById('restartBtn').onclick = () => {
      game.stage = 'lobby'; game.questions = []; game.currentIndex = 0; game.ended = false
      touchHost(game); renderHost(game)
    }
    document.getElementById('deleteBtn').onclick = () => { clearHostGame(); renderHome() }
  }

  function openDisplay(game) {
    broadcastGame(game)
    const url = new URL(location.href)
    url.search = ''
    url.searchParams.set('mode', 'display')
    const win = window.open(url.toString(), 'songGuessAudience')
    if (!win) toast('Popup blocked. Allow popups or open the Audience Display in a new tab.')
  }

  function renderDisplay(initialState = null) {
    activeView = 'display'
    document.body.style.overflow = 'hidden'
    const state = initialState || readDisplayState()
    paintDisplay(state)
    channel?.addEventListener('message', e => {
      if (e.data?.type === 'display') paintDisplay(e.data)
    })
    window.addEventListener('storage', e => {
      if (e.key === 'songGuessAid.displayState.v1') paintDisplay(readDisplayState())
    })
    setInterval(() => paintDisplay(readDisplayState()), 1800)
  }

  function readDisplayState() {
    try { return JSON.parse(localStorage.getItem('songGuessAid.displayState.v1') || 'null') } catch (_) { return null }
  }

  function paintDisplay(state) {
    if (!state || state.stage !== 'game') {
      app.innerHTML = `<main class="display-page"><section class="display-inner"><div class="brand"><span class="note">♫</span> SONG GUESS AID</div><div class="display-title">Waiting…</div><div class="display-sub">Start the game from the host controller.</div></section></main>`
      return
    }
    const providerText = state.revealed ? `Submitted by ${humanList(state.providers || [])}` : ''
    const revealVideo = state.revealed && state.videoId ? `<iframe class="reveal-video" src="https://www.youtube.com/embed/${encodeURIComponent(state.videoId)}?rel=0" title="Revealed YouTube song" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>` : ''
    app.innerHTML = `
      <main class="display-page">
        <button class="btn ghost display-close" id="exitDisplayBtn">Exit display</button>
        <section class="display-inner">
          <div class="display-round">ROUND ${state.round} / ${state.total}</div>
          <div class="display-title">${state.revealed ? 'ANSWER' : 'GUESS THE SONG'}</div>
          <div class="display-sub">${state.revealed ? 'Song revealed' : `${Number(state.duration).toFixed(1)} second clue`}</div>
          ${state.revealed ? `<div class="display-providers">${providerText}</div>${revealVideo}` : ''}
        </section>
      </main>`
    document.getElementById('exitDisplayBtn').onclick = () => { location.href = location.pathname }
  }

  function renderQr(targetId, text, size) {
    const target = document.getElementById(targetId)
    if (!target) return
    target.innerHTML = ''
    const tryRender = () => {
      if (window.QRCode) {
        new QRCode(target, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M })
      } else setTimeout(tryRender, 150)
    }
    tryRender()
  }

  function startScanner(game) {
    const area = document.getElementById('scannerArea')
    if (!window.Html5QrcodeScanner) {
      area.innerHTML = '<div class="error-box">Camera scanner could not load. You can still paste the submission code.</div>'
      return
    }
    if (scanner) return stopScanner()
    area.innerHTML = '<div id="reader" class="scanner-wrap"></div><button class="btn ghost block" id="stopScanBtn" style="margin-top:10px">Stop camera</button>'
    scanner = new Html5QrcodeScanner('reader', { fps: 8, qrbox: { width: 230, height: 230 }, rememberLastUsedCamera: true }, false)
    scanner.render((decodedText) => {
      try {
        const payload = parseSubmissionCode(decodedText)
        importPlayer(game, payload)
        toast('Player imported')
        stopScanner()
        renderHost(game)
      } catch (e) {
        const err = document.getElementById('importError')
        if (err) err.innerHTML = `<div class="error-box">${htmlEscape(e.message)}</div>`
      }
    }, () => {})
    document.getElementById('stopScanBtn').onclick = stopScanner
  }

  function stopScanner() {
    if (!scanner) return
    try { scanner.clear() } catch (_) {}
    scanner = null
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text) }
    catch (_) {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
  }

  function boot() {
    if (mode === 'display') return renderDisplay()
    if (mode === 'submit') {
      const g = (params.get('g') || '').trim().toUpperCase()
      const n = Number(params.get('n'))
      const t = (params.get('t') || '').trim()
      const k = (params.get('k') || '').trim()
      const relay = /^[A-Za-z0-9_-]{8,64}$/.test(t) && /^[A-Za-z0-9_-]{32,64}$/.test(k) ? { topic: t, key: k } : null
      if (/^[A-Z2-9]{6}$/.test(g) && n >= 1 && n <= 10) return renderPlayerSubmission(g, n, relay)
      return renderManualJoin()
    }
    renderHome()

    setInterval(() => {
      const game = loadHostGame()
      if (!game && ['host','game','ended'].includes(activeView)) {
        toast('Game expired after 1 hour of inactivity')
        renderHome()
      }
    }, 60000)
  }

  boot()
})()
