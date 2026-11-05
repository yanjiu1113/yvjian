/* DG-LAB Socket 客户端（V2 兼容，带完整日志）
 *
 * 背景：DG-LAB App 连主机，然后开一个 WebSocket 服务（默认 9999），
 * 第三方通过 ws://<地址>:<端口> 连上去，用 JSON 收发指令。
 *
 * 协议（社区整理的 V2）：
 *   连接后先绑定：{"type":"bind","clientId":"<id>","targetId":"","message":"dungeonlab"}
 *   心跳：{"type":"heartbeat","clientId":"<id>","targetId":"<tid>","message":"200"}
 *   控制：{"type":"client_msg","clientId":"<id>","targetId":"<tid>","message":"strength-1+10"}
 *     strength-1 / strength-2 表示通道，+10 / -10 表示增减，clear-1 清零
 *
 * App 版本不同字段可能不一样，所以这里把所有收发都打到日志里，先观察再适配。
 */
(function () {
  'use strict';

  var S = {
    ws: null,
    url: '',
    clientId: '',
    targetId: '',
    bound: false,
    heartbeat: 0,
    onLog: null,
    onState: null
  };

  function log(s) {
    if (S.onLog) S.onLog(s);
  }

  function send(obj) {
    if (!S.ws || S.ws.readyState !== 1) return false;
    var text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    try {
      S.ws.send(text);
      log('→ ' + text);
      return true;
    } catch (e) {
      log('发送失败：' + e.message);
      return false;
    }
  }

  function pushState() {
    if (S.onState) {
      S.onState({
        url: S.url,
        clientId: S.clientId,
        targetId: S.targetId,
        bound: S.bound,
        open: !!(S.ws && S.ws.readyState === 1)
      });
    }
  }

  function connect(url, clientId) {
    disconnect();
    S.url = url;
    S.clientId = clientId || '';
    S.targetId = '';
    S.bound = false;

    log('连接 ' + url + ' …');
    try {
      S.ws = new WebSocket(url);
    } catch (e) {
      log('创建 WebSocket 失败：' + e.message);
      return;
    }

    S.ws.onopen = function () {
      log('已连接，开始绑定');
      send({ type: 'bind', clientId: S.clientId, targetId: '', message: 'dungeonlab' });
      startHeartbeat();
      pushState();
    };

    S.ws.onmessage = function (ev) {
      var text = typeof ev.data === 'string' ? ev.data : '[二进制]';
      log('← ' + text);
      try {
        var o = JSON.parse(text);
        if (o.targetId) S.targetId = o.targetId;
        if (o.type === 'bind') {
          S.bound = (o.message === '200' || o.message === 200);
          log(S.bound ? '绑定成功 targetId=' + S.targetId : ('绑定返回：' + o.message));
        }
        pushState();
      } catch (e) {
        // 非 JSON，忽略
      }
    };

    S.ws.onerror = function () {
      log('连接出错（地址不对、或 App 没开 SOCKET）');
      pushState();
    };

    S.ws.onclose = function (ev) {
      log('连接关闭 code=' + ev.code);
      stopHeartbeat();
      S.bound = false;
      pushState();
    };
  }

  function disconnect() {
    stopHeartbeat();
    if (S.ws) {
      try { S.ws.close(); } catch (e) { }
      S.ws = null;
    }
    S.bound = false;
    pushState();
  }

  function startHeartbeat() {
    stopHeartbeat();
    S.heartbeat = setInterval(function () {
      send({ type: 'heartbeat', clientId: S.clientId, targetId: S.targetId, message: '200' });
    }, 10000);
  }

  function stopHeartbeat() {
    if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = 0; }
  }

  /** 通道强度调整：delta 正负均可 */
  function strength(channel, delta) {
    var ch = channel === 2 ? 'strength-2' : 'strength-1';
    var msg = ch + (delta >= 0 ? '+' : '') + Math.round(delta);
    return send({ type: 'client_msg', clientId: S.clientId, targetId: S.targetId, message: msg });
  }

  function clear(channel) {
    var ch = channel === 2 ? 'clear-2' : 'clear-1';
    return send({ type: 'client_msg', clientId: S.clientId, targetId: S.targetId, message: ch });
  }

  function isOpen() {
    return !!(S.ws && S.ws.readyState === 1);
  }

  window.DgSock = {
    connect: connect,
    disconnect: disconnect,
    strength: strength,
    clear: clear,
    isOpen: isOpen,
    state: function () {
      return { url: S.url, clientId: S.clientId, targetId: S.targetId, bound: S.bound, open: isOpen() };
    },
    setLog: function (fn) { S.onLog = fn; },
    setStateHandler: function (fn) { S.onState = fn; }
  };
})();
