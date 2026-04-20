// resell/js/google-client.js
// Google OAuth + Sheets + Drive 연동 일체
(() => {
  'use strict'

  const CLIENT_ID = '1005021855988-25j0ujhc2h7c72dt25av574ntcoavfhn.apps.googleusercontent.com'
  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ].join(' ')

  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
  const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
  const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

  const SHEET_SCHEMA = [
    { name: 'meta',            headers: ['key', 'value'] },
    { name: 'categories',      headers: ['id', 'name', 'icon', 'color', 'bg', 'order'] },
    { name: 'brands',          headers: ['id', 'name', 'categoryId'] },
    { name: 'products',        headers: ['id','brandId','name','detail','buyPrice','sellPrice','site','soldPlatform','date','soldDate','sold','memo','photos','filterValues','deletedAt'] },
    { name: 'categoryFilters', headers: ['categoryId', 'filters', 'filterNames'] },
  ]

  const state = {
    tokenClient: null,
    accessToken: null,
    tokenExpiresAt: 0,
    email: null,
    spreadsheetId: null,
    driveFolderId: null,
  }

  window.G = { state, init, login, logout, isLoggedIn, fetch: gFetch, ensureWorkspace, writeAll, readAll, SHEET_SCHEMA, uploadPhoto, deletePhoto, photoUrl, clearPhotoCache }

  function isLoggedIn() {
    return !!state.accessToken && Date.now() < state.tokenExpiresAt
  }

  // ── OAuth ──────────────────────────────────────────────────────────

  function init() {
    if (!window.google?.accounts?.oauth2) {
      console.warn('[G] GIS not loaded yet')
      return
    }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: onToken
    })
    const cached = sessionStorage.getItem('resell_access_token')
    const exp = Number(sessionStorage.getItem('resell_token_expires') || 0)
    if (cached && Date.now() < exp) {
      state.accessToken = cached
      state.tokenExpiresAt = exp
      state.spreadsheetId = localStorage.getItem('resell_spreadsheet_id')
      state.driveFolderId = localStorage.getItem('resell_drive_folder_id')
      queueMicrotask(() => document.dispatchEvent(new CustomEvent('g:login')))
    }
  }

  function onToken(resp) {
    if (resp.error) { console.error('[G] token error', resp); return }
    state.accessToken = resp.access_token
    state.tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000
    sessionStorage.setItem('resell_access_token', resp.access_token)
    sessionStorage.setItem('resell_token_expires', String(state.tokenExpiresAt))
    state.spreadsheetId = localStorage.getItem('resell_spreadsheet_id')
    state.driveFolderId = localStorage.getItem('resell_drive_folder_id')
    // 이메일 가져오기
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${resp.access_token}` }
    }).then(r => r.json()).then(u => {
      state.email = u.email
      document.dispatchEvent(new CustomEvent('g:login'))
    }).catch(() => document.dispatchEvent(new CustomEvent('g:login')))
  }

  function login() {
    if (!state.tokenClient) init()
    state.tokenClient.requestAccessToken({ prompt: state.accessToken ? '' : 'consent' })
  }

  function logout() {
    if (state.accessToken) google.accounts.oauth2.revoke(state.accessToken, () => {})
    state.accessToken = null
    state.tokenExpiresAt = 0
    state.email = null
    sessionStorage.removeItem('resell_access_token')
    sessionStorage.removeItem('resell_token_expires')
    document.dispatchEvent(new CustomEvent('g:logout'))
  }

  // ── gFetch (토큰 만료 시 자동 재인증) ──────────────────────────────

  async function gFetch(url, opts = {}) {
    if (!isLoggedIn()) throw new Error('NOT_LOGGED_IN')
    const doFetch = () => fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), 'Authorization': `Bearer ${state.accessToken}` }
    })
    let res = await doFetch()
    if (res.status === 401) {
      await new Promise((resolve, reject) => {
        const origCb = state.tokenClient.callback
        state.tokenClient.callback = (resp) => {
          state.tokenClient.callback = origCb
          if (resp.error) return reject(resp)
          state.accessToken = resp.access_token
          state.tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000
          sessionStorage.setItem('resell_access_token', resp.access_token)
          sessionStorage.setItem('resell_token_expires', String(state.tokenExpiresAt))
          resolve()
        }
        state.tokenClient.requestAccessToken({ prompt: 'none' })
      })
      res = await doFetch()
    }
    return res
  }

  // ── Workspace (폴더 + 스프레드시트 생성) ──────────────────────────

  async function ensureWorkspace() {
    // 1) Drive 폴더
    if (!state.driveFolderId) {
      const q = encodeURIComponent("name='Resell' and mimeType='application/vnd.google-apps.folder' and trashed=false")
      const listRes = await gFetch(`${DRIVE_API}?q=${q}&fields=files(id,name)`)
      const { files } = await listRes.json()
      if (files && files.length) {
        state.driveFolderId = files[0].id
      } else {
        const createRes = await gFetch(DRIVE_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Resell', mimeType: 'application/vnd.google-apps.folder' })
        })
        state.driveFolderId = (await createRes.json()).id
      }
      localStorage.setItem('resell_drive_folder_id', state.driveFolderId)
    }
    // 2) 스프레드시트
    if (!state.spreadsheetId) {
      const body = {
        properties: { title: 'Resell DB' },
        sheets: SHEET_SCHEMA.map(s => ({
          properties: { title: s.name },
          data: [{ rowData: [{ values: s.headers.map(h => ({ userEnteredValue: { stringValue: h } })) }] }]
        }))
      }
      const res = await gFetch(SHEETS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const sheet = await res.json()
      state.spreadsheetId = sheet.spreadsheetId
      localStorage.setItem('resell_spreadsheet_id', state.spreadsheetId)
      // 스프레드시트를 Resell 폴더로 이동
      await gFetch(`${DRIVE_API}/${state.spreadsheetId}?addParents=${state.driveFolderId}&fields=id,parents`, { method: 'PATCH' })
    }
  }

  // ── writeAll (D → Sheets) ─────────────────────────────────────────

  async function writeAll(D) {
    await ensureWorkspace()
    const now = new Date().toISOString()
    const rows = {
      meta: [
        ['appVersion', '1'],
        ['syncedAt', now],
      ],
      categories: (D.categories || []).map((c, i) => [c.id, c.name, c.icon || '', c.color || '', c.bg || '', String(i)]),
      brands: (D.companies || []).map(b => [b.id, b.name, b.categoryId || '']),
      products: [...(D.products || []), ...(D.deletedProducts || [])].map(p => [
        p.id, p.companyId || '', p.name || '', p.detail || '',
        p.buyPrice ?? '', p.sellPrice ?? '',
        p.site || '', p.soldPlatform || '',
        p.date || '', p.soldDate || '',
        p.sold ? 'Y' : 'N',
        p.memo || '',
        JSON.stringify((p.thumbnails || []).filter(t => !t?._uploading)),
        JSON.stringify(p.filterValues || {}),
        p.deletedAt || '',
      ]),
      categoryFilters: Object.entries(D.categoryFilters || {}).map(([id, cf]) => [
        id, JSON.stringify(cf.filters || {}), JSON.stringify(cf.filterNames || {})
      ]),
    }
    for (const sheet of SHEET_SCHEMA) {
      await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values/${sheet.name}:clear`, { method: 'POST' })
      const values = [sheet.headers, ...rows[sheet.name]]
      await gFetch(
        `${SHEETS_API}/${state.spreadsheetId}/values/${sheet.name}!A1?valueInputOption=RAW`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
      )
    }
  }

  // ── readAll (Sheets → D) ──────────────────────────────────────────

  async function readAll() {
    if (!state.spreadsheetId) return null
    const ranges = SHEET_SCHEMA.map(s => `ranges=${s.name}`).join('&')
    const res = await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values:batchGet?${ranges}&majorDimension=ROWS`)
    const { valueRanges } = await res.json()
    if (!valueRanges) return null
    const byName = {}
    valueRanges.forEach((vr, i) => {
      const name = SHEET_SCHEMA[i].name
      const [headers = [], ...rows] = vr.values || []
      byName[name] = rows.map(r => {
        const o = {}
        headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : '' })
        return o
      })
    })
    const allProducts = (byName.products || []).map(r => ({
      id: r.id,
      companyId: r.brandId,
      name: r.name,
      detail: r.detail,
      buyPrice: r.buyPrice === '' ? null : Number(r.buyPrice),
      sellPrice: r.sellPrice === '' ? null : Number(r.sellPrice),
      site: r.site,
      soldPlatform: r.soldPlatform,
      date: r.date,
      soldDate: r.soldDate,
      sold: r.sold === 'Y',
      memo: r.memo,
      thumbnails: JSON.parse(r.photos || '[]'),
      thumbnail: null,
      filterValues: JSON.parse(r.filterValues || '{}'),
      deletedAt: r.deletedAt || null,
      isOnSale: false,
    }))
    return {
      categories: (byName.categories || []).map(r => ({
        id: r.id, name: r.name, icon: r.icon, color: r.color, bg: r.bg
      })),
      companies: (byName.brands || []).map(r => ({ id: r.id, name: r.name, categoryId: r.categoryId })),
      products: allProducts.filter(p => !p.deletedAt),
      deletedProducts: allProducts.filter(p => !!p.deletedAt),
      categoryFilters: Object.fromEntries((byName.categoryFilters || []).map(r => [
        r.categoryId, { filters: JSON.parse(r.filters || '{}'), filterNames: JSON.parse(r.filterNames || '{}') }
      ])),
    }
  }

  // ── Photo Upload/Download/Delete ───────────────────────────────────

  function resizeToBlob(file, maxEdge = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          const c = document.createElement('canvas')
          c.width = w; c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          c.toBlob(blob => resolve({ blob, width: w, height: h }), 'image/jpeg', quality)
        }
        img.onerror = reject
        img.src = reader.result
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function driveUploadBlob(blob, name) {
    const metadata = { name, parents: [state.driveFolderId], mimeType: 'image/jpeg' }
    const boundary = '----resell' + Math.random().toString(16).slice(2)
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
      blob,
      `\r\n--${boundary}--\r\n`
    ], { type: `multipart/related; boundary=${boundary}` })
    const res = await gFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', body })
    return (await res.json()).id
  }

  async function uploadPhoto(file) {
    await ensureWorkspace()
    const ts = Date.now()
    const [full, thumb] = await Promise.all([
      resizeToBlob(file, 1600, 0.85),
      resizeToBlob(file, 200, 0.7),
    ])
    const [fileId, thumbFileId] = await Promise.all([
      driveUploadBlob(full.blob, `photo-${ts}.jpg`),
      driveUploadBlob(thumb.blob, `thumb-${ts}.jpg`),
    ])
    // 썸네일만 캐시 (원본은 상세 팝업에서 Drive에서 직접 로드)
    photoUrlCache.set(thumbFileId, previewUrl)
    return { fileId, thumbFileId, width: full.width, height: full.height }
  }

  async function deletePhoto(photo) {
    if (!photo) return
    const fid = typeof photo === 'object' ? photo.fileId : photo
    const tid = typeof photo === 'object' ? photo.thumbFileId : null
    if (fid) { try { await gFetch(`${DRIVE_API}/${fid}`, { method: 'DELETE' }) } catch(e) {} }
    if (tid) { try { await gFetch(`${DRIVE_API}/${tid}`, { method: 'DELETE' }) } catch(e) {} }
    clearPhotoCache(fid)
    clearPhotoCache(tid)
  }

  const photoUrlCache = new Map()

  async function photoUrl(fileId) {
    if (!fileId) return null
    if (photoUrlCache.has(fileId)) return photoUrlCache.get(fileId)
    const res = await gFetch(`${DRIVE_API}/${fileId}?alt=media`)
    if (!res.ok) return null
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    photoUrlCache.set(fileId, url)
    return url
  }

  function clearPhotoCache(fileId) {
    if (fileId) {
      const u = photoUrlCache.get(fileId)
      if (u) URL.revokeObjectURL(u)
      photoUrlCache.delete(fileId)
    } else {
      photoUrlCache.forEach(u => URL.revokeObjectURL(u))
      photoUrlCache.clear()
    }
  }

})()
