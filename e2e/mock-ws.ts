/**
 * The scriptable browser-side mock used by the credential-free e2e specs.
 *
 * Installed with `page.addInitScript(MOCK_WS)` BEFORE any widget code runs, it
 * replaces `window.WebSocket` and `window.fetch` so a spec can drive the REAL
 * built bundle in a real browser with no network, no gateway key and no operator.
 *
 *   window.__sent    — every outbound WS frame, in order
 *   window.__script  — (frame, reply) => void: the spec's operator impersonation
 *   window.__http    — every fetch the widget made (chat-ws `/internal/*` routes)
 *   window.__httpScript — (path, body) => { status?, json } (default resume:false)
 *
 * Lifted verbatim from e2e/identity-persistence-mock.spec.ts so a new spec gets
 * the same harness instead of a second one.
 */
export const MOCK_WS = `
(() => {
  window.__sent = [];
  window.__http = [];
  class MockWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      this._l = { open: [], message: [], close: [], error: [] };
      setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 3);
    }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i>=0) a.splice(i,1); } }
    _emit(t, ev) { for (const fn of (this._l[t]||[]).slice()) fn(ev); }
    _msg(o) { this._emit('message', { data: JSON.stringify(o) }); }
    send(raw) {
      let f; try { f = JSON.parse(raw); } catch { return; }
      window.__sent.push(f);
      (window.__script || (()=>{}))(f, (o) => this._msg(o));
    }
    close() { this.readyState = 3; this._emit('close', { code: 1000, reason: '' }); }
  }
  MockWS.CONNECTING=0; MockWS.OPEN=1; MockWS.CLOSING=2; MockWS.CLOSED=3;
  window.WebSocket = MockWS;

  window.fetch = async (url, init) => {
    const u = new URL(url, location.href);
    const body = init && init.body ? JSON.parse(init.body) : {};
    window.__http.push({ path: u.pathname, body, origin: u.origin, credentials: init && init.credentials });
    const route = (window.__httpScript || (() => ({ json: { resumable: false } })));
    const { status = 200, json = {} } = route(u.pathname, body) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
})();
`;
