const { test } = require('node:test')
const assert = require('node:assert')
const { buildAppInfo, restartApp } = require('./app-info.js')

test('buildAppInfo：git 可用时用短 hash，并带启动时刻', () => {
  const info = buildAppInfo({
    execSync: () => Buffer.from('abc1234\n'),
    dirname: '/x',
    version: '1.1.0',
    startedAt: new Date(2026, 7, 19, 9, 5).getTime(),
  })
  assert.strictEqual(info.hash, 'abc1234')
  assert.strictEqual(info.startedAt, '08-19 09:05')
})

test('buildAppInfo：git 不可用（打包后）退回 package.json 版本号', () => {
  const info = buildAppInfo({
    execSync: () => { throw new Error('no git') },
    dirname: '/x',
    version: '1.1.0',
    startedAt: Date.now(),
  })
  assert.strictEqual(info.hash, 'v1.1.0')
})

test('restartApp：先 relaunch 后 exit(0)，顺序与参数都要对', () => {
  const calls = []
  restartApp({
    relaunch: () => calls.push('relaunch'),
    exit: code => calls.push(`exit(${code})`),
  })
  assert.deepStrictEqual(calls, ['relaunch', 'exit(0)'])
})
