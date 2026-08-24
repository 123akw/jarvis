const { test } = require('node:test')
const assert = require('node:assert')
const { createWakeWordListener, encodeWav, bufferToBase64 } = require('./wake-word.js')

function frame(rms, fill = 1) {
  const pcm = new Int16Array(4).fill(fill)
  return { pcm: pcm.buffer, rms }
}

function tick(times = 1) {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise(resolve => setImmediate(resolve)))
  return p
}

test('人声段落结束才送检一次，命中唤醒词回调 onWake', async () => {
  const submitted = []
  const wakes = []
  let now = 0
  const listener = createWakeWordListener({
    recognize: async wav => { submitted.push(wav); return { matched: true, text: '贾维斯' } },
    onWake: text => wakes.push(text),
    now: () => now,
  })
  listener.feed(frame(0.01))                       // 静音：不触发
  listener.feed(frame(0.1)); listener.feed(frame(0.1))  // 连续人声进入采集
  listener.feed(frame(0.1))
  for (let i = 0; i < 6; i++) listener.feed(frame(0.0))  // 600ms 静音判定说完
  await tick(3)
  assert.strictEqual(submitted.length, 1, '一段话只送检一次')
  assert.deepStrictEqual(wakes, ['贾维斯'])
  // 送检的 WAV 包含前置缓冲（触发前的帧不丢，「贾」字不被吃）
  const view = new DataView(submitted[0])
  assert.strictEqual(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF')
  const dataLen = view.getUint32(40, true)
  assert.ok(dataLen >= 9 * 8, `采集段至少包含预滚+人声+静音帧，实际 ${dataLen} 字节`)
})

test('太短的人声当噪声丢弃，不送检', async () => {
  const submitted = []
  const listener = createWakeWordListener({
    recognize: async wav => { submitted.push(wav); return { matched: false } },
    minVoicedFrames: 3, now: () => 0,
  })
  listener.feed(frame(0.1)); listener.feed(frame(0.1))   // 只有 2 帧人声（约 200ms）
  for (let i = 0; i < 6; i++) listener.feed(frame(0.0))
  await tick(2)
  assert.strictEqual(submitted.length, 0)
})

test('冷却窗口内不重复送检；未命中不回调', async () => {
  const submitted = []
  const wakes = []
  let now = 0
  const listener = createWakeWordListener({
    recognize: async () => ({ matched: false, text: '今天天气不错' }),
    onWake: t => wakes.push(t),
    cooldownMs: 4000,
    now: () => now,
  })
  const speak = () => {
    listener.feed(frame(0.1)); listener.feed(frame(0.1)); listener.feed(frame(0.1))
    for (let i = 0; i < 6; i++) listener.feed(frame(0.0))
  }
  const counting = createWakeWordListener({
    recognize: async wav => { submitted.push(wav); return { matched: false } },
    cooldownMs: 4000, now: () => now,
  })
  const speak2 = () => {
    counting.feed(frame(0.1)); counting.feed(frame(0.1)); counting.feed(frame(0.1))
    for (let i = 0; i < 6; i++) counting.feed(frame(0.0))
  }
  speak2(); await tick(2)
  speak2(); await tick(2)                 // 冷却中：这段被忽略
  assert.strictEqual(submitted.length, 1)
  now = 10_000
  speak2(); await tick(2)                 // 冷却过了：可再送
  assert.strictEqual(submitted.length, 2)
  speak(); await tick(2)
  assert.deepStrictEqual(wakes, [], '未命中不得唤醒')
})

test('超长说话强制截断送检，识别抛错走 onError 不炸', async () => {
  const errors = []
  let submits = 0
  const listener = createWakeWordListener({
    recognize: async () => { submits += 1; throw new Error('network down') },
    onError: e => errors.push(e.message),
    maxFrames: 5, now: () => 0,
  })
  for (let i = 0; i < 10; i++) listener.feed(frame(0.1))  // 一直说不停
  await tick(2)
  assert.strictEqual(submits, 1, '到 maxFrames 强制收段')
  assert.deepStrictEqual(errors, ['network down'])
})

test('encodeWav 产出合法 16k/16bit/单声道头；bufferToBase64 可逆', () => {
  const pcm = new Int16Array([1, -1, 32767, -32768])
  const wav = encodeWav([pcm.buffer])
  const view = new DataView(wav)
  assert.strictEqual(view.getUint32(24, true), 16000)   // 采样率
  assert.strictEqual(view.getUint16(22, true), 1)       // 单声道
  assert.strictEqual(view.getUint16(34, true), 16)      // 位深
  assert.strictEqual(view.getUint32(40, true), 8)       // data 字节数
  const b64 = bufferToBase64(wav)
  assert.deepStrictEqual(new Uint8Array(Buffer.from(b64, 'base64')), new Uint8Array(wav))
})
