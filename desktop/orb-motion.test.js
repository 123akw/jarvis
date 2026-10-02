const assert = require('node:assert/strict')
const { test } = require('node:test')
const { rmsToLevel, smoothLevel, speakingFrame, createOrbMotion } = require('./orb-motion.js')
const { createPcmPlayer, envelopeOf, ENVELOPE_STEP } = require('./voice-audio.js')

function el() { return { style: {} } }
function frames() {
  const queue = []
  return {
    raf: cb => { queue.push(cb); return queue.length },
    caf: id => { queue[id - 1] = null },
    pending: () => queue.filter(Boolean).length,
    run(now) { const cbs = queue.splice(0); cbs.forEach(cb => cb && cb(now)) },
  }
}

test('rmsToLevel：底噪归零、满幅封顶、轻声也看得见', () => {
  assert.equal(rmsToLevel(0), 0)
  assert.equal(rmsToLevel(0.01), 0)
  assert.equal(rmsToLevel(1), 1)
  assert.equal(rmsToLevel(Number.NaN), 0)
  const soft = rmsToLevel(0.04)
  assert.ok(soft > 0.3 && soft < 0.5, `轻声经开方压缩应在 0.3~0.5，实际 ${soft}`)
})

test('smoothLevel：起音比释放快，dt 异常不出 NaN', () => {
  const up = smoothLevel(0, 1, 0.05)
  const down = 1 - smoothLevel(1, 0, 0.05)
  assert.ok(up > down, `起音 ${up} 应快于释放 ${down}`)
  assert.equal(smoothLevel(0.4, 1, Number.NaN), 0.4)
  assert.equal(smoothLevel(0.4, 1, -1), 0.4)
})

test('speakingFrame：音量 0 时回到常态尺寸，满音量放大 14%', () => {
  assert.deepEqual(speakingFrame(0), { scale: 1, haloOpacity: 0.62, haloScale: 0.94 })
  const loud = speakingFrame(5)
  assert.ok(Math.abs(loud.scale - 1.14) < 1e-9)
  assert.equal(loud.haloOpacity, 1)
})

test('只有 speaking 才跑帧：听/想/空闲零 JS，离开说话态复位内联样式', () => {
  const f = frames()
  const target = { body: el(), halo: el() }
  let rms = 0.2
  const motion = createOrbMotion({ targets: () => [target], getRms: () => rms, raf: f.raf, caf: f.caf })
  for (const p of ['listening', 'thinking', 'connecting', 'closed', '']) {
    motion.setPhase(p)
    assert.equal(f.pending(), 0, `${p || '空闲'} 不该排帧`)
  }
  motion.setPhase('speaking')
  assert.equal(f.pending(), 1)
  motion.setPhase('speaking')
  assert.equal(f.pending(), 1, '重复进入说话态不重复排帧')
  for (let i = 1; i <= 30; i++) f.run(i * 16)
  assert.match(target.body.style.transform, /^scale\(1\.\d+\)$/)
  assert.ok(Number(target.halo.style.opacity) > 0.62, '有声音时光晕变亮')
  rms = 0
  for (let i = 31; i <= 200; i++) f.run(i * 16)
  assert.ok(motion.level() < 0.01, '静音后包络回落')
  motion.setPhase('listening')
  assert.equal(f.pending(), 0, '离开说话态立即停帧')
  assert.equal(target.body.style.transform, '')
  assert.equal(target.halo.style.opacity, '')
  assert.equal(target.halo.style.transform, '')
})

test('减少动态效果：说话态也不启动律动', () => {
  const f = frames()
  const target = { body: el(), halo: el() }
  const motion = createOrbMotion({ targets: () => [target], getRms: () => 0.3, raf: f.raf, caf: f.caf,
    reducedMotion: () => true })
  motion.setPhase('speaking')
  assert.equal(f.pending(), 0)
  assert.equal(motion.running(), false)
  assert.equal(target.body.style.transform, '')
})

test('取音量抛错 / 目标缺失都不打断帧循环', () => {
  const f = frames()
  const motion = createOrbMotion({ targets: () => [null, { body: el() }], getRms: () => { throw new Error('x') },
    raf: f.raf, caf: f.caf })
  motion.setPhase('speaking')
  f.run(16)
  assert.equal(f.pending(), 1)
  motion.stop()
  assert.equal(f.pending(), 0)
})

function fakeContext() {
  const ctx = {
    state: 'running', currentTime: 0, destination: {},
    createBuffer(_ch, len, rate) {
      const data = new Float32Array(len)
      return { duration: len / rate, getChannelData: () => data }
    },
    createBufferSource() { return { connect() {}, start() {}, stop() {} } },
  }
  return ctx
}

test('envelopeOf：按 50ms 窗算 RMS，尾窗不足也算', () => {
  const rate = 1000
  const f32 = new Float32Array(120)
  f32.fill(0.5, 0, 50)
  const env = envelopeOf(f32, rate)
  assert.equal(env.length, 3)
  assert.ok(Math.abs(env[0] - 0.5) < 1e-6)
  assert.equal(env[1], 0)
  assert.equal(env[2], 0)
})

test('播放器 level()：随播放时间取当前窗的音量，播完 / stop 归零，不改音频图', () => {
  const ctx = fakeContext()
  const player = createPcmPlayer({ createContext: () => ctx })
  assert.equal(player.level(), 0, '还没建上下文时为 0')
  player.start(1000)
  const pcm = new Int16Array(100)   // 0.1 秒：前 50ms 响、后 50ms 静
  pcm.fill(16384, 0, 50)
  player.enqueue(pcm.buffer)
  assert.equal(player.level(), 0, '起播前（0.02s 预留）为 0')
  ctx.currentTime = 0.02 + ENVELOPE_STEP / 2
  assert.ok(Math.abs(player.level() - 0.5) < 1e-3)
  ctx.currentTime = 0.02 + ENVELOPE_STEP * 1.5
  assert.equal(player.level(), 0)
  ctx.currentTime = 1
  assert.equal(player.level(), 0, '播完归零')
  player.enqueue(pcm.buffer)
  ctx.currentTime = 1.02 + 0.01
  assert.ok(player.level() > 0.4)
  player.stop()
  assert.equal(player.level(), 0, 'stop 清掉包络')
})
