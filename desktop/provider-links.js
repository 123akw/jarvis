'use strict'

const PROVIDER_LINKS = new Set([
  'https://platform.openai.com/api-keys',
  'https://platform.deepseek.com/api_keys',
  'https://help.aliyun.com/zh/model-studio/get-api-key',
  'https://cloud.siliconflow.cn/account/ak',
])

function isAllowedProviderLink(value) {
  return typeof value === 'string' && PROVIDER_LINKS.has(value)
}

module.exports = { isAllowedProviderLink }
