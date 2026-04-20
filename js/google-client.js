// resell/js/google-client.js
// Google OAuth + Sheets + Drive 연동 일체
(() => {
  'use strict'

  const CLIENT_ID = '1005021855988-25j0ujhc2h7c72dt25av574ntcoavfhn.apps.googleusercontent.com'
  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ].join(' ')

  const state = {
    tokenClient: null,
    accessToken: null,
    tokenExpiresAt: 0,   // epoch ms
    email: null,
    spreadsheetId: null,
    driveFolderId: null,
  }

  window.G = { state, init, login, logout, isLoggedIn }

  function isLoggedIn() {
    return !!state.accessToken && Date.now() < state.tokenExpiresAt
  }

  function init() {
    if (!window.google?.accounts?.oauth2) {
      console.warn('[G] GIS not loaded yet')
      return
    }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) {
          console.error('[G] token error', resp)
          return
        }
        state.accessToken = resp.access_token
        state.tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000
        sessionStorage.setItem('resell_access_token', resp.access_token)
        sessionStorage.setItem('resell_token_expires', String(state.tokenExpiresAt))
        state.spreadsheetId = localStorage.getItem('resell_spreadsheet_id')
        state.driveFolderId = localStorage.getItem('resell_drive_folder_id')
        document.dispatchEvent(new CustomEvent('g:login'))
      }
    })
    // 세션 내 캐시 복원
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

  function login() {
    if (!state.tokenClient) init()
    state.tokenClient.requestAccessToken({ prompt: state.accessToken ? '' : 'consent' })
  }

  function logout() {
    if (state.accessToken) google.accounts.oauth2.revoke(state.accessToken, () => {})
    state.accessToken = null
    state.tokenExpiresAt = 0
    sessionStorage.removeItem('resell_access_token')
    sessionStorage.removeItem('resell_token_expires')
    document.dispatchEvent(new CustomEvent('g:logout'))
  }
})()
