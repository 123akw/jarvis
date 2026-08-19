const { test } = require('node:test')
const assert = require('node:assert')
const { applyBallPhase, ballPhaseClass } = require('./voice-ball.js')

function fakeClassList(initial = []) {
  const set = new Set(initial)
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    has: c => set.has(c),
    all: () => [...set].sort(),
  }
}

test('三个通话态各有专属类，其余状态一律回空', () => {
  assert.strictEqual(ballPhaseClass('listening'), 'voice-listening')
  assert.strictEqual(ballPhaseClass('thinking'), 'voice-thinking')
  assert.strictEqual(ballPhaseClass('speaking'), 'voice-speaking')
  for (const p of ['connecting', 'closed', '', undefined, 'weird']) {
    assert.strictEqual(ballPhaseClass(p), '')
  }
})

test('applyBallPhase：换态先清旧类，任何时刻至多一个通话态类', () => {
  const cl = fakeClassList(['expanded'])
  applyBallPhase(cl, 'listening')
  assert.deepStrictEqual(cl.all(), ['expanded', 'voice-listening'])
  applyBallPhase(cl, 'speaking')
  assert.deepStrictEqual(cl.all(), ['expanded', 'voice-speaking'])
})

test('applyBallPhase：挂断/关闭清光通话态，不碰无关类', () => {
  const cl = fakeClassList(['expanded', 'voice-thinking'])
  applyBallPhase(cl, 'closed')
  assert.deepStrictEqual(cl.all(), ['expanded'])
})
