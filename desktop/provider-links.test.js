'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isAllowedProviderLink } = require('./provider-links.js')

test('only fixed official API key pages may leave the desktop app', () => {
  assert.equal(isAllowedProviderLink('https://platform.openai.com/api-keys'), true)
  assert.equal(isAllowedProviderLink('https://evil.example/?next=https://platform.openai.com/api-keys'), false)
  assert.equal(isAllowedProviderLink('http://platform.openai.com/api-keys'), false)
})
