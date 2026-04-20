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

  const PRODUCT_HEADERS = ['id','brandId','name','detail','buyPrice','sellPrice','site','soldPlatform','date','soldDate','sold','memo','photos','filterValues','deletedAt','brandName','brandCatId']

  const BASE_SHEETS = [
    { name: 'meta',            headers: ['key', 'value'] },
    { name: 'categories',      headers: ['id', 'name', 'icon', 'color', 'bg', 'order'] },
    { name: 'brands',          headers: ['id', 'name', 'categoryId'] },
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

  window.G = { state, init, login, logout, isLoggedIn, isConfigured, fetch: gFetch, ensureWorkspace, writeAll, readAll, uploadPhoto, deletePhoto, photoUrl, clearPhotoCache }

  function isLoggedIn() {
    return !!state.accessToken && Date.now() < state.tokenExpiresAt
  }

  function isConfigured() {
    return !!state.spreadsheetId || !!localStorage.getItem('resell_spreadsheet_id')
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

  async function reAuth() {
    if (!state.tokenClient) init()
    await new Promise((resolve, reject) => {
      const origCb = state.tokenClient.callback
      state.tokenClient.callback = (resp) => {
        state.tokenClient.callback = origCb
        if (resp.error) return reject(resp)
        onToken(resp)
        resolve()
      }
      state.tokenClient.requestAccessToken({ prompt: '' })
    })
  }

  async function gFetch(url, opts = {}) {
    if (!isLoggedIn() && isConfigured()) await reAuth()
    if (!isLoggedIn()) throw new Error('NOT_LOGGED_IN')
    const doFetch = () => fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), 'Authorization': `Bearer ${state.accessToken}` }
    })
    let res = await doFetch()
    if (res.status === 401) {
      await reAuth()
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
        sheets: BASE_SHEETS.map(s => ({
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
      await gFetch(`${DRIVE_API}/${state.spreadsheetId}?addParents=${state.driveFolderId}&fields=id,parents`, { method: 'PATCH' })
    }
  }

  // ── 시트 존재 확인 / 생성 헬퍼 ─────────────────────────────────────

  async function getExistingSheets() {
    const res = await gFetch(`${SHEETS_API}/${state.spreadsheetId}?fields=sheets.properties.title`)
    const data = await res.json()
    return (data.sheets || []).map(s => s.properties.title)
  }

  async function ensureSheet(name) {
    const existing = await getExistingSheets()
    if (existing.includes(name)) return
    await gFetch(`${SHEETS_API}/${state.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: name } } }]
      })
    })
    // 헤더 추가
    await gFetch(
      `${SHEETS_API}/${state.spreadsheetId}/values/${encodeURIComponent(name)}!A1?valueInputOption=RAW`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [PRODUCT_HEADERS] }) }
    )
  }

  function catSheetName(catId, catName) {
    return `products_${catName || catId}`
  }

  // ── writeAll (D → Sheets) ─────────────────────────────────────────

  async function writeAll(D) {
    await ensureWorkspace()
    const now = new Date().toISOString()

    // 기본 시트 데이터
    const baseRows = {
      meta: [['appVersion', '2'], ['syncedAt', now]],
      categories: (D.categories || []).map((c, i) => [c.id, c.name, c.icon || '', c.color || '', c.bg || '', String(i)]),
      brands: (D.companies || []).map(b => [b.id, b.name, b.categoryId || '']),
      categoryFilters: Object.entries(D.categoryFilters || {}).map(([id, cf]) => [
        id, JSON.stringify(cf.filters || {}), JSON.stringify(cf.filterNames || {})
      ]),
    }
    for (const sheet of BASE_SHEETS) {
      await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values/${sheet.name}:clear`, { method: 'POST' })
      const values = [sheet.headers, ...baseRows[sheet.name]]
      await gFetch(
        `${SHEETS_API}/${state.spreadsheetId}/values/${sheet.name}!A1?valueInputOption=RAW`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
      )
    }

    // 카테고리별 products 시트
    const allProducts = [...(D.products || []), ...(D.deletedProducts || [])]
    const categories = (D.categories || []).filter(c => c.id !== 'all')
    const brandCatMap = {}
    ;(D.companies || []).forEach(b => { brandCatMap[b.id] = b.categoryId })

    function productRow(p) {
      return [
        p.id, p.companyId || '', p.name || '', p.detail || '',
        p.buyPrice ?? '', p.sellPrice ?? '',
        p.site || '', p.soldPlatform || '',
        p.date || '', p.soldDate || '',
        p.sold ? 'Y' : 'N',
        p.memo || '',
        JSON.stringify((p.thumbnails || []).filter(t => !t?._uploading)),
        JSON.stringify(p.filterValues || {}),
        p.deletedAt || '',
        p._brandName || '',
        p._brandCatId || '',
      ]
    }

    // 카테고리별 시트 (활성 + 삭제 모두)
    for (const cat of categories) {
      const sheetName = catSheetName(cat.id, cat.name)
      await ensureSheet(sheetName)
      const catProducts = allProducts.filter(p => brandCatMap[p.companyId] === cat.id)
      const rows = catProducts.map(productRow)
      await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values/${encodeURIComponent(sheetName)}:clear`, { method: 'POST' })
      const values = [PRODUCT_HEADERS, ...rows]
      await gFetch(
        `${SHEETS_API}/${state.spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=RAW`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
      )
    }

    // 삭제된 카테고리의 시트 제거
    const validSheetNames = new Set([
      ...BASE_SHEETS.map(s => s.name),
      ...categories.map(c => catSheetName(c.id, c.name))
    ])
    const existing = await getExistingSheets()
    const toDelete = existing.filter(name => name.startsWith('products_') && !validSheetNames.has(name))
    if (toDelete.length) {
      const sheetMeta = await gFetch(`${SHEETS_API}/${state.spreadsheetId}?fields=sheets.properties`)
      const { sheets } = await sheetMeta.json()
      const deleteRequests = toDelete.map(name => {
        const s = sheets.find(sh => sh.properties.title === name)
        return s ? { deleteSheet: { sheetId: s.properties.sheetId } } : null
      }).filter(Boolean)
      if (deleteRequests.length) {
        await gFetch(`${SHEETS_API}/${state.spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: deleteRequests })
        })
      }
    }
  }

  // ── readAll (Sheets → D) ──────────────────────────────────────────

  async function readAll() {
    if (!state.spreadsheetId) return null

    // 기본 시트 읽기
    const baseRanges = BASE_SHEETS.map(s => `ranges=${s.name}`).join('&')
    const baseRes = await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values:batchGet?${baseRanges}&majorDimension=ROWS`)
    const { valueRanges: baseVR } = await baseRes.json()
    if (!baseVR) return null

    const byName = {}
    baseVR.forEach((vr, i) => {
      const name = BASE_SHEETS[i].name
      const [headers = [], ...rows] = vr.values || []
      byName[name] = rows.map(r => {
        const o = {}
        headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : '' })
        return o
      })
    })

    const categories = (byName.categories || []).map(r => ({
      id: r.id, name: r.name, icon: r.icon, color: r.color, bg: r.bg
    }))

    // 카테고리별 products 시트 읽기
    const existingSheets = await getExistingSheets()
    const productSheets = categories.filter(c => c.id !== 'all').map(c => catSheetName(c.id, c.name)).filter(name => existingSheets.includes(name))

    let allProducts = []
    if (productSheets.length) {
      const prodRanges = productSheets.map(s => `ranges=${encodeURIComponent(s)}`).join('&')
      const prodRes = await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values:batchGet?${prodRanges}&majorDimension=ROWS`)
      const { valueRanges: prodVR } = await prodRes.json()
      if (prodVR) {
        prodVR.forEach(vr => {
          const [headers = [], ...rows] = vr.values || []
          rows.forEach(r => {
            const o = {}
            headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : '' })
            allProducts.push(o)
          })
        })
      }
    }

    // 구버전 products 시트 호환 (마이그레이션)
    if (!allProducts.length && existingSheets.includes('products')) {
      const oldRes = await gFetch(`${SHEETS_API}/${state.spreadsheetId}/values/products?majorDimension=ROWS`)
      const oldData = await oldRes.json()
      if (oldData.values) {
        const [headers = [], ...rows] = oldData.values
        rows.forEach(r => {
          const o = {}
          headers.forEach((h, idx) => { o[h] = r[idx] !== undefined ? r[idx] : '' })
          allProducts.push(o)
        })
      }
    }

    function parseProduct(r) {
      return {
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
        _brandName: r.brandName || null,
        _brandCatId: r.brandCatId || null,
        isOnSale: false,
      }
    }

    const parsedProducts = allProducts.map(parseProduct)

    return {
      categories,
      companies: (byName.brands || []).map(r => ({ id: r.id, name: r.name, categoryId: r.categoryId })),
      products: parsedProducts.filter(p => !p.deletedAt),
      deletedProducts: parsedProducts.filter(p => !!p.deletedAt),
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
    const mime = blob.type || 'image/jpeg'
    const metadata = { name, parents: [state.driveFolderId], mimeType: mime }
    const boundary = '----resell' + Math.random().toString(16).slice(2)
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--\r\n`
    ], { type: `multipart/related; boundary=${boundary}` })
    const res = await gFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', body })
    return (await res.json()).id
  }

  async function uploadPhoto(file) {
    await ensureWorkspace()
    const ts = Date.now()
    const thumb = await resizeToBlob(file, 200, 0.7)
    const [fileId, thumbFileId] = await Promise.all([
      driveUploadBlob(file, `photo-${ts}.jpg`),
      driveUploadBlob(thumb.blob, `thumb-${ts}.jpg`),
    ])
    photoUrlCache.set(thumbFileId, URL.createObjectURL(thumb.blob))
    return { fileId, thumbFileId, width: 0, height: 0 }
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
