/* 会议纪要采集会话（纯逻辑状态机，无 DOM、无 Electron）。
 * 协议以 jarvis/voice/meeting_gateway.py 为准：双路音频帧加 1 字节声道头上行
 * （0x00=麦克风「我」/ 0x01=系统回环「对方」），下行实时字幕/定稿转写，
 * stop 后依次收 stopped → minutes → mail。依赖全部注入，node --test 可直跑。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSMeeting = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  const WS_OPEN = 1
  const CHANNEL_ME = 0
  const CHANNEL_OTHERS = 1

  const MESSAGES = {
    connectFailed: '无法连接会议纪要服务，请检查网络后重试',
    busy: '已有一场会议在监控中（可能是网页端或另一台设备发起的）',
    dead: '会议纪要连接断开，已停止采集；已录内容服务端会照常整理成纪要并发邮件',
    noSystemAudio: '没拿到系统声音，可能录不到对方的发言（只记录你自己的麦克风）。允许「屏幕录制/系统音频」权限后重开会议监控可恢复。',
    empty: '这场会议没有捕捉到任何发言，未生成纪要',
  }

  /**
   * 一场会议采集。返回 { start, stop, feedMic, feedSystem, state }。
   * on 回调：phase / caption({speaker,text,final,ts}) / segments(count) /
   *          notice / minutes({text,message}) / mail({ok,to,message}) / expired。
   */
  function createMeetingSession({ url, title = '', createWebSocket, on = {} }) {
    const st = {
      phase: 'connecting',   // connecting|recording|summarizing|done|error|closed
      segments: 0, meetingId: '', notice: '', alive: true, stopped: false,
      startedAt: 0, minutes: null,
    }
    let ws = null
    const emit = (name, payload) => { if (on[name]) on[name](payload) }
    function setPhase(p) { if (st.phase !== p) { st.phase = p; emit('phase', p) } }
    function setNotice(m) { st.notice = m; emit('notice', m) }

    function sendFrame(channel, buf) {
      if (!st.alive || st.stopped || !ws || ws.readyState !== WS_OPEN) return
      const framed = new Uint8Array(1 + buf.byteLength)
      framed[0] = channel
      framed.set(new Uint8Array(buf), 1)
      ws.send(framed.buffer)
    }

    function handleEvent(ev) {
      if (!ev || typeof ev !== 'object') return
      if (ev.type === 'ready') {
        st.meetingId = ev.meeting_id || ''
        st.startedAt = Date.now()
        setPhase('recording')
      } else if (ev.type === 'partial') {
        emit('caption', { speaker: ev.speaker || '', text: ev.text || '', final: false })
      } else if (ev.type === 'segment') {
        st.segments += 1
        emit('caption', { speaker: ev.speaker || '', text: ev.text || '', final: true, ts: ev.ts })
        emit('segments', st.segments)
      } else if (ev.type === 'live_points') {
        emit('livePoints', ev.text || '')
      } else if (ev.type === 'asr_unavailable') {
        setNotice(ev.message || '服务端语音识别不可用，会议无法转写')
        stop()   // 转不出字继续录也没意义
      } else if (ev.type === 'stopped') {
        if (ev.empty) {
          setNotice(MESSAGES.empty)
          setPhase('done')
        } else {
          setPhase('summarizing')
        }
      } else if (ev.type === 'minutes') {
        st.minutes = { text: ev.text || '', message: ev.message || '' }
        setPhase('done')
        emit('minutes', st.minutes)
      } else if (ev.type === 'mail') {
        emit('mail', { ok: !!ev.ok, to: ev.to || '', message: ev.message || '' })
      } else if (ev.type === 'error') {
        if (ev.code === 'unauthorized' || ev.code === 'csrf') {
          st.alive = false
          emit('expired')
          return
        }
        if (ev.code === 'busy') {
          st.alive = false
          setNotice(MESSAGES.busy)
          setPhase('error')
          return
        }
        setNotice(ev.message || '会议纪要链路出错')
      }
    }

    function start() {
      let socket
      try {
        socket = createWebSocket(url)
      } catch {
        setPhase('error')
        setNotice(MESSAGES.connectFailed)
        return
      }
      try { socket.binaryType = 'arraybuffer' } catch { /* fake 可不支持 */ }
      ws = socket
      socket.onopen = () => {
        if (ws === socket) socket.send(JSON.stringify({ type: 'init', title }))
      }
      socket.onmessage = e => {
        if (!st.alive || ws !== socket) return
        if (typeof e.data !== 'string') return   // 会议下行没有二进制帧
        let ev
        try { ev = JSON.parse(e.data) } catch { return }
        handleEvent(ev)
      }
      socket.onclose = () => {
        if (ws !== socket) return
        if (st.phase === 'done' || !st.alive) { setPhase('closed'); return }
        // 纪要还没送达就断线：采集停止，但服务端会照常总结+发邮件
        st.alive = false
        setNotice(MESSAGES.dead)
        setPhase('error')
      }
      socket.onerror = () => {
        if (st.alive && ws === socket && st.phase === 'connecting') {
          setNotice(MESSAGES.connectFailed)
        }
      }
    }

    /** 结束采集：连接保持到 minutes/mail 送达（服务端总结要几十秒）。 */
    function stop() {
      if (!st.alive || st.stopped) return
      st.stopped = true
      if (ws && ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }))
        setPhase('summarizing')
      } else {
        // 连接还没建立就喊停：必须整个收摊。只标记不关 socket 的话，onopen 仍会
        // 发 init 把服务端会议开起来，ready 回来还会把「已关闭」的面板复活成录制中。
        dispose()
      }
    }

    /** 彻底收摊（面板关闭时调用）：不再等服务端回帧。 */
    function dispose() {
      st.alive = false
      const socket = ws
      ws = null
      if (socket) { try { socket.close() } catch { /* 已关 */ } }
      if (st.phase !== 'done') setPhase('closed')
    }

    return {
      start,
      stop,
      dispose,
      feedMic: buf => sendFrame(CHANNEL_ME, buf),
      feedSystem: buf => sendFrame(CHANNEL_OTHERS, buf),
      state: () => ({ ...st }),
    }
  }

  return { createMeetingSession, MESSAGES, CHANNEL_ME, CHANNEL_OTHERS }
})
